import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStock,
  resolveVariantAttributes,
  normalizeToCanonical,
} from "../src/jakmall/normalizer.js";
import type { ParsedJakmallPage, JakmallRawSkuItem } from "../src/jakmall/types.js";

test("normalizeStock correctly handles stock semantics", () => {
  // Case 1: out of stock
  const outOfStockItem: JakmallRawSkuItem = {
    sku: "SKU-01",
    in_stock: false,
    is_limited_stock: false,
    limited_stock: null,
  };
  const stock1 = normalizeStock(outOfStockItem);
  assert.equal(stock1.available, false);
  assert.equal(stock1.exact, true);
  assert.equal(stock1.quantity, 0);

  // Case 2: limited exact stock
  const limitedItem: JakmallRawSkuItem = {
    sku: "SKU-02",
    in_stock: true,
    is_limited_stock: true,
    limited_stock: 7,
  };
  const stock2 = normalizeStock(limitedItem);
  assert.equal(stock2.available, true);
  assert.equal(stock2.exact, true);
  assert.equal(stock2.quantity, 7);

  // Case 3: in stock, but limited_stock is null (quantity UNKNOWN, must NOT be 0)
  const unknownStockItem: JakmallRawSkuItem = {
    sku: "SKU-03",
    in_stock: true,
    is_limited_stock: false,
    limited_stock: null,
  };
  const stock3 = normalizeStock(unknownStockItem);
  assert.equal(stock3.available, true);
  assert.equal(stock3.exact, false);
  assert.equal(stock3.quantity, undefined);
  assert.notEqual(stock3.quantity, 0, "null stock must not become 0");
});

test("resolveVariantAttributes resolves multi-dimensional variants", () => {
  const variantsDef = {
    Ukuran: {
      u1: "L",
      u2: "XL",
    },
    Warna: {
      w1: "Hitam",
      w2: "Biru",
    },
  };

  const matrixDef = {
    "u1,w1": "SKU-L-HITAM",
    "u2,w2": "SKU-XL-BIRU",
  };

  const attrs = resolveVariantAttributes(variantsDef, matrixDef);
  assert.deepEqual(attrs.get("SKU-L-HITAM"), {
    Ukuran: "L",
    Warna: "Hitam",
  });
  assert.deepEqual(attrs.get("SKU-XL-BIRU"), {
    Ukuran: "XL",
    Warna: "Biru",
  });
});

test("normalizeToCanonical transforms ParsedJakmallPage to CanonicalProduct contract", () => {
  const parsedPage: ParsedJakmallPage = {
    title: "Jaket Outdoor Anti Air",
    description: "Jaket gunung bahan taslan waterproof",
    brand: "Eiger",
    categoryPath: ["Fashion", "Jaket Pria"],
    spdt: {
      id: "prod-888",
      sku: {
        "SKU-L-HITAM": {
          sku: "SKU-L-HITAM",
          weight: 650,
          in_stock: true,
          is_limited_stock: true,
          limited_stock: 12,
          price: {
            final: 299000,
            normal: 350000,
          },
          images: [{ detail: "https://img.jakmall.com/jaket-l-hitam.jpg" }],
        },
      },
      variants: {
        Ukuran: { u1: "L" },
        Warna: { w1: "Hitam" },
      },
      matrix: {
        "u1,w1": "SKU-L-HITAM",
      },
      store: {
        id: "store-1",
        name: "Official Outdoor Gear",
      },
    },
  };

  const canonical = normalizeToCanonical(
    parsedPage,
    "https://www.jakmall.com/outdoor/jaket-waterproof"
  );

  assert.equal(canonical.source, "jakmall");
  assert.equal(canonical.sourceProductId, "prod-888");
  assert.equal(canonical.title, "Jaket Outdoor Anti Air");
  assert.equal(canonical.brand, "Eiger");
  assert.deepEqual(canonical.categoryPath, ["Fashion", "Jaket Pria"]);
  assert.equal(canonical.variants.length, 1);

  const variant = canonical.variants[0];
  assert.ok(variant);
  assert.equal(variant.sourceSku, "SKU-L-HITAM");
  assert.deepEqual(variant.attributes, { Ukuran: "L", Warna: "Hitam" });
  assert.equal(variant.price.final, 299000);
  assert.equal(variant.inventory.available, true);
  assert.equal(variant.inventory.exact, true);
  assert.equal(variant.inventory.quantity, 12);
  assert.equal(variant.weightGrams, 650);
  assert.equal(canonical.seller.name, "Official Outdoor Gear");
});
