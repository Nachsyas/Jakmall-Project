import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateShopeePrice,
  calculateShopeeInventory,
  ShopeePolicyError,
} from "../src/marketplace/shopee/policy.js";
import type { CanonicalVariantInventory } from "../src/canonical/types.js";

test("calculateShopeePrice applies percentage markup with deterministic ceiling rounding", () => {
  // ACMIC active SKU: Rp379.000 + 20% = Rp454.800 -> rounded to nearest 1.000 = Rp455.000
  const result = calculateShopeePrice(379000, {
    markupMode: "percentage",
    markupValue: 20,
    roundingUnit: 1000,
  });

  assert.equal(result.sourceFinalPrice, 379000);
  assert.equal(result.markupMode, "percentage");
  assert.equal(result.markupValue, 20);
  assert.equal(result.preRoundPrice, 454800);
  assert.equal(result.roundingAdjustment, 200);
  assert.equal(result.finalSellingPrice, 455000);
});

test("calculateShopeePrice applies fixed markup with minimum margin and fee buffer", () => {
  // Source: Rp100.000, Fixed markup: Rp25.000, Fee buffer: 5% (Rp5.000)
  // Pre-round: Rp130.000 -> rounded to nearest 500 = Rp130.000
  const result = calculateShopeePrice(100000, {
    markupMode: "fixed",
    markupValue: 25000,
    feeBufferPercentage: 5,
    roundingUnit: 500,
  });

  assert.equal(result.sourceFinalPrice, 100000);
  assert.equal(result.finalSellingPrice, 130000);
  assert.equal(result.preRoundPrice, 130000);
});

test("calculateShopeePrice enforces minimum margin", () => {
  // Source: Rp50.000, 10% = Rp5.000, but minimum margin is Rp15.000
  // Pre-round: Rp50.000 + Rp15.000 = Rp65.000
  const result = calculateShopeePrice(50000, {
    markupMode: "percentage",
    markupValue: 10,
    minimumMarginIdr: 15000,
    roundingUnit: 1000,
  });

  assert.equal(result.finalSellingPrice, 65000);
});

test("calculateShopeePrice rejects non-positive or invalid prices and markups", () => {
  assert.throws(
    () => calculateShopeePrice(0),
    (err: unknown) => err instanceof ShopeePolicyError && err.code === "MARKETPLACE_PRICE_INVALID"
  );

  assert.throws(
    () => calculateShopeePrice(-50000),
    (err: unknown) => err instanceof ShopeePolicyError && err.code === "MARKETPLACE_PRICE_INVALID"
  );

  assert.throws(
    () => calculateShopeePrice(100000, { markupValue: -10 }),
    (err: unknown) => err instanceof ShopeePolicyError && err.code === "MARKETPLACE_PRICE_INVALID"
  );

  assert.throws(
    () => calculateShopeePrice(100000, { roundingUnit: 0 }),
    (err: unknown) => err instanceof ShopeePolicyError && err.code === "MARKETPLACE_PRICE_INVALID"
  );
});

test("calculateShopeeInventory maps confirmed out-of-stock to zero stock", () => {
  const invOos: CanonicalVariantInventory = {
    available: false,
    exact: true,
    quantity: 0,
    status: "out_of_stock",
  };

  const result = calculateShopeeInventory(invOos);
  assert.equal(result.destinationQuantity, 0);
  assert.equal(result.destinationStock, 0);
  assert.equal(result.policy, "out_of_stock_zero");
  assert.equal(result.status, "resolved");
  assert.equal(result.publishable, true);
});

test("calculateShopeeInventory maps exact stock faithfully", () => {
  const invExact: CanonicalVariantInventory = {
    available: true,
    exact: true,
    quantity: 3,
    status: "limited",
  };

  const result = calculateShopeeInventory(invExact);
  assert.equal(result.destinationQuantity, 3);
  assert.equal(result.destinationStock, 3);
  assert.equal(result.policy, "exact_passthrough");
  assert.equal(result.status, "resolved");
  assert.equal(result.publishable, true);
});

test("calculateShopeeInventory handles undisclosed quantity safely without fabricating zero", () => {
  const invUndisclosed: CanonicalVariantInventory = {
    available: true,
    exact: false,
    quantity: undefined,
    status: "in_stock",
  };

  // Default: needs_review -> destination quantity MUST remain undefined (NOT zero!)
  const defaultResult = calculateShopeeInventory(invUndisclosed);
  assert.equal(defaultResult.destinationQuantity, undefined);
  assert.equal(defaultResult.destinationStock, undefined);
  assert.equal(defaultResult.policy, "undisclosed_needs_review");
  assert.equal(defaultResult.status, "needs_review");
  assert.equal(defaultResult.publishable, false);

  // Configured safety stock: destination quantity becomes configured amount
  const safetyStockResult = calculateShopeeInventory(invUndisclosed, {
    safetyStock: 8,
    undisclosedStockPolicy: "safety_stock_fixed",
  });
  assert.equal(safetyStockResult.destinationQuantity, 8);
  assert.equal(safetyStockResult.destinationStock, 8);
  assert.equal(safetyStockResult.policy, "configured_safety_stock");
  assert.equal(safetyStockResult.status, "resolved");
  assert.equal(safetyStockResult.publishable, true);
});

test("calculateShopeeInventory strictly blocks UNKNOWN inventory without fabricating zero", () => {
  const invUnknown: CanonicalVariantInventory = {
    available: null,
    exact: false,
    quantity: undefined,
    status: "unknown",
  };

  const result = calculateShopeeInventory(invUnknown);
  assert.equal(result.destinationQuantity, undefined);
  assert.equal(result.destinationStock, undefined);
  assert.equal(result.policy, "unknown_blocked");
  assert.equal(result.status, "blocked");
  assert.equal(result.publishable, false);
});

test("safety_stock_fixed without explicit safetyStock is rejected and never defaults to 5", () => {
  const invUndisclosed: CanonicalVariantInventory = {
    available: true,
    exact: false,
    quantity: undefined,
    status: "in_stock",
  };

  // Missing safetyStock must throw ShopeePolicyError and never silently default to 5
  assert.throws(
    () =>
      calculateShopeeInventory(invUndisclosed, {
        undisclosedStockPolicy: "safety_stock_fixed",
      }),
    (err: unknown) =>
      err instanceof ShopeePolicyError && err.code === "MARKETPLACE_STOCK_POLICY_REQUIRED"
  );

  // Non-positive or invalid safetyStock must also be rejected
  assert.throws(
    () =>
      calculateShopeeInventory(invUndisclosed, {
        undisclosedStockPolicy: "safety_stock_fixed",
        safetyStock: 0,
      }),
    (err: unknown) =>
      err instanceof ShopeePolicyError && err.code === "MARKETPLACE_STOCK_POLICY_REQUIRED"
  );
  assert.throws(
    () =>
      calculateShopeeInventory(invUndisclosed, {
        undisclosedStockPolicy: "safety_stock_fixed",
        safetyStock: -3,
      }),
    (err: unknown) =>
      err instanceof ShopeePolicyError && err.code === "MARKETPLACE_STOCK_POLICY_REQUIRED"
  );
});

test("exact stock without quantity is treated as inconsistent blocked state and never becomes zero", () => {
  const invInconsistent: CanonicalVariantInventory = {
    available: true,
    exact: true,
    quantity: undefined,
    status: "in_stock",
  };

  const result = calculateShopeeInventory(invInconsistent);
  assert.equal(result.destinationQuantity, undefined, "Must NOT fabricate 0 for missing exact quantity");
  assert.equal(result.destinationStock, undefined);
  assert.equal(result.status, "blocked");
  assert.equal(result.policy, "inconsistent_stock_blocked");
  assert.equal(result.publishable, false);
});
