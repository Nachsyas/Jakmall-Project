import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CanonicalProduct } from "../src/canonical/types.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import {
  SnapshotIdentityMismatchError,
  SnapshotIntegrityError,
  diffCanonicalSnapshots,
  diffSnapshotHashes,
} from "../src/persistence/diff.js";
import { computeSnapshotHashes } from "../src/persistence/hash.js";
import type { SourceSnapshotHashes } from "../src/persistence/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

function loadAcmicCanonical(): CanonicalProduct {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);
  return normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );
}

test("diffSnapshotHashes reports FIRST_SNAPSHOT when oldHashes is undefined or null", () => {
  const canonical = loadAcmicCanonical();
  const hashes = computeSnapshotHashes(canonical);

  const result1 = diffSnapshotHashes(undefined, hashes);
  assert.equal(result1.classification, "FIRST_SNAPSHOT");
  assert.equal(result1.changed, true);
  assert.deepEqual(result1.kinds, []);
  assert.deepEqual(result1.fields, []);
  assert.equal(result1.oldHashes, undefined);
  assert.equal(result1.newHashes, hashes);

  const result2 = diffSnapshotHashes(null, hashes);
  assert.equal(result2.classification, "FIRST_SNAPSHOT");
  assert.equal(result2.changed, true);
});

test("diffSnapshotHashes reports NO_CHANGE when old and new hashes are identical", () => {
  const canonical = loadAcmicCanonical();
  const hashes1 = computeSnapshotHashes(canonical);
  const hashes2 = computeSnapshotHashes(canonical);

  const result = diffSnapshotHashes(hashes1, hashes2);
  assert.equal(result.classification, "NO_CHANGE");
  assert.equal(result.changed, false);
  assert.deepEqual(result.kinds, []);
  assert.deepEqual(result.fields, []);
});

test("diffCanonicalSnapshots reports NO_CHANGE when only fetchedAt changes", () => {
  const canonical = loadAcmicCanonical();
  const modified: CanonicalProduct = {
    ...canonical,
    fetchedAt: new Date(canonical.fetchedAt.getTime() + 3600000), // +1 hr
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "NO_CHANGE");
  assert.equal(result.changed, false);
  assert.deepEqual(result.kinds, []);
});

test("diffCanonicalSnapshots reports PRICE_CHANGED when only price changes", () => {
  const canonical = loadAcmicCanonical();
  const modified: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, i) =>
      i === 0
        ? {
            ...v,
            price: { ...v.price, final: v.price.final + 5000 },
          }
        : { ...v }
    ),
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "PRICE_CHANGED");
  assert.equal(result.changed, true);
  assert.deepEqual(result.kinds, ["PRICE_CHANGED"]);
  assert.deepEqual(result.fields, ["price"]);
});

test("diffCanonicalSnapshots reports INVENTORY_CHANGED when only inventory changes without inventing zero", () => {
  const canonical = loadAcmicCanonical();
  const targetVar = canonical.variants[0];
  assert.ok(targetVar);
  const baselineQty = targetVar.inventory.quantity;
  if (typeof baselineQty !== "number") {
    throw new Error("Test fixture expected exact numeric quantity for baseline variant");
  }

  const modified: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, i) =>
      i === 0
        ? {
            ...v,
            inventory: { ...v.inventory, quantity: baselineQty + 1 },
          }
        : { ...v }
    ),
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "INVENTORY_CHANGED");
  assert.equal(result.changed, true);
  assert.deepEqual(result.kinds, ["INVENTORY_CHANGED"]);
  assert.deepEqual(result.fields, ["inventory"]);
});

test("diffCanonicalSnapshots reports CONTENT_CHANGED when only description or title changes", () => {
  const canonical = loadAcmicCanonical();
  const modified: CanonicalProduct = {
    ...canonical,
    description: `${canonical.description}\n\nUpdated warranty info.`,
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "CONTENT_CHANGED");
  assert.equal(result.changed, true);
  assert.deepEqual(result.kinds, ["CONTENT_CHANGED"]);
  assert.deepEqual(result.fields, ["content"]);
});

test("diffCanonicalSnapshots reports VARIANTS_CHANGED when variant attributes or merchantSku change", () => {
  const canonical = loadAcmicCanonical();
  const modified: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, i) =>
      i === 0
        ? {
            ...v,
            attributes: { ...v.attributes, Warna: "Hitam Pekat" },
          }
        : { ...v }
    ),
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "VARIANTS_CHANGED");
  assert.equal(result.changed, true);
  assert.deepEqual(result.kinds, ["VARIANTS_CHANGED"]);
  assert.deepEqual(result.fields, ["variants"]);
});

test("diffCanonicalSnapshots reports MULTIPLE_CHANGED and preserves all individual kinds", () => {
  const canonical = loadAcmicCanonical();
  const modified: CanonicalProduct = {
    ...canonical,
    title: "New Title Edition",
    variants: canonical.variants.map((v, i) =>
      i === 0
        ? {
            ...v,
            price: { ...v.price, final: v.price.final + 10000 },
            inventory: { ...v.inventory, quantity: 10 },
          }
        : { ...v }
    ),
  };

  const result = diffCanonicalSnapshots(canonical, modified);
  assert.equal(result.classification, "MULTIPLE_CHANGED");
  assert.equal(result.changed, true);
  assert.ok(result.kinds.includes("CONTENT_CHANGED"));
  assert.ok(result.kinds.includes("PRICE_CHANGED"));
  assert.ok(result.kinds.includes("INVENTORY_CHANGED"));
  assert.equal(result.kinds.length, 3);
});

test("diffCanonicalSnapshots reports NO_CHANGE for same data with different object key insertion orders", () => {
  const canonical = loadAcmicCanonical();

  // Create reordered clone with inverted specifications property insertion
  const reversedSpecs: Record<string, string> = {};
  const specKeys = Object.keys(canonical.specifications).reverse();
  for (const k of specKeys) {
    const val = canonical.specifications[k];
    if (val !== undefined) {
      reversedSpecs[k] = val;
    }
  }

  const reordered: CanonicalProduct = {
    ...canonical,
    specifications: reversedSpecs,
  };

  const result = diffCanonicalSnapshots(canonical, reordered);
  assert.equal(result.classification, "NO_CHANGE");
  assert.equal(result.changed, false);
});

// ----------------------------------------------------------------------
// Identity & Hash Integrity Tests
// ----------------------------------------------------------------------

test("diffCanonicalSnapshots rejects differing sourceProductId with SnapshotIdentityMismatchError", () => {
  const canonical = loadAcmicCanonical();
  const differentProduct: CanonicalProduct = {
    ...canonical,
    sourceProductId: "DIFFERENT-PRODUCT-ID-9999",
  };

  assert.throws(
    () => diffCanonicalSnapshots(canonical, differentProduct),
    (err: unknown) =>
      err instanceof SnapshotIdentityMismatchError &&
      err.message.includes("differing source identities")
  );
});

test("diffCanonicalSnapshots rejects differing source supplier with SnapshotIdentityMismatchError", () => {
  const canonical = loadAcmicCanonical();
  const differentSource: CanonicalProduct = {
    ...canonical,
    source: "other-supplier" as unknown as "jakmall",
  };

  assert.throws(
    () => diffCanonicalSnapshots(canonical, differentSource),
    (err: unknown) =>
      err instanceof SnapshotIdentityMismatchError &&
      err.message.includes("differing source identities")
  );
});

test("diffSnapshotHashes rejects identical group hashes with mismatched sourceHash as integrity violation", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const corruptedHashes: SourceSnapshotHashes = {
    ...baseline,
    sourceHash: "corrupted-inconsistent-source-hash",
  };

  assert.throws(
    () => diffSnapshotHashes(baseline, corruptedHashes),
    (err: unknown) =>
      err instanceof SnapshotIntegrityError &&
      err.message.includes("all component group hashes match, but sourceHash differs")
  );
});

test("diffSnapshotHashes rejects differing group hashes with identical sourceHash as integrity violation", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const corruptedHashes: SourceSnapshotHashes = {
    ...baseline,
    priceHash: "corrupted-different-price-hash",
    // sourceHash intentionally left equal to baseline
  };

  assert.throws(
    () => diffSnapshotHashes(baseline, corruptedHashes),
    (err: unknown) =>
      err instanceof SnapshotIntegrityError &&
      err.message.includes("component group hashes differ, but sourceHash is identical")
  );
});

test("diffCanonicalSnapshots reports MULTIPLE_CHANGED including VARIANTS_CHANGED when a source SKU is removed", () => {
  const canonical = loadAcmicCanonical();
  assert.ok(canonical.variants.length > 1, "ACMIC fixture must contain multiple variants");

  // Remove the second variant
  const removedVariantCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.slice(0, 1),
  };

  const result = diffCanonicalSnapshots(canonical, removedVariantCanonical);

  assert.equal(result.changed, true);
  assert.equal(result.classification, "MULTIPLE_CHANGED");
  assert.ok(
    result.kinds.includes("VARIANTS_CHANGED"),
    "kinds must include VARIANTS_CHANGED when SKU membership changes"
  );
  assert.ok(
    result.kinds.includes("PRICE_CHANGED"),
    "kinds must include PRICE_CHANGED when SKU membership changes"
  );
  assert.ok(
    result.kinds.includes("INVENTORY_CHANGED"),
    "kinds must include INVENTORY_CHANGED when SKU membership changes"
  );
});
