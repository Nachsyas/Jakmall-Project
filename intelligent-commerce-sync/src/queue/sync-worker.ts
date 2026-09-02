import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PrismaClient, SyncJob } from "@prisma/client";
import { validateDurableExecutionPayload } from "../execution/durable-payload.js";
import { assertSyncJobTransition } from "../sync/state-machine.js";
import {
  SYNC_EXECUTION_QUEUE_NAME,
  type SyncQueueJobData,
  type SyncJobExecutor,
  validateSyncQueueJobData,
  SyncJobNotFoundError,
  NonQueueableJobStatusError,
  SyncJobExecutionClaimError,
} from "./types.js";
import { parseRedisConnectionOptions } from "./connection.js";
import { sanitizeErrorMessage, extractSafeErrorCode } from "./error-sanitizer.js";

export class SyncExecutionWorker {
  private readonly worker: Worker<SyncQueueJobData>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly executor: SyncJobExecutor,
    options?: {
      queueName?: string;
      connection?: ConnectionOptions;
      concurrency?: number;
      autorun?: boolean;
    }
  ) {
    const queueName = options?.queueName ?? SYNC_EXECUTION_QUEUE_NAME;
    const connection = options?.connection ?? (parseRedisConnectionOptions() as ConnectionOptions);

    this.worker = new Worker<SyncQueueJobData>(
      queueName,
      async (job: Job<SyncQueueJobData>) => {
        return this.processJob(job);
      },
      {
        connection,
        concurrency: options?.concurrency ?? 1,
        autorun: options?.autorun ?? true,
      }
    );
  }

  private async processJob(job: Job<SyncQueueJobData>): Promise<void> {
    // 1. Strictly validate queue payload structure
    const { syncJobId } = validateSyncQueueJobData(job.data);

    // 2. Load authoritative SyncJob from PostgreSQL
    const syncJob = await this.prisma.syncJob.findUnique({
      where: { id: syncJobId },
    });

    if (!syncJob) {
      throw new SyncJobNotFoundError(`Authoritative SyncJob ${syncJobId} not found in database.`);
    }

    // 3. Validate persisted executionPayload
    const durablePayload = validateDurableExecutionPayload(syncJob.executionPayload);

    // 4. Concurrency-safe execution claim following certified state-machine transitions
    let processingJob: SyncJob;
    try {
      processingJob = await this.prisma.$transaction(async (tx) => {
        const current = await tx.syncJob.findUnique({
          where: { id: syncJobId },
        });

        if (!current) {
          throw new SyncJobNotFoundError(`SyncJob ${syncJobId} not found during execution claim.`);
        }

        if (current.status === "PENDING") {
          // Initial execution: PENDING -> PROCESSING
          assertSyncJobTransition("PENDING", "PROCESSING");

          const claimResult = await tx.syncJob.updateMany({
            where: { id: syncJobId, status: "PENDING" },
            data: {
              status: "PROCESSING",
              attemptCount: { increment: 1 },
              startedAt: current.startedAt ?? new Date(),
            },
          });

          if (claimResult.count === 0) {
            throw new SyncJobExecutionClaimError(
              `Failed to claim SyncJob ${syncJobId}: row was concurrently claimed or altered.`
            );
          }
        } else if (current.status === "FAILED") {
          // Retry execution: persist certified FAILED -> PENDING then PENDING -> PROCESSING
          assertSyncJobTransition("FAILED", "PENDING");
          const requeueResult = await tx.syncJob.updateMany({
            where: { id: syncJobId, status: "FAILED" },
            data: {
              status: "PENDING",
            },
          });

          if (requeueResult.count === 0) {
            throw new SyncJobExecutionClaimError(
              `Failed to requeue SyncJob ${syncJobId} for retry: row is no longer in FAILED status.`
            );
          }

          assertSyncJobTransition("PENDING", "PROCESSING");
          const processingResult = await tx.syncJob.updateMany({
            where: { id: syncJobId, status: "PENDING" },
            data: {
              status: "PROCESSING",
              attemptCount: { increment: 1 },
              startedAt: current.startedAt ?? new Date(),
            },
          });

          if (processingResult.count === 0) {
            throw new SyncJobExecutionClaimError(
              `Failed to transition retried SyncJob ${syncJobId} to PROCESSING.`
            );
          }
        } else {
          throw new NonQueueableJobStatusError(
            `SyncJob ${syncJobId} with status '${current.status}' is not in an executable state.`
          );
        }

        return tx.syncJob.findUniqueOrThrow({ where: { id: syncJobId } });
      });
    } catch (claimErr) {
      // Re-throw claim / precondition errors without executing or setting status to FAILED
      throw claimErr;
    }

    try {
      // 5. Invoke injected executor
      await this.executor.execute(processingJob, durablePayload);

      // 6. Success lifecycle
      assertSyncJobTransition("PROCESSING", "COMPLETED");

      await this.prisma.$transaction([
        this.prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        }),
        this.prisma.syncEvent.create({
          data: {
            syncJobId,
            productSourceId: processingJob.productSourceId,
            marketplaceListingId: processingJob.marketplaceListingId,
            sourceSnapshotId: processingJob.sourceSnapshotId,
            eventType: "SYNC_COMPLETED",
            payload: {
              completedAt: new Date().toISOString(),
              attemptCount: processingJob.attemptCount,
            },
          },
        }),
      ]);
    } catch (execError: unknown) {
      // 7. Sanitized failure persistence for ALL executor rejections
      const sanitizedMessage = sanitizeErrorMessage(execError);
      const errorCode = extractSafeErrorCode(execError);

      assertSyncJobTransition("PROCESSING", "FAILED");

      await this.prisma.$transaction([
        this.prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            status: "FAILED",
            lastErrorCode: errorCode,
            lastErrorMessage: sanitizedMessage,
          },
        }),
        this.prisma.syncEvent.create({
          data: {
            syncJobId,
            productSourceId: processingJob.productSourceId,
            marketplaceListingId: processingJob.marketplaceListingId,
            sourceSnapshotId: processingJob.sourceSnapshotId,
            eventType: "SYNC_FAILED",
            payload: {
              errorCode,
              errorMessage: sanitizedMessage,
              attemptCount: processingJob.attemptCount,
            },
          },
        }),
      ]);

      // Rethrow so BullMQ schedules backoff retry if attempts remain
      throw execError;
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
  }

  get rawWorker(): Worker<SyncQueueJobData> {
    return this.worker;
  }
}
