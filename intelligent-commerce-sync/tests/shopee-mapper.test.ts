import test from "node:test";
import assert from "node:assert/strict";
import { mapShopeeCategory, mapShopeeAttributes } from "../src/marketplace/shopee/mapper.js";
import type { CanonicalProduct } from "../src/canonical/types.js";

test("mapShopeeCategory returns needs_review with semantic suggestion and undefined numeric ID for rule matches", () => {
  const path = ["Handphone & Tablet", "Adaptor Charger", "USB Charger"];
  const result = mapShopeeCategory(path);

  assert.equal(result.status, "needs_review");
  assert.equal(result.targetCategoryId, undefined, "Numeric Shopee category ID must NOT be fabricated");
  assert.equal(result.targetCategoryName, "Aksesoris Handphone > Charger & Kabel > Kepala Charger");
  assert.equal(result.method, "rule");
  assert.ok(result.confidence >= 0.9);
});

test("mapShopeeCategory marks status mapped ONLY when manual override is provided", () => {
  const path = ["Handphone & Tablet", "Adaptor Charger", "USB Charger"];
  const result = mapShopeeCategory(path, { categoryOverrideId: "manual-cat-77" });

  assert.equal(result.status, "mapped");
  assert.equal(result.targetCategoryId, "manual-cat-77");
  assert.equal(result.method, "manual");
  assert.equal(result.confidence, 1.0);
});

test("mapShopeeCategory returns needs_review for unknown paths without suggestion", () => {
  const path = ["Kategori", "Eksotis", "Tidak Dikenal"];
  const result = mapShopeeCategory(path);

  assert.equal(result.status, "needs_review");
  assert.equal(result.targetCategoryId, undefined);
  assert.equal(result.method, "unknown");
});

test("mapShopeeCategory blocks empty category paths", () => {
  const result = mapShopeeCategory([]);
  assert.equal(result.status, "blocked");
  assert.equal(result.targetCategoryId, undefined);
});

test("mapShopeeAttributes preserves source brand and maps specifications", () => {
  const product: CanonicalProduct = {
    source: "jakmall",
    sourceProductId: "test-1",
    sourceUrl: "https://www.jakmall.com/test",
    title: "Test Title",
    description: "Test Description",
    brand: "ACMIC",
    categoryPath: ["Aksesoris"],
    specifications: {
      Voltase: "220V",
      Material: "ABS",
    },
    variants: [],
    images: [],
    seller: { name: "ACMIC Store" },
    fetchedAt: new Date(),
  };

  const { attributes, issues } = mapShopeeAttributes(product);
  assert.equal(issues.length, 0);

  const brandAttr = attributes.find((a) => a.attributeName === "Brand");
  assert.ok(brandAttr);
  assert.equal(brandAttr.value, "ACMIC");
  assert.equal(brandAttr.status, "mapped");

  const voltAttr = attributes.find((a) => a.attributeName === "Voltase");
  assert.ok(voltAttr);
  assert.equal(voltAttr.value, "220V");
});

test("mapShopeeAttributes does NOT fabricate 'No Brand' when brand is missing", () => {
  const product: CanonicalProduct = {
    source: "jakmall",
    sourceProductId: "test-2",
    sourceUrl: "https://www.jakmall.com/test2",
    title: "Unbranded Item",
    description: "Desc",
    brand: undefined,
    categoryPath: ["Fashion"],
    specifications: {},
    variants: [],
    images: [],
    seller: { name: "Generic Store" },
    fetchedAt: new Date(),
  };

  const { attributes, issues } = mapShopeeAttributes(product);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "MARKETPLACE_BRAND_REQUIRED");
  assert.equal(issues[0]?.severity, "WARNING");

  const brandAttr = attributes.find((a) => a.attributeName === "Brand");
  assert.equal(brandAttr, undefined, "Missing brand must NOT be fabricated into 'No Brand'");
});
