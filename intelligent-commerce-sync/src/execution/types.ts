import type { SyncJobType } from "../persistence/types.js";
import type { SyncOperationType, SyncPlannedOperation } from "../sync/types.js";

/**
 * Finite discriminated union representing inventory resolution state in durable payloads.
 * Strictly distinguishes resolved inventory from unexecutable review/blocked states without fabricating 0.
 */
export type DurableInventoryTarget =
  | {
      resolution: "RESOLVED";
      targetQuantity: number;
    }
  | {
      resolution: "NEEDS_REVIEW";
    }
  | {
      resolution: "BLOCKED";
    };

/**
 * Base identity and metadata for all durable execution payloads.
 * Represents a frozen snapshot of destination intent that survives server restarts.
 */
export interface DurableExecutionPayloadBase {
  schemaVersion: 1;
  operationType: SyncOperationType;
  source: string;
  sourceProductId: string;
  sourceSnapshotId: string;
  marketplace: string;
  sellerAccountKey: string;
}

/**
 * Variant payload preserved within a CREATE_LISTING durable execution payload.
 */
export interface CreateListingVariantPayload {
  sourceSkuId: string;
  destinationSku: string;
  attributes: Record<string, string>;
  targetPriceIdr: number;
  inventory: DurableInventoryTarget;
}

/**
 * Durable execution payload for CREATE_LISTING.
 * Encapsulates the prepared listing draft parameters without
 * requiring re-evaluation of environment pricing/inventory policies after restart.
 * Strictly contains NO credentials, authentication tokens, or invented wire payloads.
 */
export interface CreateListingExecutionPayload extends DurableExecutionPayloadBase {
  operationType: "CREATE_LISTING";
  preparedTitle: string;
  preparedDescription: string;
  targetCategoryId?: string | undefined;
  targetCategoryName?: string | undefined;
  brand?: string | undefined;
  totalWeightGrams?: number | undefined;
  images: Array<{ url: string; position?: number | undefined }>;
  variants: CreateListingVariantPayload[];
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Single variant item for UPDATE_PRICE execution.
 */
export interface UpdatePriceVariantItem {
  sourceSkuId: string;
  targetPriceIdr: number;
}

/**
 * Durable execution payload for UPDATE_PRICE.
 * Preserves the exact target prices per variant.
 * remoteListingId may be absent in BLOCKED/REVIEW intent, but is mandatory when ELIGIBLE for execution.
 */
export interface UpdatePriceExecutionPayload extends DurableExecutionPayloadBase {
  operationType: "UPDATE_PRICE";
  remoteListingId?: string | undefined;
  variants: UpdatePriceVariantItem[];
}

/**
 * Single variant item for UPDATE_STOCK execution.
 */
export interface UpdateStockVariantItem {
  sourceSkuId: string;
  inventory: DurableInventoryTarget;
}

/**
 * Durable execution payload for UPDATE_STOCK.
 * Preserves the exact resolved destination inventory quantities or explicit review/block state.
 * remoteListingId may be absent in BLOCKED/REVIEW intent, but is mandatory when ELIGIBLE for execution.
 */
export interface UpdateStockExecutionPayload extends DurableExecutionPayloadBase {
  operationType: "UPDATE_STOCK";
  remoteListingId?: string | undefined;
  variants: UpdateStockVariantItem[];
}

/**
 * Discriminated union of all supported durable marketplace execution payloads.
 */
export type DurableExecutionPayload =
  | CreateListingExecutionPayload
  | UpdatePriceExecutionPayload
  | UpdateStockExecutionPayload;

/**
 * Parameters for resolving the marketplace listing target of a review/blocked update job.
 */
export interface ResolveReviewExecutionTargetParams {
  syncJobId: string;
  marketplaceListingId: string;
  reviewedBy?: string | undefined;
  notes?: string | undefined;
}

/**
 * Pure mapping helper converting exact SyncOperationType to broader operational SyncJobType.
 * NOTE: jobType is NOT authoritative for marketplace operation identity; operationType is authoritative.
 */
export function mapSyncOperationTypeToJobType(
  operationType: SyncOperationType
): SyncJobType {
  switch (operationType) {
    case "CREATE_LISTING":
      return "FULL_SYNC";
    case "UPDATE_PRICE":
      return "PRICE_UPDATE";
    case "UPDATE_STOCK":
      return "STOCK_UPDATE";
    default: {
      const _exhaustive: never = operationType;
      throw new Error(`Unhandled SyncOperationType: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Validates whether a planned operation's execution eligibility aligns with the provided payload.
 * When operation.eligibility === 'ELIGIBLE', requires all execution-readiness prerequisites.
 * When operation.eligibility === 'REQUIRES_REVIEW' or 'BLOCKED', allows unresolved intent to be stored durably.
 */
export function assertPayloadExecutionEligibility(
  operation: SyncPlannedOperation,
  payload: DurableExecutionPayload,
  marketplaceListingId?: string | undefined
): void {
  if (operation.eligibility === "ELIGIBLE") {
    if (payload.operationType === "UPDATE_PRICE" || payload.operationType === "UPDATE_STOCK") {
      if (!marketplaceListingId || marketplaceListingId.trim().length === 0) {
        throw new DurableExecutionIdentityError(
          `marketplaceListingId is required for ELIGIBLE ${payload.operationType} durable sync job.`
        );
      }
      if (!payload.remoteListingId || payload.remoteListingId.trim().length === 0) {
        throw new DurablePayloadValidationError(
          `remoteListingId is required for ELIGIBLE ${payload.operationType} payload.`
        );
      }
    }

    if (payload.operationType === "UPDATE_STOCK") {
      for (const v of payload.variants) {
        if (v.inventory.resolution !== "RESOLVED") {
          throw new DurablePayloadValidationError(
            `ELIGIBLE UPDATE_STOCK payload requires every variant inventory to be RESOLVED (found '${v.inventory.resolution}' for SKU '${v.sourceSkuId}').`
          );
        }
      }
    }
  }
}

/**
 * Pure validation helper verifying whether a durable payload meets all criteria to safely become executable.
 * Does not perform database transitions. Reused before transitions to PENDING or enqueue.
 */
export function assertDurablePayloadReadyForExecution(
  payload: DurableExecutionPayload
): void {
  switch (payload.operationType) {
    case "CREATE_LISTING": {
      if (!payload.targetCategoryId || payload.targetCategoryId.trim().length === 0) {
        throw new DurablePayloadValidationError("CREATE_LISTING execution requires a resolved targetCategoryId.");
      }
      if (!payload.images || payload.images.length === 0) {
        throw new DurablePayloadValidationError("CREATE_LISTING execution requires at least one image.");
      }
      if (!payload.variants || payload.variants.length === 0) {
        throw new DurablePayloadValidationError("CREATE_LISTING execution requires at least one variant.");
      }
      for (const variant of payload.variants) {
        if (!variant.targetPriceIdr || variant.targetPriceIdr <= 0) {
          throw new DurablePayloadValidationError(
            `CREATE_LISTING variant '${variant.sourceSkuId}' has invalid targetPriceIdr: ${variant.targetPriceIdr}.`
          );
        }
        if (variant.inventory.resolution !== "RESOLVED") {
          throw new DurablePayloadValidationError(
            `CREATE_LISTING variant '${variant.sourceSkuId}' inventory is not RESOLVED (found '${variant.inventory.resolution}').`
          );
        }
      }
      break;
    }
    case "UPDATE_PRICE": {
      if (!payload.remoteListingId || payload.remoteListingId.trim().length === 0) {
        throw new DurablePayloadValidationError("UPDATE_PRICE execution requires a valid remoteListingId.");
      }
      if (!payload.variants || payload.variants.length === 0) {
        throw new DurablePayloadValidationError("UPDATE_PRICE execution requires at least one variant.");
      }
      for (const variant of payload.variants) {
        if (!variant.targetPriceIdr || variant.targetPriceIdr <= 0) {
          throw new DurablePayloadValidationError(
            `UPDATE_PRICE variant '${variant.sourceSkuId}' has invalid targetPriceIdr: ${variant.targetPriceIdr}.`
          );
        }
      }
      break;
    }
    case "UPDATE_STOCK": {
      if (!payload.remoteListingId || payload.remoteListingId.trim().length === 0) {
        throw new DurablePayloadValidationError("UPDATE_STOCK execution requires a valid remoteListingId.");
      }
      if (!payload.variants || payload.variants.length === 0) {
        throw new DurablePayloadValidationError("UPDATE_STOCK execution requires at least one variant.");
      }
      for (const variant of payload.variants) {
        if (variant.inventory.resolution !== "RESOLVED") {
          throw new DurablePayloadValidationError(
            `UPDATE_STOCK variant '${variant.sourceSkuId}' inventory is not RESOLVED (found '${variant.inventory.resolution}').`
          );
        }
      }
      break;
    }
    default: {
      const _exhaustive: never = payload;
      throw new Error(`Unhandled operationType: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Error thrown when a durable execution payload violates schema or semantic invariants.
 */
export class DurablePayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurablePayloadValidationError";
  }
}

/**
 * Error thrown when persisted database identity references (ProductSource, SourceSnapshot, MarketplaceListing)
 * do not match the execution payload or domain invariants.
 */
export class DurableExecutionIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableExecutionIdentityError";
  }
}

/**
 * Error thrown when an illegal modification to an immutable execution payload is attempted.
 */
export class PayloadImmutabilityViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadImmutabilityViolationError";
  }
}
