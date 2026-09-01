import { formatIdempotencyKey, type MarketplaceIdempotencyKey } from "../marketplace/types.js";
import { type SyncOperationType, SyncIdempotencyKeyInputError } from "./types.js";

export interface GenerateSyncIdempotencyKeyParams {
  marketplace: string;
  sellerAccountKey: string;
  source: string;
  sourceProductId: string;
  operationType: SyncOperationType;
  sourceSnapshotId?: string | undefined;
}

const VALID_OPERATION_TYPES: ReadonlySet<string> = new Set<SyncOperationType>([
  "CREATE_LISTING",
  "UPDATE_PRICE",
  "UPDATE_STOCK",
]);

/**
 * Validates a component string to ensure it is non-empty and contains no ':' delimiter.
 */
export function validateKeyComponent(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyncIdempotencyKeyInputError(
      `Idempotency key component '${name}' must be a non-empty string.`
    );
  }
  if (value.includes(":")) {
    throw new SyncIdempotencyKeyInputError(
      `Idempotency key component '${name}' must not contain separator ':' (received: '${value}').`
    );
  }
  return value;
}

/**
 * Formats the product-level Phase 3-compatible base operation key:
 * marketplace:sellerAccountKey:source:sourceProductId:operationType
 */
export function generateSyncBaseOperationKey(
  params: Omit<GenerateSyncIdempotencyKeyParams, "sourceSnapshotId">
): string {
  if (!params || typeof params !== "object") {
    throw new SyncIdempotencyKeyInputError("Params must be a valid non-null object.");
  }

  const marketplace = validateKeyComponent("marketplace", params.marketplace);
  const sellerAccount = validateKeyComponent("sellerAccountKey", params.sellerAccountKey);
  const source = validateKeyComponent("source", params.source);
  const sourceProductId = validateKeyComponent("sourceProductId", params.sourceProductId);

  if (!VALID_OPERATION_TYPES.has(params.operationType)) {
    throw new SyncIdempotencyKeyInputError(
      `Invalid operationType for idempotency key: '${String(params.operationType)}'.`
    );
  }

  const marketplaceKey: MarketplaceIdempotencyKey = {
    marketplace,
    sellerAccount,
    source,
    sourceProductId,
    operationType: params.operationType,
  };
  return formatIdempotencyKey(marketplaceKey);
}

/**
 * Generates a deterministic idempotency key for a planned sync operation.
 * - CREATE_LISTING: returns product-scoped base key (marketplace:seller:source:productId:CREATE_LISTING).
 * - UPDATE_PRICE / UPDATE_STOCK: returns snapshot-scoped key (<baseKey>:<sourceSnapshotId>).
 * Strictly contains NO timestamps, random values, or non-deterministic components.
 */
export function generateSyncOperationIdempotencyKey(
  params: GenerateSyncIdempotencyKeyParams
): string {
  const baseKey = generateSyncBaseOperationKey(params);

  if (params.operationType === "CREATE_LISTING") {
    if (params.sourceSnapshotId !== undefined && params.sourceSnapshotId !== null) {
      validateKeyComponent("sourceSnapshotId", params.sourceSnapshotId);
    }
    return baseKey;
  }

  // UPDATE_PRICE and UPDATE_STOCK require sourceSnapshotId
  const snapshotId = validateKeyComponent("sourceSnapshotId", params.sourceSnapshotId);
  return `${baseKey}:${snapshotId}`;
}
