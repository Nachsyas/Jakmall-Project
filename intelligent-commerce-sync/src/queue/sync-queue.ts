import { createHash } from "node:crypto";
import { Queue, type Job, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { validateDurableExecutionPayload } from "../execution/durable-payload.js";
import {
  SYNC_EXECUTION_QUEUE_NAME,
  type SyncQueueJobData,
  SyncJobNotFoundError,
  NonQueueableJobStatusError,
} from "./types.js";
import { parseRedisConnectionOptions } from "./connection.js";

export function generateQueueJobId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

export interface EnqueueOptions {
  attempts?: number;
  backoff?: {
    type: "fixed" | "exponential";
    delay: number;
  };
}

export class SyncExecutionQueue {
  private readonly queue: Queue<SyncQueueJobData>;

  constructor(
    private readonly prisma: PrismaClient,
    options?: {
      queueName?: string;
      connection?: ConnectionOptions;
    }
  ) {
    const queueName = options?.queueName ?? SYNC_EXECUTION_QUEUE_NAME;
    const connection = options?.connection ?? (parseRedisConnectionOptions() as ConnectionOptions);

    this.queue = new Queue<SyncQueueJobData>(queueName, {
      connection,
    });
  }

  async enqueueSyncJob(
    syncJobId: string,
    options?: EnqueueOptions
  ): Promise<Job<SyncQueueJobData>> {
    // 1. Load SyncJob from PostgreSQL
    const syncJob = await this.prisma.syncJob.findUnique({
      where: { id: syncJobId },
    });

    if (!syncJob) {
      throw new SyncJobNotFoundError(`SyncJob ${syncJobId} not found in database.`);
    }

    // 2. Validate authoritative executionPayload
    validateDurableExecutionPayload(syncJob.executionPayload);

    // 3. Ensure status is queueable (only PENDING in this phase)
    if (syncJob.status !== "PENDING") {
      throw new NonQueueableJobStatusError(
        `SyncJob ${syncJobId} with status '${syncJob.status}' cannot be enqueued. Only PENDING jobs are queueable.`
      );
    }

    // 4. Derive deterministic queue jobId from persisted idempotencyKey
    const jobId = generateQueueJobId(syncJob.idempotencyKey);

    // 5. Add BullMQ job with minimal reference payload
    const jobData: SyncQueueJobData = {
      schemaVersion: 1,
      syncJobId,
    };

    const job = await this.queue.add("execute-sync", jobData, {
      jobId,
      attempts: options?.attempts ?? 3,
      backoff: options?.backoff ?? {
        type: "exponential",
        delay: 500,
      },
      removeOnComplete: false,
      removeOnFail: false,
    });

    return job;
  }

  async getJob(jobId: string): Promise<Job<SyncQueueJobData> | undefined> {
    return this.queue.getJob(jobId);
  }

  async getJobCounts() {
    return this.queue.getJobCounts();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  get rawQueue(): Queue<SyncQueueJobData> {
    return this.queue;
  }
}
