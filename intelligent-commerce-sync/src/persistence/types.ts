/**
 * Deterministic cryptographic hash breakdown for a CanonicalProduct snapshot.
 * Each hash captures a distinct semantic dimension of the source product,
 * allowing granular change detection (e.g. price change vs inventory change).
 */
export interface SourceSnapshotHashes {
  /** Combined aggregate hash of source identity and all group hashes */
  sourceHash: string;
  /** Hash of descriptive/content fields (title, description, brand, category, specs, seller, images) */
  contentHash: string;
  /** Hash of normalized variant prices (sourceSkuId, list, normal, final) */
  priceHash: string;
  /** Hash of normalized variant inventories (sourceSkuId, available, exact, quantity, status) */
  inventoryHash: string;
  /** Hash of variant identity, attributes, and non-price/non-inventory definition (SKUs, attributes, weight, volume, preorder, images) */
  variantHash: string;
}

/**
 * Granular classification kinds for detected source changes.
 */
export type SnapshotChangeKind =
  | "PRICE_CHANGED"
  | "INVENTORY_CHANGED"
  | "CONTENT_CHANGED"
  | "VARIANTS_CHANGED";

/**
 * Top-level classification outcome of comparing two source snapshots.
 */
export type SnapshotDiffClassification =
  | "FIRST_SNAPSHOT"
  | "NO_CHANGE"
  | "PRICE_CHANGED"
  | "INVENTORY_CHANGED"
  | "CONTENT_CHANGED"
  | "VARIANTS_CHANGED"
  | "MULTIPLE_CHANGED";

/**
 * Result of comparing an existing source snapshot with a newly captured snapshot.
 */
export interface SnapshotDiffResult {
  /** Top-level diff classification */
  classification: SnapshotDiffClassification;
  /** True when a semantic change was detected between the snapshots */
  changed: boolean;
  /** List of distinct change kinds detected (empty if NO_CHANGE or FIRST_SNAPSHOT) */
  kinds: SnapshotChangeKind[];
  /** Detailed field group names that changed */
  fields: string[];
  /** Previous snapshot hashes (undefined for FIRST_SNAPSHOT) */
  oldHashes?: SourceSnapshotHashes | undefined;
  /** Newly computed snapshot hashes */
  newHashes: SourceSnapshotHashes;
}

/**
 * Durable execution statuses for synchronization jobs.
 */
export type SyncJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "CANCELLED";

/**
 * Supported synchronization job intent types.
 */
export type SyncJobType =
  | "SOURCE_SYNC"
  | "PRICE_UPDATE"
  | "STOCK_UPDATE"
  | "CONTENT_UPDATE"
  | "FULL_SYNC";

/**
 * Append-only operational event types emitted during synchronization.
 */
export type SyncEventType =
  | "SOURCE_CAPTURED"
  | "NO_CHANGE"
  | "PRICE_CHANGED"
  | "INVENTORY_CHANGED"
  | "CONTENT_CHANGED"
  | "VARIANTS_CHANGED"
  | "MULTIPLE_CHANGED"
  | "SYNC_PLANNED"
  | "SYNC_BLOCKED"
  | "SYNC_COMPLETED"
  | "SYNC_FAILED"
  | "VERIFY_MISMATCH";

/**
 * Status of an operation-level idempotency record.
 */
export type IdempotencyStatus = "STARTED" | "COMPLETED" | "FAILED";

/**
 * In-memory / domain representation of an idempotency record.
 */
export interface IdempotencyRecordPayload {
  key: string;
  operationType: string;
  status: IdempotencyStatus;
  marketplace?: string | undefined;
  sellerAccountKey?: string | undefined;
  productSourceId?: string | undefined;
  syncJobId?: string | undefined;
  result?: Record<string, unknown> | undefined;
  createdAt: Date;
  completedAt?: Date | undefined;
}
