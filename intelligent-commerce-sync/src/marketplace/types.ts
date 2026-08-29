import type { CanonicalProduct } from "../canonical/types.js";

/**
 * Supported execution mode for marketplace operations:
 * - "dry_run": Validates draft, calculates pricing & stock, simulates payload without remote mutation.
 * - "publish": Performs authorized remote marketplace write followed by read-after-write verification.
 */
export type MarketplaceOperationMode = "dry_run" | "publish";

/**
 * Standard life-cycle and workflow statuses for marketplace listing preparation and publication.
 */
export type MarketplaceListingStatus =
  | "DRAFT"
  | "DRAFT_VALID"
  | "READY_FOR_REVIEW"
  | "EDIT_REQUIRED"
  | "REJECTED"
  | "APPROVED_FOR_PUBLISH"
  | "READY"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "VERIFYING"
  | "VERIFIED"
  | "FAILED";

/**
 * Severity level of validation and mapping issues.
 */
export type MarketplaceIssueSeverity = "INFO" | "WARNING" | "ERROR" | "BLOCKER";

export interface MarketplaceValidationIssue {
  code: string;
  field: string;
  message: string;
  severity: MarketplaceIssueSeverity;
}

export interface MarketplaceValidationResult {
  valid: boolean;
  validationReady: boolean; // No BLOCKER validation issues
  eligibleForApproval: boolean; // validationReady && review is pending
  canPublish: boolean; // validationReady && review === "APPROVE" && category resolved && stock resolved
  issues: MarketplaceValidationIssue[];
  blockerCount: number;
  warningCount: number;
}

/**
 * Human review decision options.
 */
export type HumanReviewDecision = "APPROVE" | "REJECT" | "EDIT_REQUIRED";

export interface HumanReviewRecord {
  decision: HumanReviewDecision;
  reviewedBy?: string | undefined;
  reviewedAt: Date;
  notes?: string | undefined;
}

/**
 * Idempotency key structure for marketplace operations.
 */
export interface MarketplaceIdempotencyKey {
  marketplace: string;
  sellerAccount: string;
  source: string;
  sourceProductId: string;
  operationType: "CREATE_LISTING" | "UPDATE_PRICE" | "UPDATE_STOCK";
}

export function formatIdempotencyKey(key: MarketplaceIdempotencyKey): string {
  return `${key.marketplace}:${key.sellerAccount}:${key.source}:${key.sourceProductId}:${key.operationType}`;
}

/**
 * Common draft interface that all marketplace-specific listing drafts satisfy.
 */
export interface MarketplaceListingDraft {
  marketplace: string;
  sourceProductId: string;
  status: MarketplaceListingStatus;
  validation: MarketplaceValidationResult;
  review?: HumanReviewRecord | undefined;
  idempotencyKey: string;
  createdAt: Date;
}

/**
 * Publication result statuses.
 */
export type MarketplacePublishStatus =
  | "PUBLISHED"
  | "DRY_RUN_COMPLETED"
  | "BLOCKED_BY_VALIDATION"
  | "BLOCKED_BY_REVIEW"
  | "BLOCKED_BY_CREDENTIALS"
  | "BLOCKED_BY_PLATFORM_ACCESS"
  | "PUBLISH_FAILED";

export interface MarketplacePublishSuccess {
  status: "PUBLISHED";
  mode: "publish";
  marketplace: string;
  marketplaceListingId: string;
  publishedAt: Date;
  idempotencyKey: string;
  rawResponse?: Record<string, unknown> | undefined;
}

export interface MarketplacePublishDryRun {
  status: "DRY_RUN_COMPLETED";
  mode: "dry_run";
  marketplace: string;
  simulatedListingId?: string | undefined;
  preparedAt: Date;
  idempotencyKey: string;
  simulatedPayload: Record<string, unknown>;
}

export interface MarketplacePublishBlocked {
  status:
    | "BLOCKED_BY_VALIDATION"
    | "BLOCKED_BY_REVIEW"
    | "BLOCKED_BY_CREDENTIALS"
    | "BLOCKED_BY_PLATFORM_ACCESS";
  mode: MarketplaceOperationMode;
  marketplace: string;
  reason: string;
  blockers: MarketplaceValidationIssue[];
  idempotencyKey: string;
}

export interface MarketplacePublishFailed {
  status: "PUBLISH_FAILED";
  mode: "publish";
  marketplace: string;
  error: string;
  errorCode?: string | undefined;
  idempotencyKey: string;
}

export type MarketplacePublishResult =
  | MarketplacePublishSuccess
  | MarketplacePublishDryRun
  | MarketplacePublishBlocked
  | MarketplacePublishFailed;

/**
 * Read-after-write verification outcome statuses.
 */
export type MarketplaceVerificationStatus =
  | "VERIFIED"
  | "VERIFY_MISMATCH"
  | "VERIFY_NOT_FOUND"
  | "MISMATCH"
  | "NOT_FOUND"
  | "FAILED"
  | "NOT_APPLICABLE_TO_DRY_RUN"
  | "BLOCKED";

export interface MarketplaceVerificationMismatchDetail {
  field: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface MarketplaceVerificationResult {
  status: MarketplaceVerificationStatus;
  marketplace: string;
  marketplaceListingId?: string | undefined;
  verifiedAt: Date;
  mismatches: MarketplaceVerificationMismatchDetail[];
  message: string;
}

/**
 * Generic configuration parameters for preparing marketplace drafts.
 */
export interface MarketplacePreparationConfig {
  markupMode?: "percentage" | "fixed" | undefined;
  markupValue?: number | undefined;
  roundingUnit?: number | undefined;
  safetyStock?: number | undefined;
  undisclosedStockPolicy?: "needs_review" | "safety_stock_fixed" | "block" | undefined;
  categoryOverrideId?: string | undefined;
  sellerAccountId?: string | undefined;
}

/**
 * Source-agnostic adapter interface for marketplace integrations.
 */
export interface MarketplaceAdapter<
  TDraft extends MarketplaceListingDraft = MarketplaceListingDraft
> {
  readonly marketplaceName: string;

  prepareListing(
    product: CanonicalProduct,
    config?: MarketplacePreparationConfig
  ): Promise<TDraft>;

  validateListing(draft: TDraft): Promise<MarketplaceValidationResult>;

  publishListing(
    draft: TDraft,
    mode: MarketplaceOperationMode
  ): Promise<MarketplacePublishResult>;

  verifyListing(
    publishResult: MarketplacePublishResult,
    expectedDraft: TDraft
  ): Promise<MarketplaceVerificationResult>;
}
