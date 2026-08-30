import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CanonicalProduct, CanonicalVariant } from "../src/canonical/types.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import {
  computeContentHash,
  computeInventoryHash,
  computePriceHash,
  computeSnapshotHashes,
  computeVariantHash,
} from "../src/persistence/hash.js";
import {
  SerializationError,
  stableSerialize,
} from "../src/persistence/stable-serialize.js";

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

// ----------------------------------------------------------------------
// Stable Serialization Unit Tests
// ----------------------------------------------------------------------

test("stableSerialize sorts object keys alphabetically regardless of insertion order", () => {
  const obj1 = { zebra: 1, alpha: 2, beta: { delta: 4, charlie: 3 } };
  const obj2 = { alpha: 2, beta: { charlie: 3, delta: 4 }, zebra: 1 };

  assert.equal(stableSerialize(obj1), stableSerialize(obj2));
  assert.equal(
    stableSerialize(obj1),
    '{"alpha":2,"beta":{"charlie":3,"delta":4},"zebra":1}'
  );
});

test("stableSerialize preserves array item order", () => {
  const arr1 = ["a", "b", "c"];
  const arr2 = ["c", "b", "a"];
  assert.notEqual(stableSerialize(arr1), stableSerialize(arr2));
  assert.equal(stableSerialize(arr1), '["a","b","c"]');
});

test("stableSerialize serializes sparse arrays and explicit undefined items consistently to null", () => {
  // eslint-disable-next-line no-sparse-arrays
  const sparseArray = new Array(2);
  const explicitUndefined = [undefined, undefined];

  assert.equal(stableSerialize(sparseArray), "[null,null]");
  assert.equal(stableSerialize(explicitUndefined), "[null,null]");
  assert.equal(stableSerialize(sparseArray), stableSerialize(explicitUndefined));
});

test("stableSerialize deterministically serializes Date objects to ISO 8601", () => {
  const d1 = new Date("2026-08-30T10:00:00.000Z");
  const d2 = new Date("2026-08-30T10:00:00.000Z");
  assert.equal(stableSerialize({ date: d1 }), stableSerialize({ date: d2 }));
  assert.equal(stableSerialize({ date: d1 }), '{"date":"2026-08-30T10:00:00.000Z"}');
});

test("stableSerialize rejects non-finite numbers (NaN, Infinity)", () => {
  assert.throws(
    () => stableSerialize({ price: Number.NaN }),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Non-finite number")
  );
  assert.throws(
    () => stableSerialize({ price: Number.POSITIVE_INFINITY }),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Non-finite number")
  );
});

test("stableSerialize rejects unsupported object instances (Map, Set, RegExp, class instances)", () => {
  assert.throws(
    () => stableSerialize({ data: new Map([["key", "value"]]) }),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Unsupported object instance")
  );

  assert.throws(
    () => stableSerialize({ items: new Set([1, 2, 3]) }),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Unsupported object instance")
  );

  assert.throws(
    () => stableSerialize({ pattern: /abc/gi }),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Unsupported object instance")
  );

  class CustomPayload {
    constructor(public val: string) {}
  }

  assert.throws(
    () => stableSerialize(new CustomPayload("demo")),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Unsupported object instance")
  );
});

test("stableSerialize rejects objects containing Symbol keys", () => {
  const sym = Symbol("privateId");
  const objWithSymbol: Record<string | symbol, unknown> = { name: "test" };
  objWithSymbol[sym] = 123;

  assert.throws(
    () => stableSerialize(objWithSymbol),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Symbol keys are not supported")
  );
});

test("stableSerialize detects and rejects circular references", () => {
  const cyclic: Record<string, unknown> = { name: "test" };
  cyclic["self"] = cyclic;

  assert.throws(
    () => stableSerialize(cyclic),
    (err: unknown) =>
      err instanceof SerializationError && err.message.includes("Circular reference")
  );
});

test("stableSerialize omits undefined object properties consistently", () => {
  const obj1 = { a: 1, b: undefined };
  const obj2 = { a: 1 };
  assert.equal(stableSerialize(obj1), stableSerialize(obj2));
});

// ----------------------------------------------------------------------
// Cryptographic Hashing Unit Tests
// ----------------------------------------------------------------------

test("same CanonicalProduct semantics produce identical hashes", () => {
  const canonical1 = loadAcmicCanonical();
  const canonical2 = loadAcmicCanonical();

  const hashes1 = computeSnapshotHashes(canonical1);
  const hashes2 = computeSnapshotHashes(canonical2);

  assert.equal(hashes1.sourceHash, hashes2.sourceHash);
  assert.equal(hashes1.contentHash, hashes2.contentHash);
  assert.equal(hashes1.priceHash, hashes2.priceHash);
  assert.equal(hashes1.inventoryHash, hashes2.inventoryHash);
  assert.equal(hashes1.variantHash, hashes2.variantHash);
});

test("fetchedAt-only change leaves all semantic hashes unchanged", () => {
  const canonical = loadAcmicCanonical();
  const baselineHashes = computeSnapshotHashes(canonical);

  const modifiedCanonical: CanonicalProduct = {
    ...canonical,
    fetchedAt: new Date(canonical.fetchedAt.getTime() + 86400000), // +1 day
  };

  const newHashes = computeSnapshotHashes(modifiedCanonical);

  assert.equal(newHashes.sourceHash, baselineHashes.sourceHash);
  assert.equal(newHashes.contentHash, baselineHashes.contentHash);
  assert.equal(newHashes.priceHash, baselineHashes.priceHash);
  assert.equal(newHashes.inventoryHash, baselineHashes.inventoryHash);
  assert.equal(newHashes.variantHash, baselineHashes.variantHash);
});

test("price-only change changes priceHash and sourceHash only", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const priceChangedCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            price: { ...v.price, final: v.price.final + 10000 },
          }
        : { ...v }
    ),
  };

  const updated = computeSnapshotHashes(priceChangedCanonical);

  assert.notEqual(updated.priceHash, baseline.priceHash, "priceHash must change");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change");
  assert.equal(updated.contentHash, baseline.contentHash, "contentHash must remain unchanged");
  assert.equal(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must remain unchanged");
  assert.equal(updated.variantHash, baseline.variantHash, "variantHash must remain unchanged");
});

test("inventory-only change changes inventoryHash and sourceHash only without inventing zero", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const targetVariant = canonical.variants[0];
  assert.ok(targetVariant);
  const baselineQty = targetVariant.inventory.quantity;
  if (typeof baselineQty !== "number") {
    throw new Error("Test fixture expected exact numeric quantity for baseline variant");
  }

  const inventoryChangedCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            inventory: { ...v.inventory, quantity: baselineQty + 5 },
          }
        : { ...v }
    ),
  };

  const updated = computeSnapshotHashes(inventoryChangedCanonical);

  assert.notEqual(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must change");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change");
  assert.equal(updated.priceHash, baseline.priceHash, "priceHash must remain unchanged");
  assert.equal(updated.contentHash, baseline.contentHash, "contentHash must remain unchanged");
  assert.equal(updated.variantHash, baseline.variantHash, "variantHash must remain unchanged");
});

test("content-only change changes contentHash and sourceHash only", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const contentChangedCanonical: CanonicalProduct = {
    ...canonical,
    title: `${canonical.title} [Updated Promotion Edition]`,
  };

  const updated = computeSnapshotHashes(contentChangedCanonical);

  assert.notEqual(updated.contentHash, baseline.contentHash, "contentHash must change");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change");
  assert.equal(updated.priceHash, baseline.priceHash, "priceHash must remain unchanged");
  assert.equal(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must remain unchanged");
  assert.equal(updated.variantHash, baseline.variantHash, "variantHash must remain unchanged");
});

test("variant topology change changes variantHash and sourceHash only", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const variantChangedCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            merchantSku: "NEW-MERCHANT-SKU-999",
          }
        : { ...v }
    ),
  };

  const updated = computeSnapshotHashes(variantChangedCanonical);

  assert.notEqual(updated.variantHash, baseline.variantHash, "variantHash must change");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change");
  assert.equal(updated.priceHash, baseline.priceHash, "priceHash must remain unchanged");
  assert.equal(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must remain unchanged");
  assert.equal(updated.contentHash, baseline.contentHash, "contentHash must remain unchanged");
});

test("variant image change changes variantHash and sourceHash while leaving others unchanged", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const variantImageChangedCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            images: [
              {
                url: "https://example.com/variant-image-updated.jpg",
                sourceUrl: "https://example.com/variant-image-updated.jpg",
                position: 1,
              },
            ],
          }
        : { ...v }
    ),
  };

  const updated = computeSnapshotHashes(variantImageChangedCanonical);

  assert.notEqual(updated.variantHash, baseline.variantHash, "variantHash must change on variant image update");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change on variant image update");
  assert.equal(updated.contentHash, baseline.contentHash, "contentHash must remain unchanged");
  assert.equal(updated.priceHash, baseline.priceHash, "priceHash must remain unchanged");
  assert.equal(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must remain unchanged");
});

test("variant volume change changes variantHash and sourceHash while leaving others unchanged", () => {
  const canonical = loadAcmicCanonical();
  const baseline = computeSnapshotHashes(canonical);

  const variantVolumeChangedCanonical: CanonicalProduct = {
    ...canonical,
    variants: canonical.variants.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            volume: { lengthCm: 10, widthCm: 5, heightCm: 4 },
          }
        : { ...v }
    ),
  };

  const updated = computeSnapshotHashes(variantVolumeChangedCanonical);

  assert.notEqual(updated.variantHash, baseline.variantHash, "variantHash must change on variant volume update");
  assert.notEqual(updated.sourceHash, baseline.sourceHash, "sourceHash must change on variant volume update");
  assert.equal(updated.contentHash, baseline.contentHash, "contentHash must remain unchanged");
  assert.equal(updated.priceHash, baseline.priceHash, "priceHash must remain unchanged");
  assert.equal(updated.inventoryHash, baseline.inventoryHash, "inventoryHash must remain unchanged");
});

test("undefined inventory quantity produces different hash than quantity 0", () => {
  const canonical = loadAcmicCanonical();

  const variantWithUndefined: CanonicalVariant[] = [
    {
      ...canonical.variants[0]!,
      inventory: {
        available: true,
        exact: false,
        quantity: undefined,
        status: "in_stock",
      },
    },
  ];

  const variantWithZero: CanonicalVariant[] = [
    {
      ...canonical.variants[0]!,
      inventory: {
        available: false,
        exact: true,
        quantity: 0,
        status: "out_of_stock",
      },
    },
  ];

  const hashUndefined = computeInventoryHash(variantWithUndefined);
  const hashZero = computeInventoryHash(variantWithZero);

  assert.notEqual(hashUndefined, hashZero, "Undefined stock must NOT hash to stock 0");
});

test("variant array order does not affect price, inventory, or variant hashes", () => {
  const canonical = loadAcmicCanonical();

  const reversedCanonical: CanonicalProduct = {
    ...canonical,
    variants: [...canonical.variants].reverse(),
  };

  assert.equal(
    computePriceHash(reversedCanonical.variants),
    computePriceHash(canonical.variants),
    "Price hash must be order-independent"
  );
  assert.equal(
    computeInventoryHash(reversedCanonical.variants),
    computeInventoryHash(canonical.variants),
    "Inventory hash must be order-independent"
  );
  assert.equal(
    computeVariantHash(reversedCanonical.variants),
    computeVariantHash(canonical.variants),
    "Variant hash must be order-independent"
  );
});

test("deterministic lexical sorting works across SKU strings with mixed case and punctuation", () => {
  const canonical = loadAcmicCanonical();
  const baseVar = canonical.variants[0]!;

  const skuList = ["sku_B", "sku-a", "SKU_1", "sku.C", "SKU-2"];

  const variantsForward: CanonicalVariant[] = skuList.map((id, index) => ({
    ...baseVar,
    sourceSkuId: id,
    sourceSku: id,
    attributes: { index: String(index) },
  }));

  const variantsReversed = [...variantsForward].reverse();

  assert.equal(
    computePriceHash(variantsForward),
    computePriceHash(variantsReversed),
    "Lexical sort must produce identical priceHash regardless of input array order"
  );
  assert.equal(
    computeInventoryHash(variantsForward),
    computeInventoryHash(variantsReversed),
    "Lexical sort must produce identical inventoryHash regardless of input array order"
  );
  assert.equal(
    computeVariantHash(variantsForward),
    computeVariantHash(variantsReversed),
    "Lexical sort must produce identical variantHash regardless of input array order"
  );
});

test("hash computation strictly does NOT mutate CanonicalProduct (Zero Mutation Regression)", () => {
  const canonical = loadAcmicCanonical();
  const snapshotBefore = JSON.stringify(canonical);

  computeSnapshotHashes(canonical);
  computeContentHash(canonical);
  computePriceHash(canonical.variants);
  computeInventoryHash(canonical.variants);
  computeVariantHash(canonical.variants);

  const snapshotAfter = JSON.stringify(canonical);
  assert.equal(snapshotBefore, snapshotAfter, "CanonicalProduct was mutated during hash computation!");
});

test("computeVariantHash changes when adding or removing a sourceSkuId", () => {
  const canonical = loadAcmicCanonical();
  assert.ok(canonical.variants.length > 1, "ACMIC fixture must contain multiple variants");

  const baselineVariantHash = computeVariantHash(canonical.variants);

  // Remove one variant
  const subsetVariants = canonical.variants.slice(0, 1);
  const subsetVariantHash = computeVariantHash(subsetVariants);
  assert.notEqual(
    subsetVariantHash,
    baselineVariantHash,
    "computeVariantHash must change when a variant is removed"
  );

  // Add an additional controlled variant clone with distinct SKU
  const baseVar = canonical.variants[0]!;
  const addedVariants: CanonicalVariant[] = [
    ...canonical.variants,
    {
      ...baseVar,
      sourceSkuId: "9999999999999",
      sourceSku: "9999999999999",
    },
  ];
  const addedVariantHash = computeVariantHash(addedVariants);
  assert.notEqual(
    addedVariantHash,
    baselineVariantHash,
    "computeVariantHash must change when a new variant SKU is added"
  );
});
