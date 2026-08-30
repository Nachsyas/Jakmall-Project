import type {
  MarketplaceListingDraft,
  MarketplaceValidationResult,
  MarketplaceValidationIssue,
  HumanReviewRecord,
  MarketplacePreparationConfig,
} from "../types.js";

/**
 * Pricing policy details for a Shopee variant.
 */
export interface ShopeePricingDraft {
  sourceFinalPrice: number;
  markupMode: "percentage" | "fixed";
  markupValue: number;
  preRoundPrice: number;
  roundingAdjustment: number;
  finalSellingPrice: number; // Integer IDR (> 0)
}

/**
 * Inventory policy details for a Shopee variant.
 * 
 * Truthful semantics:
 * - Confirmed OOS: destinationQuantity = 0, status = "resolved"
 * - Confirmed exact stock N: destinationQuantity = N, status = "resolved"
 * - Undisclosed source stock: destinationQuantity = undefined, status = "needs_review"
 *   (or destinationQuantity = N, status = "resolved" if explicit seller safety stock configured)
 * - UNKNOWN source stock (available === null): destinationQuantity = undefined, status = "blocked"
 */
export interface ShopeeInventoryDraft {
  sourceAvailable: boolean | null;
  sourceExact: boolean;
  sourceQuantity?: number | undefined;
  destinationQuantity?: number | undefined;
  destinationStock?: number | undefined; // Backward-compatible alias for destinationQuantity
  policy:
    | "exact_passthrough"
    | "out_of_stock_zero"
    | "configured_safety_stock"
    | "undisclosed_needs_review"
    | "unknown_blocked"
    | "inconsistent_stock_blocked";
  policyApplied: string; // Backward-compatible string alias for policy
  status: "resolved" | "needs_review" | "blocked";
  publishable: boolean;
}

/**
 * Individual variant draft mapped for Shopee.
 */
export interface ShopeeVariantDraft {
  sourceSkuId: string;
  merchantSku?: string | undefined;
  displaySku?: string | undefined;
  shopeeVariationSku: string;
  attributes: Record<string, string>;
  tierIndex: number;
  pricing: ShopeePricingDraft;
  inventory: ShopeeInventoryDraft;
  weightGrams?: number | undefined;
  status: "ACTIVE" | "OUT_OF_STOCK" | "BLOCKED" | "NEEDS_REVIEW";
}

/**
 * Image draft prepared for Shopee.
 */
export interface ShopeeImageDraft {
  sourceUrl: string;
  position: number;
  valid: boolean;
  validationError?: string | undefined;
}

/**
 * Category mapping result for Shopee.
 * 
 * States:
 * - "mapped": targetCategoryId exists from verified source or manual override.
 * - "needs_review": semantic suggestion exists, but numeric destination category ID is unresolved.
 * - "blocked": category could not be determined at all.
 */
export interface ShopeeCategoryMapping {
  sourceCategoryPath: string[];
  targetCategoryId?: string | undefined;
  targetCategoryName?: string | undefined;
  confidence: number; // 0.0 - 1.0
  method: "rule" | "manual" | "ai" | "unknown";
  status: "mapped" | "needs_review" | "blocked";
  reason?: string | undefined;
}

/**
 * Attribute mapping result for Shopee.
 */
export interface ShopeeAttributeMapping {
  attributeName: string;
  targetAttributeId?: string | undefined;
  value: string;
  mandatory: boolean;
  status: "mapped" | "defaulted" | "missing";
}

/**
 * Preparation configuration specific to Shopee.
 */
export interface ShopeePreparationConfig extends MarketplacePreparationConfig {
  shopId?: string | undefined;
  sellerAccountKey?: string | undefined; // e.g. "local-demo-shop"
  logisticsChannelIds?: number[] | undefined;
  titlePrefix?: string | undefined;
  maxTitleLength?: number | undefined; // Local configurable preparation rule default: 120
  minDescriptionLength?: number | undefined; // Local configurable preparation rule default: 100
}

/**
 * Complete internal Shopee listing draft model.
 * Represents internal validated domain draft, distinct from raw wire API payload schemas.
 */
export interface ShopeeListingDraft extends MarketplaceListingDraft {
  marketplace: "shopee";
  shopId: string;
  sellerAccountKey: string;

  // Source provenance
  source: "jakmall";
  sourceProductId: string;
  sourceUrl: string;
  sourceSellerName: string;

  // Prepared listing fields
  sourceTitle: string;
  preparedTitle: string;
  sourceDescription: string;
  preparedDescription: string;
  brand?: string | undefined; // Strictly undefined when missing from source

  // Mappings
  category: ShopeeCategoryMapping;
  attributes: ShopeeAttributeMapping[];
  variants: ShopeeVariantDraft[];
  images: ShopeeImageDraft[];
  totalWeightGrams?: number | undefined;

  // Review & Validation
  validation: MarketplaceValidationResult;
  review?: HumanReviewRecord | undefined;
}
