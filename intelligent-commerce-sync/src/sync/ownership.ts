import type { FieldOwner } from "./types.js";

/**
 * Objective source-owned fields derived directly from supplier state (e.g. JakMall).
 * The synchronization system updates internal representations of these fields from source snapshots.
 */
export type SourceFieldArea =
  | "SOURCE_PRICE"
  | "SOURCE_INVENTORY"
  | "SOURCE_VARIANTS"
  | "SOURCE_WEIGHT"
  | "SOURCE_IMAGES";

/**
 * System-owned calculation parameters, policies, and mappings.
 * Calculated deterministically by internal business logic and configuration.
 */
export type SystemFieldArea =
  | "SELLING_PRICE"
  | "MARKUP_POLICY"
  | "SAFETY_STOCK"
  | "CATEGORY_MAPPING"
  | "ATTRIBUTE_MAPPING"
  | "SYNC_POLICY"
  | "RISK_DECISION";

/**
 * Seller-owned marketplace fields customized by the merchant/store operator.
 * Source synchronization is STRICTLY FORBIDDEN from automatically overwriting these fields.
 */
export type SellerFieldArea =
  | "MARKETING_TITLE"
  | "CUSTOM_DESCRIPTION"
  | "MANUAL_CATEGORY_OVERRIDE"
  | "PROMOTIONAL_CONTENT"
  | "SELLER_METADATA";

/**
 * Union of all managed field areas across the product synchronization lifecycle.
 */
export type ManagedFieldArea = SourceFieldArea | SystemFieldArea | SellerFieldArea;

const SOURCE_FIELDS: ReadonlySet<ManagedFieldArea> = new Set<SourceFieldArea>([
  "SOURCE_PRICE",
  "SOURCE_INVENTORY",
  "SOURCE_VARIANTS",
  "SOURCE_WEIGHT",
  "SOURCE_IMAGES",
]);

const SYSTEM_FIELDS: ReadonlySet<ManagedFieldArea> = new Set<SystemFieldArea>([
  "SELLING_PRICE",
  "MARKUP_POLICY",
  "SAFETY_STOCK",
  "CATEGORY_MAPPING",
  "ATTRIBUTE_MAPPING",
  "SYNC_POLICY",
  "RISK_DECISION",
]);

const SELLER_FIELDS: ReadonlySet<ManagedFieldArea> = new Set<SellerFieldArea>([
  "MARKETING_TITLE",
  "CUSTOM_DESCRIPTION",
  "MANUAL_CATEGORY_OVERRIDE",
  "PROMOTIONAL_CONTENT",
  "SELLER_METADATA",
]);

/**
 * Returns the authoritative ownership domain for a given field area.
 */
export function getFieldOwner(area: ManagedFieldArea): FieldOwner {
  if (SELLER_FIELDS.has(area)) {
    return "SELLER";
  }
  if (SYSTEM_FIELDS.has(area)) {
    return "SYSTEM";
  }
  if (SOURCE_FIELDS.has(area)) {
    return "SOURCE";
  }
  throw new Error(`Unknown field area: ${String(area)}`);
}

/**
 * Checks whether an area is owned and managed by the seller/merchant.
 */
export function isSellerOwned(area: ManagedFieldArea): boolean {
  return SELLER_FIELDS.has(area);
}

/**
 * Determines whether automatic source synchronization is allowed to overwrite a given field area.
 * - SOURCE-owned price and inventory fields may be synced automatically when resolved.
 * - SYSTEM-owned fields are internally calculated or policy-driven.
 * - SELLER-owned fields must NEVER be automatically overwritten by source synchronization.
 */
export function isAutoSyncAllowed(area: ManagedFieldArea): boolean {
  const owner = getFieldOwner(area);
  if (owner === "SELLER") {
    return false;
  }
  if (owner === "SYSTEM") {
    return false;
  }
  // For SOURCE-owned fields, price and inventory updates can be automated;
  // structural variant and media changes require gated review.
  return area === "SOURCE_PRICE" || area === "SOURCE_INVENTORY";
}

export interface SellerFieldProtection {
  owner: "SELLER";
  autoSyncAllowed: false;
  protectionReason: string;
}

/**
 * Returns protection metadata for a seller-owned field area.
 */
export function protectSellerField(area: SellerFieldArea): SellerFieldProtection {
  return {
    owner: "SELLER",
    autoSyncAllowed: false,
    protectionReason: `Field area '${area}' is owned by the seller and protected from automatic source overwrite.`,
  };
}
