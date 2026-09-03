import type { PrismaClient, SyncJob } from "@prisma/client";
import type { SyncExecutionQueue } from "../queue/sync-queue.js";
import { generateQueueJobId } from "../queue/sync-queue.js";
import { assertSyncJobTransition } from "../sync/state-machine.js";
import { sanitizeErrorMessage } from "../queue/error-sanitizer.js";
import { resolveRuntimeConfig, validateRuntimeConfig, validateBatchSize } from "./config.js";
import {
  normalizeBullMQJobState,
  type RuntimeConfig,
  type SchedulerBatchResult,
  type DispatchItemResult,
  type SchedulerServiceOptions,
} from "./types.js";

export class DurableDispatchScheduler {
  private readonly config: RuntimeConfig;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncQueue: SyncExecutionQueue,
    options?: {
      config?: RuntimeConfig | undefined;
    } | undefined
  ) {
    this.config = options?.config !== undefined ? validateRuntimeConfig(options.config) : resolveRuntimeConfig();
  }

  async dispatchPendingJobs(options?: SchedulerServiceOptions): Promise<SchedulerBatchResult> {
    const batchSize = validateBatchSize(options?.batchSize, this.config.batchSize);

    // 1. Query PENDING SyncJobs in deterministic order: createdAt ASC, id ASC
    const pendingJobs = await this.prisma.syncJob.findMany({
      where: {
        status: "PENDING",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });

    const items: DispatchItemResult[] = [];
    let dispatchedCount = 0;
    let alreadyQueuedCount = 0;
    let retriedCount = 0;
    let conflictNeedsReviewCount = 0;

    for (const job of pendingJobs) {
      try {
        const itemResult = await this.dispatchJob(job);
        items.push(itemResult);

        switch (itemResult.outcome) {
          case "DISPATCHED":
            dispatchedCount++;
            break;
          case "ALREADY_QUEUED":
            alreadyQueuedCount++;
            break;
          case "RETRIED":
            retriedCount++;
            break;
          case "CONFLICT_NEEDS_REVIEW":
            conflictNeedsReviewCount++;
            break;
        }
      } catch (err: unknown) {
        const queueJobId = generateQueueJobId(job.idempotencyKey);
        const errorMessage = sanitizeErrorMessage(err);
        items.push({
          syncJobId: job.id,
          outcome: "ERROR",
          queueJobId,
          error: errorMessage,
        });
      }
    }

    return {
      examinedCount: pendingJobs.length,
      dispatchedCount,
      alreadyQueuedCount,
      retriedCount,
      conflictNeedsReviewCount,
      items,
    };
  }

  private async dispatchJob(job: SyncJob): Promise<DispatchItemResult> {
    const queueJobId = generateQueueJobId(job.idempotencyKey);
    const bullJob = await this.syncQueue.getJob(queueJobId);

    // Case 1: No queue job exists -> enqueue via certified SyncExecutionQueue
    if (!bullJob) {
      await this.syncQueue.enqueueSyncJob(job.id);
      return {
        syncJobId: job.id,
        outcome: "DISPATCHED",
        queueJobId,
        queueState: "waiting",
      };
    }

    // Case 2: Queue job exists -> inspect BullMQ state
    const rawState = await bullJob.getState();
    const normalizedState = normalizeBullMQJobState(rawState);

    // Rule A: WAITING / DELAYED / ACTIVE / PRIORITIZED -> Already queued, do not create duplicate
    if (
      normalizedState === "waiting" ||
      normalizedState === "delayed" ||
      normalizedState === "active" ||
      normalizedState === "prioritized"
    ) {
      return {
        syncJobId: job.id,
        outcome: "ALREADY_QUEUED",
        queueJobId,
        queueState: normalizedState,
      };
    }

    // Rule B: FAILED -> DB is PENDING, operator/runtime authorized retry. Concurrency-safe retry.
    if (normalizedState === "failed") {
      try {
        await bullJob.retry();
        return {
          syncJobId: job.id,
          outcome: "RETRIED",
          queueJobId,
          queueState: "waiting",
        };
      } catch (retryErr: unknown) {
        // Concurrency recovery: check if another scheduler instance already changed state
        const reState = normalizeBullMQJobState(await bullJob.getState());
        if (
          reState === "waiting" ||
          reState === "delayed" ||
          reState === "active" ||
          reState === "prioritized"
        ) {
          return {
            syncJobId: job.id,
            outcome: "ALREADY_QUEUED",
            queueJobId,
            queueState: reState,
          };
        }
        if (
          reState === "completed" ||
          reState === "waiting-children" ||
          reState === "unknown"
        ) {
          return await this.transitionToNeedsReview(job, queueJobId, reState);
        }
        throw retryErr;
      }
    }

    // Rule C: COMPLETED / WAITING-CHILDREN / UNKNOWN -> Inconsistency! DB is PENDING but BullMQ is COMPLETED.
    // Transition PENDING -> NEEDS_REVIEW conditionally, record SYSTEM AuditLog, do NOT replay.
    return await this.transitionToNeedsReview(job, queueJobId, normalizedState);
  }

  private async transitionToNeedsReview(
    job: SyncJob,
    queueJobId: string,
    queueState: string
  ): Promise<DispatchItemResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      assertSyncJobTransition("PENDING", "NEEDS_REVIEW");

      const updateRes = await tx.syncJob.updateMany({
        where: {
          id: job.id,
          status: "PENDING",
        },
        data: {
          status: "NEEDS_REVIEW",
          lastErrorCode: "QUEUE_STATE_CONFLICT",
          lastErrorMessage: `BullMQ job state '${queueState}' conflicts with PENDING state. Operator review required.`,
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
          entityId: job.id,
          before: {
            status: "PENDING",
            updatedAt: job.updatedAt.toISOString(),
          },
          after: {
            status: "NEEDS_REVIEW",
            lastErrorCode: "QUEUE_STATE_CONFLICT",
          },
          metadata: {
            reason: `Queue state '${queueState}' conflicts with PENDING state`,
            queueState,
          },
        },
      });

      return { outcome: "CONFLICT_NEEDS_REVIEW" as const };
    });

    return {
      syncJobId: job.id,
      outcome: result.outcome,
      queueJobId,
      queueState,
    };
  }
}
