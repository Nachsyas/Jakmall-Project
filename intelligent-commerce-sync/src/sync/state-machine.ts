import type { SyncJobStatus } from "../persistence/types.js";
import type { SyncPlanStatus } from "./types.js";

/**
 * Error thrown when an illegal or unsupported sync job state transition is attempted.
 */
export class InvalidSyncJobTransitionError extends Error {
  readonly fromStatus: SyncJobStatus;
  readonly toStatus: SyncJobStatus;

  constructor(fromStatus: SyncJobStatus, toStatus: SyncJobStatus) {
    super(`Cannot transition SyncJob from status '${fromStatus}' to '${toStatus}'.`);
    this.name = "InvalidSyncJobTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Authoritative, conservative state transition table for SyncJob lifecycle.
 * - COMPLETED and CANCELLED are strictly terminal statuses.
 * - FAILED and BLOCKED can transition to PENDING (for manual or scheduled requeuing) or CANCELLED.
 * - NEEDS_REVIEW can transition to PENDING (after operator approval), BLOCKED, or CANCELLED.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<SyncJobStatus, ReadonlySet<SyncJobStatus>>> = {
  PENDING: new Set<SyncJobStatus>([
    "PROCESSING",
    "NEEDS_REVIEW",
    "BLOCKED",
    "CANCELLED",
  ]),
  PROCESSING: new Set<SyncJobStatus>([
    "COMPLETED",
    "FAILED",
    "NEEDS_REVIEW",
    "BLOCKED",
    "CANCELLED",
  ]),
  NEEDS_REVIEW: new Set<SyncJobStatus>([
    "PENDING",
    "BLOCKED",
    "CANCELLED",
  ]),
  BLOCKED: new Set<SyncJobStatus>([
    "PENDING",
    "CANCELLED",
  ]),
  FAILED: new Set<SyncJobStatus>([
    "PENDING",
    "CANCELLED",
  ]),
  COMPLETED: new Set<SyncJobStatus>([]),
  CANCELLED: new Set<SyncJobStatus>([]),
};

/**
 * Checks whether a transition between two SyncJob statuses is permitted by domain policy.
 */
export function canTransitionSyncJobStatus(
  fromStatus: SyncJobStatus,
  toStatus: SyncJobStatus
): boolean {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed) {
    return false;
  }
  return allowed.has(toStatus);
}

/**
 * Asserts that a transition between two SyncJob statuses is valid, throwing an InvalidSyncJobTransitionError if not.
 */
export function assertSyncJobTransition(
  fromStatus: SyncJobStatus,
  toStatus: SyncJobStatus
): void {
  if (!canTransitionSyncJobStatus(fromStatus, toStatus)) {
    throw new InvalidSyncJobTransitionError(fromStatus, toStatus);
  }
}

/**
 * Pure domain mapping from a planner outcome (SyncPlanStatus) to an initial job state (SyncJobStatus).
 * - "NO_ACTION" -> "COMPLETED" (no execution work needed; lifecycle is complete)
 * - "READY" -> "PENDING" (ready to be queued for execution)
 * - "NEEDS_REVIEW" -> "NEEDS_REVIEW" (awaits operator intervention)
 * - "BLOCKED" -> "BLOCKED" (inhibited by safety policy or missing preconditions)
 */
export function mapPlanStatusToInitialJobStatus(
  planStatus: SyncPlanStatus
): SyncJobStatus {
  switch (planStatus) {
    case "NO_ACTION":
      return "COMPLETED";
    case "READY":
      return "PENDING";
    case "NEEDS_REVIEW":
      return "NEEDS_REVIEW";
    case "BLOCKED":
      return "BLOCKED";
    default: {
      const _exhaustive: never = planStatus;
      throw new Error(`Unhandled SyncPlanStatus: ${String(_exhaustive)}`);
    }
  }
}
