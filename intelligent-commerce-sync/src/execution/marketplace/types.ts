import type { DurableInventoryTarget } from "../types.js";

/**
 * INTERNAL NORMALIZED EXECUTION CONTRACT
 *
 * NOTE: This is an internal normalized contract for marketplace mutation commands,
 * read-after-write verification states, and result types within the execution coordinator.
 * It is strictly NOT an official Shopee wire API model.
 * Contains NO credentials, tokens, headers, cookies, or guessed remote wire signatures.
 */

export interface CreateListingVariantCommandItem {
  sourceSkuId: string;
  destinationSku: string;
  attributes: Record<string, string>;
  targetPriceIdr: number;
  targetQuantity: number;
}

export interface CreateListingCommand {
  schemaVersion: 1;
  operationType: "CREATE_LISTING";
  marketplace: string;
  sellerAccountKey: string;
  idempotencyKey: string;
  sourceProductId: string;
  preparedTitle: string;
  preparedDescription: string;
  targetCategoryId: string;
  targetCategoryName?: string | undefined;
  brand?: string | undefined;
  totalWeightGrams?: number | undefined;
  images: string[];
  variants: CreateListingVariantCommandItem[];
}

export interface UpdatePriceVariantCommandItem {
  sourceSkuId: string;
  destinationSku: string;
  remoteVariantId?: string | undefined;
  targetPriceIdr: number;
}

export interface UpdatePriceCommand {
  schemaVersion: 1;
  operationType: "UPDATE_PRICE";
  marketplace: string;
  sellerAccountKey: string;
  idempotencyKey: string;
  remoteListingId: string;
  variants: UpdatePriceVariantCommandItem[];
}

export interface UpdateStockVariantCommandItem {
  sourceSkuId: string;
  destinationSku: string;
  remoteVariantId?: string | undefined;
  targetQuantity: number;
}

export interface UpdateStockCommand {
  schemaVersion: 1;
  operationType: "UPDATE_STOCK";
  marketplace: string;
  sellerAccountKey: string;
  idempotencyKey: string;
  remoteListingId: string;
  variants: UpdateStockVariantCommandItem[];
}

export type NormalizedMarketplaceCommand =
  | CreateListingCommand
  | UpdatePriceCommand
  | UpdateStockCommand;

export interface CreateListingMutationResult {
  remoteListingId: string;
  variantMappings?: Array<{
    sourceSkuId: string;
    remoteVariantId: string;
  }> | undefined;
}

export interface MarketplaceMutationResult {
  success: boolean;
}

export interface NormalizedRemoteVariantState {
  destinationSku: string;
  remoteVariantId?: string | undefined;
  priceIdr: number;
  stock: number;
}

export interface NormalizedRemoteListingState {
  remoteListingId: string;
  title?: string | undefined;
  variants: NormalizedRemoteVariantState[];
}

export interface VerificationMismatch {
  field: string;
  sourceSkuId?: string | undefined;
  destinationSku?: string | undefined;
  expected: string | number;
  actual: string | number | null;
}

export interface VerificationResult {
  verified: boolean;
  mismatches: VerificationMismatch[];
}

export class MarketplaceExecutionError extends Error {
  readonly code: string;
  constructor(message: string, code = "MARKETPLACE_EXECUTION_ERROR") {
    super(message);
    this.name = "MarketplaceExecutionError";
    this.code = code;
  }
}

export class MarketplaceExecutionUnavailableError extends MarketplaceExecutionError {
  constructor(marketplace: string) {
    super(
      `Official/authorized marketplace execution transport for '${marketplace}' is not configured or unavailable.`,
      "MARKETPLACE_LIVE_PROTOCOL_UNAVAILABLE"
    );
    this.name = "MarketplaceExecutionUnavailableError";
  }
}

export class MarketplaceVerifyMismatchError extends MarketplaceExecutionError {
  readonly mismatches: VerificationMismatch[];
  constructor(message: string, mismatches: VerificationMismatch[]) {
    super(message, "MARKETPLACE_VERIFY_MISMATCH");
    this.name = "MarketplaceVerifyMismatchError";
    this.mismatches = mismatches;
  }
}

export class MarketplaceVerifyNotFoundError extends MarketplaceExecutionError {
  constructor(remoteListingId: string) {
    super(
      `Remote listing '${remoteListingId}' was not found during read-after-write verification.`,
      "MARKETPLACE_VERIFY_NOT_FOUND"
    );
    this.name = "MarketplaceVerifyNotFoundError";
  }
}

export class MarketplaceTargetIntegrityError extends MarketplaceExecutionError {
  constructor(message: string) {
    super(message, "MARKETPLACE_TARGET_INTEGRITY_ERROR");
    this.name = "MarketplaceTargetIntegrityError";
  }
}

/**
 * Fail-closed resolved inventory quantity extractor.
 * Guarantees legitimate RESOLVED targetQuantity (including 0) is extracted exactly.
 * Unresolved resolutions (NEEDS_REVIEW, BLOCKED, etc.) throw MarketplaceTargetIntegrityError and NEVER fall back to 0.
 */
export function extractResolvedTargetQuantity(
  inventory: DurableInventoryTarget,
  sourceSkuId?: string
): number {
  if (inventory.resolution !== "RESOLVED") {
    throw new MarketplaceTargetIntegrityError(
      `Execution requires RESOLVED inventory, but found '${inventory.resolution}'${
        sourceSkuId ? ` for SKU '${sourceSkuId}'` : ""
      }. Unresolved inventory cannot be converted to target quantity.`
    );
  }
  return inventory.targetQuantity;
}
