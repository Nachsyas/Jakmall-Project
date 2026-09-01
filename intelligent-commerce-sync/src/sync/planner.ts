import type { MarketplaceListingStatus } from "../marketplace/types.js";
import { diffSnapshotHashes } from "../persistence/diff.js";
import type { SnapshotChangeKind, SnapshotDiffResult } from "../persistence/types.js";
import {
  generateSyncBaseOperationKey,
  generateSyncOperationIdempotencyKey,
} from "./idempotency.js";
import {
  type SyncDecision,
  type SyncPlan,
  type SyncPlanStatus,
  type SyncPlannedOperation,
  type SyncPlannerInput,
  type SyncRiskLevel,
  SyncPlanningInputError,
} from "./types.js";

/**
 * Authoritative domain ordering for evaluating change kinds.
 * Guarantees that shuffled diff kinds produce identical deterministic outputs.
 */
const DOMAIN_KIND_ORDER: readonly SnapshotChangeKind[] = [
  "PRICE_CHANGED",
  "INVENTORY_CHANGED",
  "CONTENT_CHANGED",
  "VARIANTS_CHANGED",
];

const VALID_KINDS_SET: ReadonlySet<string> = new Set<SnapshotChangeKind>(DOMAIN_KIND_ORDER);

/**
 * Explicit finite listing status policy sets.
 * Prevents fail-open behavior where unhandled listing statuses are treated as safe for update execution.
 */
const UPDATE_CAPABLE_LISTING_STATUSES: ReadonlySet<MarketplaceListingStatus> = new Set<MarketplaceListingStatus>([
  "PUBLISHED",
  "VERIFIED",
]);

const REVIEW_REQUIRED_LISTING_STATUSES: ReadonlySet<MarketplaceListingStatus> = new Set<MarketplaceListingStatus>([
  "DRAFT",
  "DRAFT_VALID",
  "READY_FOR_REVIEW",
  "EDIT_REQUIRED",
  "NEEDS_REVIEW",
  "APPROVED_FOR_PUBLISH",
  "READY",
]);

const BLOCKED_LISTING_STATUSES: ReadonlySet<MarketplaceListingStatus> = new Set<MarketplaceListingStatus>([
  "BLOCKED",
  "REJECTED",
  "FAILED",
  "PUBLISHING",
  "VERIFYING",
]);

const ALL_LISTING_STATUSES: ReadonlySet<MarketplaceListingStatus> = new Set<MarketplaceListingStatus>([
  ...UPDATE_CAPABLE_LISTING_STATUSES,
  ...REVIEW_REQUIRED_LISTING_STATUSES,
  ...BLOCKED_LISTING_STATUSES,
]);

const VALID_INVENTORY_GATES: ReadonlySet<string> = new Set<string>([
  "RESOLVED",
  "NEEDS_REVIEW",
  "BLOCKED",
]);

const RISK_WEIGHTS: Readonly<Record<SyncRiskLevel, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function maxRiskLevel(a: SyncRiskLevel, b: SyncRiskLevel): SyncRiskLevel {
  return RISK_WEIGHTS[a] >= RISK_WEIGHTS[b] ? a : b;
}

/**
 * Validates the internal integrity of the diff and planner input fail-closed.
 * Reuses diffSnapshotHashes from Phase 4A to verify that incoming diff.classification,
 * changed flag, and kinds are strictly consistent with authoritative hash comparison.
 */
function validatePlannerInput(input: SyncPlannerInput): void {
  if (!input || typeof input !== "object") {
    throw new SyncPlanningInputError("Planner input must be a valid non-null object.");
  }
  if (!input.source || typeof input.source !== "string" || input.source.trim().length === 0) {
    throw new SyncPlanningInputError("Planner input source must be a non-empty string.");
  }
  if (!input.sourceProductId || typeof input.sourceProductId !== "string" || input.sourceProductId.trim().length === 0) {
    throw new SyncPlanningInputError("Planner input sourceProductId must be a non-empty string.");
  }
  if (!input.sourceSnapshotId || typeof input.sourceSnapshotId !== "string" || input.sourceSnapshotId.trim().length === 0) {
    throw new SyncPlanningInputError("Planner input sourceSnapshotId must be a non-empty string.");
  }
  if (input.sourceSnapshotId.includes(":")) {
    throw new SyncPlanningInputError(
      `Planner input sourceSnapshotId must not contain separator ':' (received: '${input.sourceSnapshotId}').`
    );
  }
  if (!input.marketplace || typeof input.marketplace !== "string" || input.marketplace.trim().length === 0) {
    throw new SyncPlanningInputError("Planner input marketplace must be a non-empty string.");
  }
  if (!input.sellerAccountKey || typeof input.sellerAccountKey !== "string" || input.sellerAccountKey.trim().length === 0) {
    throw new SyncPlanningInputError("Planner input sellerAccountKey must be a non-empty string.");
  }

  // Validate policy gates
  if (!input.gates || typeof input.gates !== "object") {
    throw new SyncPlanningInputError("Planner input gates must be a valid non-null object.");
  }
  if (typeof input.gates.inventory !== "string" || !VALID_INVENTORY_GATES.has(input.gates.inventory)) {
    throw new SyncPlanningInputError(
      `Planner input gates.inventory must be exactly one of: RESOLVED, NEEDS_REVIEW, BLOCKED (received: '${String(input.gates.inventory)}').`
    );
  }

  // Validate listing context structure
  if (!input.listing || typeof input.listing !== "object") {
    throw new SyncPlanningInputError("Planner input listing must be a valid non-null object.");
  }
  if (typeof input.listing.exists !== "boolean") {
    throw new SyncPlanningInputError("Planner input listing.exists must be a boolean.");
  }
  if (input.listing.remoteListingId !== undefined) {
    if (typeof input.listing.remoteListingId !== "string") {
      throw new SyncPlanningInputError("Planner input listing.remoteListingId, when present, must be a string.");
    }
  }
  if (input.listing.status !== undefined) {
    if (typeof input.listing.status !== "string" || !ALL_LISTING_STATUSES.has(input.listing.status)) {
      throw new SyncPlanningInputError(
        `Planner input listing.status, when present, must be a recognized MarketplaceListingStatus (received: '${String(input.listing.status)}').`
      );
    }
  }

  // Strict invariant: when listing.exists is false, there is no listing lifecycle object yet
  if (!input.listing.exists) {
    if (input.listing.remoteListingId !== undefined && input.listing.remoteListingId.trim().length > 0) {
      throw new SyncPlanningInputError(
        "Inconsistent listing input: remoteListingId must not be present when listing.exists is false."
      );
    }
    if (input.listing.status !== undefined) {
      throw new SyncPlanningInputError(
        `Inconsistent listing input: listing.status must be undefined when listing.exists is false (received: '${input.listing.status}').`
      );
    }
  }

  // Validate snapshot diff structure and Phase 4A hash integrity
  const { diff } = input;
  if (!diff || typeof diff !== "object") {
    throw new SyncPlanningInputError("Planner input diff must be a valid SnapshotDiffResult object.");
  }
  if (!diff.newHashes || typeof diff.newHashes !== "object") {
    throw new SyncPlanningInputError("SnapshotDiffResult newHashes must be a valid SourceSnapshotHashes object.");
  }
  if (diff.oldHashes !== undefined && diff.oldHashes !== null && typeof diff.oldHashes !== "object") {
    throw new SyncPlanningInputError("SnapshotDiffResult oldHashes must be undefined, null, or a valid object.");
  }

  // First snapshot must not have oldHashes according to Phase 4A contract
  if (diff.classification === "FIRST_SNAPSHOT" && diff.oldHashes !== undefined && diff.oldHashes !== null) {
    throw new SyncPlanningInputError("SnapshotDiffResult with FIRST_SNAPSHOT must have undefined or null oldHashes.");
  }

  // Re-run authoritative Phase 4A diff to verify consistency without duplicating hash logic
  let authoritativeDiff: SnapshotDiffResult;
  try {
    authoritativeDiff = diffSnapshotHashes(diff.oldHashes, diff.newHashes);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new SyncPlanningInputError(`Snapshot diff hash integrity violation: ${errMsg}`);
  }

  if (diff.changed !== authoritativeDiff.changed) {
    throw new SyncPlanningInputError(
      `SnapshotDiffResult changed flag (${String(diff.changed)}) does not match authoritative hash diff (${String(authoritativeDiff.changed)}).`
    );
  }

  if (diff.classification !== authoritativeDiff.classification) {
    throw new SyncPlanningInputError(
      `SnapshotDiffResult classification '${diff.classification}' does not match authoritative hash diff '${authoritativeDiff.classification}'.`
    );
  }

  const { kinds } = diff;
  if (!Array.isArray(kinds)) {
    throw new SyncPlanningInputError("SnapshotDiffResult kinds must be an array.");
  }

  if (kinds.length !== authoritativeDiff.kinds.length) {
    throw new SyncPlanningInputError(
      `SnapshotDiffResult kinds count (${kinds.length}) does not match authoritative hash diff kinds count (${authoritativeDiff.kinds.length}).`
    );
  }

  const authoritativeKindsSet = new Set(authoritativeDiff.kinds);
  const seenKinds = new Set<SnapshotChangeKind>();
  for (const kind of kinds) {
    if (!VALID_KINDS_SET.has(kind)) {
      throw new SyncPlanningInputError(`Unrecognized change kind in diff: '${String(kind)}'.`);
    }
    if (seenKinds.has(kind)) {
      throw new SyncPlanningInputError(`Duplicate change kind detected in diff: '${kind}'.`);
    }
    if (!authoritativeKindsSet.has(kind)) {
      throw new SyncPlanningInputError(
        `SnapshotDiffResult kind '${kind}' is inconsistent with authoritative hash diff kinds: [${authoritativeDiff.kinds.join(", ")}].`
      );
    }
    seenKinds.add(kind);
  }
}

/**
 * Pure, deterministic synchronization planner.
 * Decides WHAT SHOULD HAPPEN given source snapshot diff truth, field ownership, listing state, and safety gates.
 * STRICTLY produces NO remote side effects, NO fake remote IDs, and NO invented marketplace operations.
 */
export function planSync(input: SyncPlannerInput): SyncPlan {
  validatePlannerInput(input);

  const {
    diff,
    sourceSnapshotId,
    source,
    sourceProductId,
    marketplace,
    sellerAccountKey,
    listing,
    gates,
  } = input;

  // 1. Handle NO_CHANGE
  if (diff.classification === "NO_CHANGE") {
    return {
      status: "NO_ACTION",
      operations: [],
      decisions: [
        {
          code: "NO_SEMANTIC_CHANGE",
          message: "Source snapshot is semantically identical to previous snapshot; no synchronization action required.",
          risk: "LOW",
        },
      ],
      requiresReview: false,
      blocked: false,
      risk: "LOW",
    };
  }

  // 2. Handle FIRST_SNAPSHOT
  if (diff.classification === "FIRST_SNAPSHOT") {
    if (!listing.exists) {
      const baseOperationKey = generateSyncBaseOperationKey({
        marketplace,
        sellerAccountKey,
        source,
        sourceProductId,
        operationType: "CREATE_LISTING",
      });
      const idempotencyKey = generateSyncOperationIdempotencyKey({
        marketplace,
        sellerAccountKey,
        source,
        sourceProductId,
        operationType: "CREATE_LISTING",
        sourceSnapshotId,
      });

      const operation: SyncPlannedOperation = {
        operationType: "CREATE_LISTING",
        marketplace,
        sellerAccountKey,
        source,
        sourceProductId,
        baseOperationKey,
        idempotencyKey,
        eligibility: "REQUIRES_REVIEW",
        reason: "First source snapshot detected; prepared listing creation draft requires human review approval.",
      };

      const decision: SyncDecision = {
        code: "FIRST_SNAPSHOT_NEW_LISTING",
        message: "First source snapshot detected with no existing marketplace listing; listing creation draft prepared and requires human review.",
        risk: "MEDIUM",
        operationType: "CREATE_LISTING",
      };

      return {
        status: "NEEDS_REVIEW",
        operations: [operation],
        decisions: [decision],
        requiresReview: true,
        blocked: false,
        risk: "MEDIUM",
      };
    }

    // Listing already exists locally or remotely, but this is the first persisted source snapshot
    return {
      status: "NEEDS_REVIEW",
      operations: [],
      decisions: [
        {
          code: "FIRST_SNAPSHOT_EXISTING_LISTING",
          message: "First locally persisted snapshot detected for an existing marketplace listing; baseline reconciliation review is required before updates.",
          risk: "HIGH",
        },
      ],
      requiresReview: true,
      blocked: false,
      risk: "HIGH",
    };
  }

  // 3. Update Planning: evaluate normalized change kinds in fixed domain order
  const normalizedKinds: SnapshotChangeKind[] = DOMAIN_KIND_ORDER.filter((k) => diff.kinds.includes(k));

  const decisions: SyncDecision[] = [];
  const operations: SyncPlannedOperation[] = [];

  let planRisk: SyncRiskLevel = "LOW";
  let hasBlocker = false;
  let hasReviewRequired = false;

  // Evaluate listing readiness for update operations using explicit finite policy
  let listingPrerequisiteBlocked = false;
  let listingPrerequisiteBlockReason = "";
  let listingReviewRequired = false;

  if (!listing.exists) {
    listingPrerequisiteBlocked = true;
    listingPrerequisiteBlockReason = "Cannot update price or inventory because no marketplace listing exists for this source product.";
    decisions.push({
      code: "LISTING_NOT_FOUND",
      message: listingPrerequisiteBlockReason,
      risk: "HIGH",
    });
    planRisk = maxRiskLevel(planRisk, "HIGH");
    hasBlocker = true;
  } else if (!listing.remoteListingId || listing.remoteListingId.trim().length === 0) {
    listingPrerequisiteBlocked = true;
    listingPrerequisiteBlockReason = "Marketplace listing exists locally but lacks an authoritative remoteListingId; update operations are blocked.";
    decisions.push({
      code: "REMOTE_LISTING_ID_REQUIRED",
      message: listingPrerequisiteBlockReason,
      risk: "HIGH",
    });
    planRisk = maxRiskLevel(planRisk, "HIGH");
    hasBlocker = true;
  } else if (listing.status === undefined) {
    listingPrerequisiteBlocked = true;
    listingPrerequisiteBlockReason = "Marketplace listing exists locally but listing status is absent; update operations are blocked.";
    decisions.push({
      code: "LISTING_STATUS_REQUIRED",
      message: listingPrerequisiteBlockReason,
      risk: "HIGH",
    });
    planRisk = maxRiskLevel(planRisk, "HIGH");
    hasBlocker = true;
  } else if (BLOCKED_LISTING_STATUSES.has(listing.status)) {
    listingPrerequisiteBlocked = true;
    listingPrerequisiteBlockReason = `Marketplace listing is in an ineligible, blocked, or in-flight state ('${listing.status}'); sync updates are blocked.`;
    decisions.push({
      code: "LISTING_BLOCKED",
      message: listingPrerequisiteBlockReason,
      risk: "HIGH",
    });
    planRisk = maxRiskLevel(planRisk, "HIGH");
    hasBlocker = true;
  } else if (REVIEW_REQUIRED_LISTING_STATUSES.has(listing.status)) {
    listingReviewRequired = true;
    decisions.push({
      code: "LISTING_REVIEW_REQUIRED",
      message: `Marketplace listing is in '${listing.status}' state; update operations require review approval.`,
      risk: "MEDIUM",
    });
    planRisk = maxRiskLevel(planRisk, "MEDIUM");
    hasReviewRequired = true;
  } else if (UPDATE_CAPABLE_LISTING_STATUSES.has(listing.status)) {
    // Explicitly update-capable: PUBLISHED or VERIFIED
  }

  // Evaluate each normalized change kind
  for (const kind of normalizedKinds) {
    switch (kind) {
      case "PRICE_CHANGED": {
        const baseOperationKey = generateSyncBaseOperationKey({
          marketplace,
          sellerAccountKey,
          source,
          sourceProductId,
          operationType: "UPDATE_PRICE",
        });
        const idempotencyKey = generateSyncOperationIdempotencyKey({
          marketplace,
          sellerAccountKey,
          source,
          sourceProductId,
          operationType: "UPDATE_PRICE",
          sourceSnapshotId,
        });

        if (listingPrerequisiteBlocked) {
          operations.push({
            operationType: "UPDATE_PRICE",
            marketplace,
            sellerAccountKey,
            source,
            sourceProductId,
            baseOperationKey,
            idempotencyKey,
            eligibility: "BLOCKED",
            reason: listingPrerequisiteBlockReason,
          });
        } else if (listingReviewRequired) {
          operations.push({
            operationType: "UPDATE_PRICE",
            marketplace,
            sellerAccountKey,
            source,
            sourceProductId,
            baseOperationKey,
            idempotencyKey,
            eligibility: "REQUIRES_REVIEW",
            reason: "Listing status requires review approval before applying price update.",
          });
        } else {
          operations.push({
            operationType: "UPDATE_PRICE",
            marketplace,
            sellerAccountKey,
            source,
            sourceProductId,
            baseOperationKey,
            idempotencyKey,
            eligibility: "ELIGIBLE",
            reason: "Source price change detected; ready for marketplace update.",
          });
        }

        decisions.push({
          code: "PRICE_CHANGE_DETECTED",
          message: "Source price change detected; planned UPDATE_PRICE operation for marketplace listing.",
          risk: "LOW",
          changeKind: "PRICE_CHANGED",
          operationType: "UPDATE_PRICE",
        });
        planRisk = maxRiskLevel(planRisk, "LOW");
        break;
      }

      case "INVENTORY_CHANGED": {
        const baseOperationKey = generateSyncBaseOperationKey({
          marketplace,
          sellerAccountKey,
          source,
          sourceProductId,
          operationType: "UPDATE_STOCK",
        });
        const idempotencyKey = generateSyncOperationIdempotencyKey({
          marketplace,
          sellerAccountKey,
          source,
          sourceProductId,
          operationType: "UPDATE_STOCK",
          sourceSnapshotId,
        });

        if (gates.inventory === "BLOCKED") {
          hasBlocker = true;
          planRisk = maxRiskLevel(planRisk, "HIGH");

          operations.push({
            operationType: "UPDATE_STOCK",
            marketplace,
            sellerAccountKey,
            source,
            sourceProductId,
            baseOperationKey,
            idempotencyKey,
            eligibility: "BLOCKED",
            reason: "Source inventory change blocked by safety policy.",
          });

          decisions.push({
            code: "INVENTORY_POLICY_BLOCKED",
            message: "Source inventory change is blocked by inventory safety policy (e.g. unverified/disclosed stock block).",
            risk: "HIGH",
            changeKind: "INVENTORY_CHANGED",
            operationType: "UPDATE_STOCK",
          });
        } else if (gates.inventory === "NEEDS_REVIEW") {
          hasReviewRequired = true;
          planRisk = maxRiskLevel(planRisk, "MEDIUM");

          operations.push({
            operationType: "UPDATE_STOCK",
            marketplace,
            sellerAccountKey,
            source,
            sourceProductId,
            baseOperationKey,
            idempotencyKey,
            eligibility: "REQUIRES_REVIEW",
            reason: "Source inventory change requires policy review or operator resolution before synchronization.",
          });

          decisions.push({
            code: "INVENTORY_RESOLUTION_REQUIRED",
            message: "Source inventory change requires policy review or operator resolution before synchronization.",
            risk: "MEDIUM",
            changeKind: "INVENTORY_CHANGED",
            operationType: "UPDATE_STOCK",
          });
        } else if (gates.inventory === "RESOLVED") {
          if (listingPrerequisiteBlocked) {
            operations.push({
              operationType: "UPDATE_STOCK",
              marketplace,
              sellerAccountKey,
              source,
              sourceProductId,
              baseOperationKey,
              idempotencyKey,
              eligibility: "BLOCKED",
              reason: listingPrerequisiteBlockReason,
            });
          } else if (listingReviewRequired) {
            operations.push({
              operationType: "UPDATE_STOCK",
              marketplace,
              sellerAccountKey,
              source,
              sourceProductId,
              baseOperationKey,
              idempotencyKey,
              eligibility: "REQUIRES_REVIEW",
              reason: "Listing status requires review approval before applying stock update.",
            });
          } else {
            operations.push({
              operationType: "UPDATE_STOCK",
              marketplace,
              sellerAccountKey,
              source,
              sourceProductId,
              baseOperationKey,
              idempotencyKey,
              eligibility: "ELIGIBLE",
              reason: "Source inventory change detected and resolved by inventory policy; ready for marketplace update.",
            });
          }

          decisions.push({
            code: "INVENTORY_CHANGE_DETECTED",
            message: "Source inventory change detected and resolved by inventory policy; planned UPDATE_STOCK operation.",
            risk: "LOW",
            changeKind: "INVENTORY_CHANGED",
            operationType: "UPDATE_STOCK",
          });
          planRisk = maxRiskLevel(planRisk, "LOW");
        }
        break;
      }

      case "CONTENT_CHANGED": {
        // Content changes require human review and protect seller-owned custom content.
        // Strictly no content-update marketplace operation is produced.
        hasReviewRequired = true;
        planRisk = maxRiskLevel(planRisk, "MEDIUM");

        decisions.push({
          code: "CONTENT_CHANGE_REQUIRES_REVIEW",
          message: "A source content-group change was detected; destination modifications require human review before marketplace application.",
          risk: "MEDIUM",
          changeKind: "CONTENT_CHANGED",
        });

        decisions.push({
          code: "SELLER_OWNED_FIELD_PROTECTED",
          message: "A source content-group change was detected; seller-owned destination customizations (e.g. marketing title, custom description) remain protected from automatic source overwrite.",
          risk: "MEDIUM",
          changeKind: "CONTENT_CHANGED",
        });
        break;
      }

      case "VARIANTS_CHANGED": {
        // Structural variant modifications require human review.
        // Strictly no variant-update marketplace operation is produced.
        hasReviewRequired = true;
        planRisk = maxRiskLevel(planRisk, "HIGH");

        decisions.push({
          code: "VARIANT_STRUCTURE_CHANGE_REQUIRES_REVIEW",
          message: "Source variant definition changed (e.g. SKU membership, attributes, weight, volume, preorder, or images); destination variant matrix modifications require human review.",
          risk: "HIGH",
          changeKind: "VARIANTS_CHANGED",
        });
        break;
      }
    }
  }

  // If multiple change kinds were detected, record a summary decision
  if (normalizedKinds.length > 1) {
    decisions.push({
      code: "MULTIPLE_CHANGES_DETECTED",
      message: `Multiple semantic change dimensions detected across source snapshot: [${normalizedKinds.join(", ")}].`,
      risk: planRisk,
    });
  }

  // Precedence resolution: BLOCKED > NEEDS_REVIEW > READY > NO_ACTION
  let status: SyncPlanStatus;
  if (hasBlocker) {
    status = "BLOCKED";
  } else if (hasReviewRequired) {
    status = "NEEDS_REVIEW";
  } else if (operations.length > 0) {
    status = "READY";
  } else {
    status = "NO_ACTION";
  }

  // Atomic safety enforcement:
  // - If overall plan is BLOCKED, every planned operation eligibility is BLOCKED.
  // - If overall plan is NEEDS_REVIEW, any otherwise ELIGIBLE operation becomes REQUIRES_REVIEW.
  if (status === "BLOCKED") {
    for (const op of operations) {
      op.eligibility = "BLOCKED";
      if (!op.reason.includes("(execution withheld: overall plan is BLOCKED)")) {
        op.reason += " (execution withheld: overall plan is BLOCKED)";
      }
    }
  } else if (status === "NEEDS_REVIEW") {
    for (const op of operations) {
      if (op.eligibility === "ELIGIBLE") {
        op.eligibility = "REQUIRES_REVIEW";
        op.reason += " (execution withheld: overall plan requires review)";
      }
    }
  }

  // Deterministic operation ordering: CREATE_LISTING -> UPDATE_PRICE -> UPDATE_STOCK
  const OP_ORDER: Record<string, number> = {
    CREATE_LISTING: 1,
    UPDATE_PRICE: 2,
    UPDATE_STOCK: 3,
  };
  operations.sort((a, b) => (OP_ORDER[a.operationType] ?? 99) - (OP_ORDER[b.operationType] ?? 99));

  return {
    status,
    operations,
    decisions,
    requiresReview: hasReviewRequired,
    blocked: hasBlocker,
    risk: planRisk,
  };
}
