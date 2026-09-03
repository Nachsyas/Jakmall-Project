import type { SyncJob } from "@prisma/client";

// --------------------------------------------------------------------------
// CONFIGURATION TYPES
// --------------------------------------------------------------------------
export interface RuntimeConfig {
  staleProcessingMs: number;
  maintenanceIntervalMs: number;
  batchSize: number;
}

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

// --------------------------------------------------------------------------
// BULLMQ NORMALIZED JOB STATES
// --------------------------------------------------------------------------
export type NormalizedBullMQJobState =
  | "waiting"
  | "delayed"
  | "active"
  | "prioritized"
  | "failed"
  | "completed"
  | "waiting-children"
  | "unknown";

export function normalizeBullMQJobState(state: string | null | undefined): NormalizedBullMQJobState {
  if (!state) {
    return "unknown";
  }
  switch (state) {
    case "waiting":
    case "delayed":
    case "active":
    case "prioritized":
    case "failed":
    case "completed":
    case "waiting-children":
      return state;
    default:
      return "unknown";
  }
}

// --------------------------------------------------------------------------
// RECOVERY TYPES
// --------------------------------------------------------------------------
export type RecoveryOutcome =
  | "RECOVERED"
  | "SKIPPED_ACTIVE"
  | "NEEDS_REVIEW"
  | "CONCURRENT_SKIP"
  | "ERROR";

export interface RecoveryItemResult {
  syncJobId: string;
  outcome: RecoveryOutcome;
  queueState?: string | undefined;
  error?: string | undefined;
}

export interface RecoveryBatchResult {
  candidatesExamined: number;
  recoveredCount: number;
  skippedActiveCount: number;
  needsReviewCount: number;
  concurrentSkipCount: number;
  items: RecoveryItemResult[];
}

export interface RecoveryServiceOptions {
  batchSize?: number | undefined;
}

// --------------------------------------------------------------------------
// SCHEDULER / DISPATCH TYPES
// --------------------------------------------------------------------------
export type DispatchOutcome =
  | "DISPATCHED"
  | "ALREADY_QUEUED"
  | "RETRIED"
  | "CONFLICT_NEEDS_REVIEW"
  | "CONCURRENT_SKIP"
  | "ERROR";

export interface DispatchItemResult {
  syncJobId: string;
  outcome: DispatchOutcome;
  queueJobId: string;
  queueState?: string | undefined;
  error?: string | undefined;
}

export interface SchedulerBatchResult {
  examinedCount: number;
  dispatchedCount: number;
  alreadyQueuedCount: number;
  retriedCount: number;
  conflictNeedsReviewCount: number;
  items: DispatchItemResult[];
}

export interface SchedulerServiceOptions {
  batchSize?: number | undefined;
}

// --------------------------------------------------------------------------
// RUNTIME HEALTH TYPES
// --------------------------------------------------------------------------
export type RuntimeHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

export interface RuntimeHealthSnapshot {
  status: RuntimeHealthStatus;
  checkedAt: string;

  database: {
    healthy: boolean;
  };

  redis: {
    healthy: boolean;
  };

  queue: {
    healthy: boolean;
    counts?: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      completed: number;
    } | undefined;
  };

  syncJobs?: {
    pending: number;
    processing: number;
    failed: number;
    needsReview: number;
    blocked: number;
    staleProcessing: number;
  } | undefined;
}

// --------------------------------------------------------------------------
// MAINTENANCE CYCLE TYPES
// --------------------------------------------------------------------------
export interface MaintenanceCycleResult {
  recovery: RecoveryBatchResult;
  dispatch: SchedulerBatchResult;
  health: RuntimeHealthSnapshot;
}

export type RuntimeClock = () => Date;
