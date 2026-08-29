import type { CanonicalVariantInventory } from "../../canonical/types.js";
import type { ShopeePricingDraft, ShopeeInventoryDraft } from "./types.js";

export class ShopeePolicyError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ShopeePolicyError";
  }
}

export interface PricingPolicyOptions {
  markupMode?: "percentage" | "fixed" | undefined;
  markupValue?: number | undefined;
  roundingUnit?: number | undefined; // e.g. 100, 500, 1000 IDR
  minimumMarginIdr?: number | undefined;
  feeBufferPercentage?: number | undefined; // e.g. marketplace platform fee 5%
}

/**
 * Calculates deterministic selling price with full mathematical explainability.
 * Artificial Intelligence (LLM) is strictly prohibited from computing authoritative financial numbers.
 */
export function calculateShopeePrice(
  sourceFinalPrice: number,
  options: PricingPolicyOptions = {}
): ShopeePricingDraft {
  if (typeof sourceFinalPrice !== "number" || isNaN(sourceFinalPrice) || sourceFinalPrice <= 0) {
    throw new ShopeePolicyError(
      `Source final price must be a positive number, received: ${sourceFinalPrice}`,
      "MARKETPLACE_PRICE_INVALID"
    );
  }

  const mode = options.markupMode ?? "percentage";
  const markupVal = options.markupValue ?? 20;
  const roundingUnit = options.roundingUnit ?? 1000;
  const minimumMargin = options.minimumMarginIdr ?? 0;
  const feeBuffer = options.feeBufferPercentage ?? 0;

  if (typeof markupVal !== "number" || isNaN(markupVal) || markupVal < 0) {
    throw new ShopeePolicyError(
      `Markup value must be non-negative, received: ${markupVal}`,
      "MARKETPLACE_PRICE_INVALID"
    );
  }

  if (roundingUnit <= 0) {
    throw new ShopeePolicyError(
      `Rounding unit must be positive, received: ${roundingUnit}`,
      "MARKETPLACE_PRICE_INVALID"
    );
  }

  // 1. Calculate raw markup
  let markupAmount = 0;
  if (mode === "percentage") {
    markupAmount = (sourceFinalPrice * markupVal) / 100;
  } else {
    markupAmount = markupVal;
  }

  // Ensure minimum margin is satisfied
  if (markupAmount < minimumMargin) {
    markupAmount = minimumMargin;
  }

  // 2. Add optional marketplace fee buffer
  let feeAmount = 0;
  if (feeBuffer > 0) {
    feeAmount = (sourceFinalPrice * feeBuffer) / 100;
  }

  const preRoundPrice = sourceFinalPrice + markupAmount + feeAmount;

  // 3. Deterministic ceiling rounding to the nearest rounding unit
  const rounded = Math.ceil(preRoundPrice / roundingUnit) * roundingUnit;
  const finalSellingPrice = Math.max(1, Math.round(rounded));
  const roundingAdjustment = finalSellingPrice - preRoundPrice;

  return {
    sourceFinalPrice,
    markupMode: mode,
    markupValue: markupVal,
    preRoundPrice: Math.round(preRoundPrice),
    roundingAdjustment: Math.round(roundingAdjustment),
    finalSellingPrice,
  };
}

export interface InventoryPolicyOptions {
  safetyStock?: number | undefined;
  undisclosedStockPolicy?: "needs_review" | "safety_stock_fixed" | "block" | undefined;
}

/**
 * Maps CanonicalVariantInventory to ShopeeInventoryDraft strictly preserving source reality.
 * 
 * Rules:
 * - available === false (or quantity === 0): destination stock = 0, status = "out_of_stock_zero"
 * - available === true && exact === true: destination stock = quantity, status = "exact_passthrough"
 * - available === true && exact === false (undisclosed):
 *     - "needs_review" (default): destination stock = 0, publishable = false
 *     - "safety_stock_fixed": destination stock = safetyStock, publishable = true
 *     - "block": destination stock = 0, publishable = false
 * - available === null (UNKNOWN/incomplete): BLOCKED immediately, publishable = false
 */
export function calculateShopeeInventory(
  inventory: CanonicalVariantInventory,
  options: InventoryPolicyOptions = {}
): ShopeeInventoryDraft {
  const policy = options.undisclosedStockPolicy ?? "needs_review";
  const safetyStock = options.safetyStock ?? 5;

  // Case D: UNKNOWN / Incomplete source inventory
  if (inventory.available === null) {
    return {
      sourceAvailable: null,
      sourceExact: false,
      sourceQuantity: undefined,
      destinationQuantity: undefined,
      destinationStock: undefined,
      policy: "unknown_blocked",
      policyApplied: "unknown_blocked",
      status: "blocked",
      publishable: false,
    };
  }

  // Case A: Confirmed OUT OF STOCK (destinationQuantity = 0 has explicit semantic meaning)
  if (inventory.available === false || inventory.quantity === 0) {
    return {
      sourceAvailable: false,
      sourceExact: true,
      sourceQuantity: 0,
      destinationQuantity: 0,
      destinationStock: 0,
      policy: "out_of_stock_zero",
      policyApplied: "out_of_stock_zero",
      status: "resolved",
      publishable: true,
    };
  }

  // Case B: Confirmed in-stock with EXACT integer quantity
  if (inventory.available === true && inventory.exact === true) {
    const qty = inventory.quantity ?? 0;
    return {
      sourceAvailable: true,
      sourceExact: true,
      sourceQuantity: qty,
      destinationQuantity: qty,
      destinationStock: qty,
      policy: "exact_passthrough",
      policyApplied: "exact_passthrough",
      status: "resolved",
      publishable: qty > 0,
    };
  }

  // Case C: Confirmed in-stock with UNDISCLOSED quantity
  if (inventory.available === true && inventory.exact === false) {
    if (policy === "safety_stock_fixed") {
      const allocated = Math.max(1, safetyStock);
      return {
        sourceAvailable: true,
        sourceExact: false,
        sourceQuantity: undefined,
        destinationQuantity: allocated,
        destinationStock: allocated,
        policy: "configured_safety_stock",
        policyApplied: "configured_safety_stock",
        status: "resolved",
        publishable: true,
      };
    }

    // Default: needs_review — MUST NOT become 0. Undisclosed quantity remains undefined.
    return {
      sourceAvailable: true,
      sourceExact: false,
      sourceQuantity: undefined,
      destinationQuantity: undefined,
      destinationStock: undefined,
      policy: "undisclosed_needs_review",
      policyApplied: "undisclosed_needs_review",
      status: "needs_review",
      publishable: false,
    };
  }

  // Defensive fallback
  return {
    sourceAvailable: null,
    sourceExact: false,
    sourceQuantity: undefined,
    destinationQuantity: undefined,
    destinationStock: undefined,
    policy: "unknown_blocked",
    policyApplied: "unknown_blocked",
    status: "blocked",
    publishable: false,
  };
}
