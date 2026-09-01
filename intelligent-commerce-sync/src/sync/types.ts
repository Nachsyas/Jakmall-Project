import type { MarketplaceListingStatus } from "../marketplace/types.js";
import type { SnapshotChangeKind, SnapshotDiffResult } from "../persistence/types.js";

/**
 * Top-level disposition of a generated synchronization plan.
 * - "NO_ACTION": Source state has no semantic change or operations required.
 * - "READY": All operations are safe, validated, and immediately executable.
 * - "NEEDS_REVIEW": Plan contains changes requiring human review or policy approval.
 * - "BLOCKED": Plan is prevented from execution by missing prerequisites, safety policy, or invalid listing state.
 */
export type SyncPlanStatus =
  | "NO_ACTION"
  | "READY"
  | "NEEDS_REVIEW"
  | "BLOCKED";

/**
 * Authoritative executable marketplace operation types supported by the sync domain.
 * Strictly maps to existing marketplace operation semantics.
 * Note: Remote content and variant updates do NOT exist as automated marketplace operations.
 */
export type SyncOperationType =
  | "CREATE_LISTING"
  | "UPDATE_PRICE"
  | "UPDATE_STOCK";

/**
 * Execution eligibility of an individual planned marketplace operation.
 * - "ELIGIBLE": Ready to be dispatched to execution workers.
 * - "REQUIRES_REVIEW": Validated operation intent, but execution is withheld pending human/policy review.
 * - "BLOCKED": Operation cannot execute due to missing prerequisites or safety policy violations.
 */
export type SyncOperationEligibility =
  | "ELIGIBLE"
  | "REQUIRES_REVIEW"
  | "BLOCKED";

/**
 * Ownership domains for product and listing attributes.
 * Segregated to prevent infinite loops and protect customized content.
 */
export type FieldOwner = "SOURCE" | "SYSTEM" | "SELLER";

/**
 * Deterministic risk level assigned to sync plans, operations, and audit decisions.
 */
export type SyncRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Disposition of the inventory resolution gate supplied to the sync planner.
 * Reflects whether source inventory change has been resolved safely by Phase 3 inventory policy.
 */
export type InventoryGateStatus = "RESOLVED" | "NEEDS_REVIEW" | "BLOCKED";

/**
 * Finite domain decision codes explaining the rationale for planned sync operations and status.
 */
export type SyncDecisionCode =
  | "FIRST_SNAPSHOT_NEW_LISTING"
  | "FIRST_SNAPSHOT_EXISTING_LISTING"
  | "NO_SEMANTIC_CHANGE"
  | "PRICE_CHANGE_DETECTED"
  | "INVENTORY_CHANGE_DETECTED"
  | "CONTENT_CHANGE_REQUIRES_REVIEW"
  | "VARIANT_STRUCTURE_CHANGE_REQUIRES_REVIEW"
  | "SELLER_OWNED_FIELD_PROTECTED"
  | "INVENTORY_RESOLUTION_REQUIRED"
  | "INVENTORY_POLICY_BLOCKED"
  | "LISTING_NOT_FOUND"
  | "LISTING_STATUS_REQUIRED"
  | "REMOTE_LISTING_ID_REQUIRED"
  | "LISTING_REVIEW_REQUIRED"
  | "LISTING_BLOCKED"
  | "MULTIPLE_CHANGES_DETECTED";

/**
 * Structured audit decision recording why a specific operation or plan status was chosen.
 */
export interface SyncDecision {
  code: SyncDecisionCode;
  message: string;
  risk: SyncRiskLevel;
  changeKind?: SnapshotChangeKind | undefined;
  operationType?: SyncOperationType | undefined;
}

/**
 * Representation of a planned marketplace operation intent.
 * Contains purely deterministic intent without executing remote side effects or fabricating remote IDs.
 */
export interface SyncPlannedOperation {
  operationType: SyncOperationType;
  marketplace: string;
  sellerAccountKey: string;
  source: string;
  sourceProductId: string;
  /** Product-level Phase 3 operation family identity (marketplace:seller:source:productId:opType) */
  baseOperationKey: string;
  /** Execution idempotency key (snapshot-scoped for updates, product-scoped for listing creation) */
  idempotencyKey: string;
  eligibility: SyncOperationEligibility;
  reason: string;
}

/**
 * Marketplace listing context provided as input to the sync planner.
 */
export interface SyncPlannerListingContext {
  /** True if a local or remote listing already exists for this source product */
  exists: boolean;
  /** Authoritative remote listing identifier (must be present for update operations) */
  remoteListingId?: string | undefined;
  /** Current lifecycle status of the marketplace listing */
  status?: MarketplaceListingStatus | undefined;
}

/**
 * Policy gates evaluated prior to sync planning.
 */
export interface SyncPlannerGates {
  /** Disposition of source inventory change under Phase 3 inventory policy */
  inventory: InventoryGateStatus;
}

/**
 * Pure, explicit input structure required by the synchronization planner.
 */
export interface SyncPlannerInput {
  /** Diff truth between existing and newly captured source snapshots */
  diff: SnapshotDiffResult;
  /** Persisted source snapshot identifier (used for snapshot-scoped update idempotency) */
  sourceSnapshotId: string;
  /** Source platform name (e.g. "jakmall") */
  source: string;
  /** Source product identifier (preserved literally) */
  sourceProductId: string;
  /** Target marketplace name (e.g. "shopee") */
  marketplace: string;
  /** Seller account key in the target marketplace */
  sellerAccountKey: string;
  /** Listing state and remote identifier context */
  listing: SyncPlannerListingContext;
  /** Policy evaluation gates */
  gates: SyncPlannerGates;
}

/**
 * Pure, deterministic output emitted by the synchronization planner.
 * Encapsulates what should happen without performing remote execution.
 */
export interface SyncPlan {
  /** Top-level disposition of the sync plan */
  status: SyncPlanStatus;
  /** Ordered list of planned marketplace operations */
  operations: SyncPlannedOperation[];
  /** Structured audit decisions explaining the plan */
  decisions: SyncDecision[];
  /** True if human or policy review is required before execution */
  requiresReview: boolean;
  /** True if execution is blocked by safety policy or missing prerequisites */
  blocked: boolean;
  /** Overall risk level of the plan */
  risk: SyncRiskLevel;
}

/**
 * Error thrown when input to the synchronization planner is malformed or violates invariant contracts.
 */
export class SyncPlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPlanningInputError";
  }
}

/**
 * Error thrown when input parameters for generating sync operation idempotency keys are invalid or contain delimiter collisions.
 */
export class SyncIdempotencyKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncIdempotencyKeyInputError";
  }
}
