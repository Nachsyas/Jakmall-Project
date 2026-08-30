import { createHash } from "node:crypto";
import type { CanonicalProduct, CanonicalVariant } from "../canonical/types.js";
import { stableSerialize } from "./stable-serialize.js";
import type { SourceSnapshotHashes } from "./types.js";

/**
 * Deterministic lexical comparator for source SKU IDs.
 * Does not depend on host locale or collation rules.
 */
function compareBySkuId<T extends { sourceSkuId: string }>(a: T, b: T): number {
  if (a.sourceSkuId < b.sourceSkuId) return -1;
  if (a.sourceSkuId > b.sourceSkuId) return 1;
  return 0;
}

/**
 * Computes SHA-256 hexadecimal hash string using deterministic stable serialization.
 */
export function sha256Hex(value: unknown): string {
  const serialized = stableSerialize(value);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * Computes deterministic contentHash representing source-owned descriptive/editorial fields.
 * Excludes fetchedAt and transient parser metadata.
 */
export function computeContentHash(canonical: CanonicalProduct): string {
  const contentPayload = {
    brand: canonical.brand ?? null,
    categoryPath: canonical.categoryPath,
    description: canonical.description,
    images: canonical.images.map((img) => ({
      position: img.position ?? null,
      sourceUrl: img.sourceUrl,
      url: img.url,
    })),
    seller: {
      id: canonical.seller.id ?? null,
      name: canonical.seller.name,
    },
    specifications: canonical.specifications,
    title: canonical.title,
  };

  return sha256Hex(contentPayload);
}

/**
 * Computes deterministic priceHash across all variants.
 * Variants are sorted lexically by sourceSkuId to ensure invariant order.
 */
export function computePriceHash(variants: readonly CanonicalVariant[]): string {
  const sortedVariants = [...variants].sort(compareBySkuId);

  const pricePayload = sortedVariants.map((v) => ({
    sourceSkuId: v.sourceSkuId,
    price: {
      final: v.price.final,
      list: v.price.list ?? null,
      normal: v.price.normal ?? null,
    },
  }));

  return sha256Hex(pricePayload);
}

/**
 * Computes deterministic inventoryHash across all variants.
 * Variants are sorted lexically by sourceSkuId to ensure invariant order.
 * Strictly preserves distinctions between 0 and null/undefined.
 */
export function computeInventoryHash(variants: readonly CanonicalVariant[]): string {
  const sortedVariants = [...variants].sort(compareBySkuId);

  const inventoryPayload = sortedVariants.map((v) => ({
    sourceSkuId: v.sourceSkuId,
    inventory: {
      available: v.inventory.available,
      exact: v.inventory.exact,
      quantity: v.inventory.quantity ?? null,
      status: v.inventory.status ?? null,
    },
  }));

  return sha256Hex(inventoryPayload);
}

/**
 * Computes deterministic variantHash representing variant identity, attributes, and non-price/non-inventory definition.
 * Variants are sorted lexically by sourceSkuId.
 * Includes attributes, merchantSku, displaySku, weight, volume, preorder, and variant images.
 * Does NOT include price or inventory, ensuring price/stock changes do not produce VARIANTS_CHANGED.
 */
export function computeVariantHash(variants: readonly CanonicalVariant[]): string {
  const sortedVariants = [...variants].sort(compareBySkuId);

  const variantPayload = sortedVariants.map((v) => ({
    attributes: v.attributes,
    displaySku: v.displaySku ?? null,
    images: v.images.map((img) => ({
      position: img.position ?? null,
      sourceUrl: img.sourceUrl,
      url: img.url,
    })),
    merchantSku: v.merchantSku ?? null,
    preorder: v.preorder
      ? {
          enabled: v.preorder.enabled,
          estimatedShipDate: v.preorder.estimatedShipDate ?? null,
        }
      : null,
    sourceSkuId: v.sourceSkuId,
    volume: v.volume ?? null,
    weightGrams: v.weightGrams ?? null,
  }));

  return sha256Hex(variantPayload);
}

/**
 * Computes top-level composite sourceHash from identity and all sub-hashes.
 */
export function computeSourceHash(input: {
  source: string;
  sourceProductId: string;
  contentHash: string;
  priceHash: string;
  inventoryHash: string;
  variantHash: string;
}): string {
  const compositePayload = {
    contentHash: input.contentHash,
    inventoryHash: input.inventoryHash,
    priceHash: input.priceHash,
    source: input.source,
    sourceProductId: input.sourceProductId,
    variantHash: input.variantHash,
  };

  return sha256Hex(compositePayload);
}

/**
 * Computes complete SourceSnapshotHashes for a CanonicalProduct.
 * Guarantees zero mutation of the input CanonicalProduct.
 */
export function computeSnapshotHashes(canonical: CanonicalProduct): SourceSnapshotHashes {
  const contentHash = computeContentHash(canonical);
  const priceHash = computePriceHash(canonical.variants);
  const inventoryHash = computeInventoryHash(canonical.variants);
  const variantHash = computeVariantHash(canonical.variants);

  const sourceHash = computeSourceHash({
    contentHash,
    inventoryHash,
    priceHash,
    source: canonical.source,
    sourceProductId: canonical.sourceProductId,
    variantHash,
  });

  return {
    contentHash,
    inventoryHash,
    priceHash,
    sourceHash,
    variantHash,
  };
}
