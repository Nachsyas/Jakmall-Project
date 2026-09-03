import type { PrismaClient, SyncJob } from "@prisma/client";
import type { SyncExecutionQueue } from "../queue/sync-queue.js";
import { generateQueueJobId } from "../queue/sync-queue.js";
import { assertSyncJobTransition } from "../sync/state-machine.js";
import { sanitizeErrorMessage } from "../queue/error-sanitizer.js";
import { resolveRuntimeConfig, validateRuntimeConfig, validateBatchSize } from "./config.js";
import {
  normalizeBullMQJobState,
  type RuntimeConfig,
  type RuntimeClock,
  type RecoveryBatchResult,
  type RecoveryItemResult,
  type RecoveryServiceOptions,
} from "./types.js";

export class StaleProcessingRecoveryService {
  private readonly config: RuntimeConfig;
  private readonly clock: RuntimeClock;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncQueue: SyncExecutionQueue,
    options?: {
      config?: RuntimeConfig | undefined;
      clock?: RuntimeClock | undefined;
    } | undefined
  ) {
    this.config = options?.config !== undefined ? validateRuntimeConfig(options.config) : resolveRuntimeConfig();
    this.clock = options?.clock ?? (() => new Date());
  }

  async recoverStaleJobs(options?: RecoveryServiceOptions): Promise<RecoveryBatchResult> {
    // Compute immutable cutoff once per batch
    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.config.staleProcessingMs);
    const batchSize = validateBatchSize(options?.batchSize, this.config.batchSize);

    // Query stale PROCESSING candidates
    const candidates = await this.prisma.syncJob.findMany({
      where: {
        status: "PROCESSING",
        updatedAt: { lte: cutoff },
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
    });

    const items: RecoveryItemResult[] = [];
    let recoveredCount = 0;
    let skippedActiveCount = 0;
    let needsReviewCount = 0;
    let concurrentSkipCount = 0;

    for (const candidate of candidates) {
      try {
        const itemResult = await this.processCandidate(candidate, cutoff);
        items.push(itemResult);

        switch (itemResult.outcome) {
          case "RECOVERED":
            recoveredCount++;
            break;
          case "SKIPPED_ACTIVE":
            skippedActiveCount++;
            break;
          case "NEEDS_REVIEW":
            needsReviewCount++;
            break;
          case "CONCURRENT_SKIP":
            concurrentSkipCount++;
            break;
        }
      } catch (err: unknown) {
        const errorMessage = sanitizeErrorMessage(err);
        items.push({
          syncJobId: candidate.id,
          outcome: "ERROR",
          error: errorMessage,
        });
      }
    }

    return {
      candidatesExamined: candidates.length,
      recoveredCount,
      skippedActiveCount,
      needsReviewCount,
      concurrentSkipCount,
      items,
    };
  }

  private async processCandidate(
    candidate: SyncJob,
    cutoff: Date
  ): Promise<RecoveryItemResult> {
    // Derive deterministic queue job ID
    const queueJobId = generateQueueJobId(candidate.idempotencyKey);
    const bullJob = await this.syncQueue.getJob(queueJobId);

    let rawState: string | null = null;
    if (bullJob) {
      rawState = await bullJob.getState();
    }
    const normalizedState = normalizeBullMQJobState(rawState);

    // Policy Rule 1: ACTIVE -> Do not recover, worker may still own it
    if (normalizedState === "active") {
      return {
        syncJobId: candidate.id,
        outcome: "SKIPPED_ACTIVE",
        queueState: "active",
      };
    }

    // Policy Rule 2: COMPLETED or WAITING-CHILDREN or UNKNOWN -> Inconsistent state, fail closed to NEEDS_REVIEW
    if (
      normalizedState === "completed" ||
      normalizedState === "waiting-children" ||
      (bullJob !== null && bullJob !== undefined && normalizedState === "unknown")
    ) {
      const queueStateLabel = normalizedState;
      const result = await this.prisma.$transaction(async (tx) => {
        assertSyncJobTransition("PROCESSING", "NEEDS_REVIEW");

        const updateRes = await tx.syncJob.updateMany({
          where: {
            id: candidate.id,
            status: "PROCESSING",
            updatedAt: { lte: cutoff },
          },
          data: {
            status: "NEEDS_REVIEW",
            lastErrorCode: "QUEUE_STATE_CONFLICT",
            lastErrorMessage: `BullMQ job state '${queueStateLabel}' conflicts with PROCESSING state. Operator review required.`,
          },
        });

        if (updateRes.count !== 1) {
          return { outcome: "CONCURRENT_SKIP" as const };
        }

        await tx.auditLog.create({
          data: {
            actorType: "SYSTEM",
            actorId: "phase4c4-runtime-maintenance",
            action: "QUEUE_STATE_CONFLICT_NEEDS_REVIEW",
            entityType: "SyncJob",
            entityId: candidate.id,
            before: {
              status: "PROCESSING",
              updatedAt: candidate.updatedAt.toISOString(),
            },
            after: {
              status: "NEEDS_REVIEW",
              lastErrorCode: "QUEUE_STATE_CONFLICT",
            },
            metadata: {
              reason: `Queue state '${queueStateLabel}' requires human review`,
              queueState: queueStateLabel,
            },
          },
        });

        return { outcome: "NEEDS_REVIEW" as const };
      });

      return {
        syncJobId: candidate.id,
        outcome: result.outcome,
        queueState: queueStateLabel,
      };
    }

    // Policy Rule 3: MISSING QUEUE JOB (null) or WAITING / DELAYED / PRIORITIZED / FAILED
    // Execution is not actively owned. Conditionally recover PROCESSING -> FAILED -> PENDING
    const queueStateLabel = bullJob ? normalizedState : "missing";

    const result = await this.prisma.$transaction(async (tx) => {
      // Step 1: Conditional update PROCESSING -> FAILED
      assertSyncJobTransition("PROCESSING", "FAILED");

      const updateRes = await tx.syncJob.updateMany({
        where: {
          id: candidate.id,
          status: "PROCESSING",
          updatedAt: { lte: cutoff },
        },
        data: {
          status: "FAILED",
          lastErrorCode: "STALE_PROCESSING_RECOVERED",
          lastErrorMessage: "Stale PROCESSING job recovered under runtime recovery policy after no active BullMQ ownership was observed.",
        },
      });

      if (updateRes.count !== 1) {
        return { outcome: "CONCURRENT_SKIP" as const };
      }

      // Step 2: Transition FAILED -> PENDING (attemptCount preserved)
      assertSyncJobTransition("FAILED", "PENDING");

      await tx.syncJob.update({
        where: { id: candidate.id },
        data: {
          status: "PENDING",
        },
      });

      // Step 3: Emit SYNC_FAILED recovery event
      await tx.syncEvent.create({
        data: {
          syncJobId: candidate.id,
          productSourceId: candidate.productSourceId,
          marketplaceListingId: candidate.marketplaceListingId,
          sourceSnapshotId: candidate.sourceSnapshotId,
          eventType: "SYNC_FAILED",
          payload: {
            errorCode: "STALE_PROCESSING_RECOVERED",
            recovery: true,
            queueState: queueStateLabel,
          },
        },
      });

      // Step 4: Write SYSTEM AuditLog
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          actorId: "phase4c4-runtime-maintenance",
          action: "RECOVER_STALE_SYNC_JOB",
          entityType: "SyncJob",
          entityId: candidate.id,
          before: {
            status: "PROCESSING",
            updatedAt: candidate.updatedAt.toISOString(),
          },
          after: {
            status: "PENDING",
            lastErrorCode: "STALE_PROCESSING_RECOVERED",
          },
          metadata: {
            reason: "Stale processing job recovered",
            queueState: queueStateLabel,
          },
        },
      });

      return { outcome: "RECOVERED" as const };
    });

    return {
      syncJobId: candidate.id,
      outcome: result.outcome,
      queueState: queueStateLabel,
    };
  }
}
