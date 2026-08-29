import type { CanonicalProduct } from "../../canonical/types.js";
import type {
  ShopeeCategoryMapping,
  ShopeeAttributeMapping,
  ShopeePreparationConfig,
} from "./types.js";
import type { MarketplaceValidationIssue } from "../types.js";

/**
 * Semantic category suggestion rules for common JakMall categories.
 * Note: Numeric Shopee category IDs are NEVER fabricated without verified API evidence.
 * Rule matches produce semantic suggestions (targetCategoryName) with status: "needs_review".
 */
interface SemanticCategoryRule {
  pattern: RegExp;
  targetName: string;
  confidence: number;
}

const SEMANTIC_CATEGORY_RULES: SemanticCategoryRule[] = [
  {
    // ACMIC: Handphone & Tablet > Adaptor Charger > USB Charger
    pattern: /adaptor charger|usb charger|charger/i,
    targetName: "Aksesoris Handphone > Charger & Kabel > Kepala Charger",
    confidence: 0.95,
  },
  {
    // MOMO: Fashion & Perhiasan > Pakaian Pria > Bawahan
    pattern: /pakaian pria.*bawahan|celana cargo|celana panjang/i,
    targetName: "Pakaian Pria > Celana Panjang > Celana Cargo",
    confidence: 0.90,
  },
  {
    // ASV: Fashion & Perhiasan > Pakaian Pria > Pakaian Pria Lainnya / Jas Hujan
    pattern: /jas hujan|raincoat/i,
    targetName: "Otomotif > Aksesoris Pengendara Motor > Jas Hujan",
    confidence: 0.92,
  },
];

/**
 * Maps source category path to a Shopee destination category.
 * 
 * Rules:
 * 1. Manual override (categoryOverrideId in config): produces status "mapped" with targetCategoryId defined.
 * 2. Semantic rule match: produces status "needs_review" with semantic suggestion, targetCategoryId: undefined.
 *    (Numeric Shopee IDs are never invented without verified platform evidence).
 * 3. Empty or unrecognized category: produces status "needs_review" or "blocked".
 */
export function mapShopeeCategory(
  categoryPath: string[],
  config: ShopeePreparationConfig = {}
): ShopeeCategoryMapping {
  // 1. Manual override takes highest priority
  if (config.categoryOverrideId) {
    const trimmedId = config.categoryOverrideId.trim();
    if (trimmedId.length > 0) {
      return {
        sourceCategoryPath: categoryPath,
        targetCategoryId: trimmedId,
        targetCategoryName: `Manual Override (${trimmedId})`,
        confidence: 1.0,
        method: "manual",
        status: "mapped",
        reason: "Category manually configured by operator with verified destination ID",
      };
    }
  }

  if (!categoryPath || categoryPath.length === 0) {
    return {
      sourceCategoryPath: [],
      targetCategoryId: undefined,
      confidence: 0.0,
      method: "unknown",
      status: "blocked",
      reason: "Source product category path is empty; cannot determine category",
    };
  }

  const pathString = categoryPath.join(" > ");

  // 2. Semantic rule matching (semantic suggestion only; targetCategoryId is undefined until verified)
  for (const rule of SEMANTIC_CATEGORY_RULES) {
    if (rule.pattern.test(pathString)) {
      return {
        sourceCategoryPath: categoryPath,
        targetCategoryId: undefined,
        targetCategoryName: rule.targetName,
        confidence: rule.confidence,
        method: "rule",
        status: "needs_review",
        reason: `Matched semantic category suggestion "${rule.targetName}"; numeric Shopee category ID requires operator review or verified API lookup`,
      };
    }
  }

  // 3. Fallback: Needs human review
  return {
    sourceCategoryPath: categoryPath,
    targetCategoryId: undefined,
    confidence: 0.2,
    method: "unknown",
    status: "needs_review",
    reason: `No deterministic semantic rule found for category path "${pathString}"`,
  };
}

/**
 * Maps canonical product attributes and specifications to Shopee attribute definitions.
 * 
 * Guarantees:
 * - Never fabricates fake brand sentinels (e.g. "No Brand") unless verified.
 * - Missing brand produces a WARNING issue and brand remains undefined.
 */
export function mapShopeeAttributes(
  product: CanonicalProduct
): { attributes: ShopeeAttributeMapping[]; issues: MarketplaceValidationIssue[] } {
  const mapped: ShopeeAttributeMapping[] = [];
  const issues: MarketplaceValidationIssue[] = [];

  // 1. Brand handling
  const brandVal = product.brand?.trim();
  if (brandVal && brandVal.length > 0) {
    mapped.push({
      attributeName: "Brand",
      value: brandVal,
      mandatory: true,
      status: "mapped",
    });
  } else {
    // Missing brand: Do NOT fabricate "No Brand". Emit review issue.
    issues.push({
      code: "MARKETPLACE_BRAND_REQUIRED",
      field: "brand",
      message: "Destination brand requires review because source brand is unavailable.",
      severity: "WARNING",
    });
  }

  // 2. Specifications passthrough
  for (const [key, val] of Object.entries(product.specifications)) {
    if (key && val) {
      mapped.push({
        attributeName: key,
        value: val,
        mandatory: false,
        status: "mapped",
      });
    }
  }

  return { attributes: mapped, issues };
}
