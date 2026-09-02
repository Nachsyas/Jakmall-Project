import type { SyncJob } from "@prisma/client";
import type { DurableExecutionPayload } from "../execution/types.js";

export const SYNC_EXECUTION_QUEUE_NAME = "sync-execution";

export interface SyncQueueJobData {
  schemaVersion: 1;
  syncJobId: string;
}

export interface SyncJobExecutor {
  execute(job: SyncJob, payload: DurableExecutionPayload): Promise<void>;
}

export class SyncQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncQueueError";
  }
}

export class SyncJobNotFoundError extends SyncQueueError {
  constructor(message: string) {
    super(message);
    this.name = "SyncJobNotFoundError";
  }
}

export class NonQueueableJobStatusError extends SyncQueueError {
  constructor(message: string) {
    super(message);
    this.name = "NonQueueableJobStatusError";
  }
}

export class SyncJobExecutionClaimError extends SyncQueueError {
  constructor(message: string) {
    super(message);
    this.name = "SyncJobExecutionClaimError";
  }
}

export class InvalidQueuePayloadError extends SyncQueueError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueuePayloadError";
  }
}

/**
 * Strict validator for BullMQ job payload.
 * Rejects non-objects, arrays, null, extra keys, wrong schemaVersion, or blank syncJobId.
 */
export function validateSyncQueueJobData(data: unknown): SyncQueueJobData {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InvalidQueuePayloadError("Queue job payload must be a non-null object.");
  }

  const keys = Object.keys(data);
  const allowedKeys = new Set(["schemaVersion", "syncJobId"]);
  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      throw new InvalidQueuePayloadError(`Forbidden field '${key}' in queue job payload.`);
    }
  }

  const record = data as Record<string, unknown>;

  if (record["schemaVersion"] !== 1) {
    throw new InvalidQueuePayloadError(
      `Unsupported queue schemaVersion '${String(record["schemaVersion"])}'. Expected 1.`
    );
  }

  const syncJobId = record["syncJobId"];
  if (typeof syncJobId !== "string" || syncJobId.trim().length === 0) {
    throw new InvalidQueuePayloadError("Queue job payload requires a non-empty string 'syncJobId'.");
  }

  return {
    schemaVersion: 1,
    syncJobId: syncJobId.trim(),
  };
}
