import type { CanonicalProduct } from "../canonical/types.js";
import { computeSnapshotHashes } from "./hash.js";
import type {
  SnapshotChangeKind,
  SnapshotDiffClassification,
  SnapshotDiffResult,
  SourceSnapshotHashes,
} from "./types.js";

/**
 * Thrown when attempting to diff two canonical products with different source identities.
 */
export class SnapshotIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIdentityMismatchError";
  }
}

/**
 * Thrown when snapshot group hashes and aggregate sourceHash are internally inconsistent.
 */
export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

/**
 * Compares two sets of snapshot hashes and returns deterministic change classification.
 * Pure domain logic: zero database or marketplace dependencies.
 */
export function diffSnapshotHashes(
  oldHashes: SourceSnapshotHashes | undefined | null,
  newHashes: SourceSnapshotHashes
): SnapshotDiffResult {
  // Case 1: First snapshot captured for this source product
  if (!oldHashes) {
    return {
      changed: true,
      classification: "FIRST_SNAPSHOT",
      fields: [],
      kinds: [],
      newHashes,
      oldHashes: undefined,
    };
  }

  const priceChanged = oldHashes.priceHash !== newHashes.priceHash;
  const inventoryChanged = oldHashes.inventoryHash !== newHashes.inventoryHash;
  const contentChanged = oldHashes.contentHash !== newHashes.contentHash;
  const variantChanged = oldHashes.variantHash !== newHashes.variantHash;
  const sourceChanged = oldHashes.sourceHash !== newHashes.sourceHash;

  const anyGroupChanged = priceChanged || inventoryChanged || contentChanged || variantChanged;

  // Integrity Check A: If all four group hashes match, sourceHash must also match
  if (!anyGroupChanged && sourceChanged) {
    throw new SnapshotIntegrityError(
      "Snapshot hash integrity violation: all component group hashes match, but sourceHash differs"
    );
  }

  // Integrity Check B: If one or more group hashes differ, sourceHash must also differ
  if (anyGroupChanged && !sourceChanged) {
    throw new SnapshotIntegrityError(
      "Snapshot hash integrity violation: component group hashes differ, but sourceHash is identical"
    );
  }

  const kinds: SnapshotChangeKind[] = [];
  const fields: string[] = [];

  if (priceChanged) {
    kinds.push("PRICE_CHANGED");
    fields.push("price");
  }

  if (inventoryChanged) {
    kinds.push("INVENTORY_CHANGED");
    fields.push("inventory");
  }

  if (contentChanged) {
    kinds.push("CONTENT_CHANGED");
    fields.push("content");
  }

  if (variantChanged) {
    kinds.push("VARIANTS_CHANGED");
    fields.push("variants");
  }

  let classification: SnapshotDiffClassification;
  let changed: boolean;

  if (kinds.length === 0) {
    classification = "NO_CHANGE";
    changed = false;
  } else if (kinds.length === 1) {
    const singleKind = kinds[0];
    if (singleKind === undefined) {
      classification = "NO_CHANGE";
      changed = false;
    } else {
      classification = singleKind;
      changed = true;
    }
  } else {
    classification = "MULTIPLE_CHANGED";
    changed = true;
  }

  return {
    changed,
    classification,
    fields,
    kinds,
    newHashes,
    oldHashes,
  };
}

/**
 * Convenience helper to compute hashes and diff two CanonicalProduct instances directly.
 * Verifies source identity integrity before computing diffs.
 */
export function diffCanonicalSnapshots(
  oldCanonical: CanonicalProduct | undefined | null,
  newCanonical: CanonicalProduct
): SnapshotDiffResult {
  if (oldCanonical) {
    if (
      oldCanonical.source !== newCanonical.source ||
      oldCanonical.sourceProductId !== newCanonical.sourceProductId
    ) {
      throw new SnapshotIdentityMismatchError(
        `Cannot diff snapshots of differing source identities: "${oldCanonical.source}:${oldCanonical.sourceProductId}" vs "${newCanonical.source}:${newCanonical.sourceProductId}"`
      );
    }
  }

  const oldHashes = oldCanonical ? computeSnapshotHashes(oldCanonical) : undefined;
  const newHashes = computeSnapshotHashes(newCanonical);
  return diffSnapshotHashes(oldHashes, newHashes);
}
