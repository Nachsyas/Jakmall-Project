import type { CanonicalProduct } from "../../canonical/types.js";
import type {
  ShopeeListingDraft,
  ShopeeVariantDraft,
  ShopeeInventoryDraft,
  ShopeeImageDraft,
  ShopeePreparationConfig,
} from "./types.js";
import type {
  MarketplaceValidationIssue,
  MarketplaceValidationResult,
  HumanReviewRecord,
} from "../types.js";
import { formatIdempotencyKey } from "../types.js";
import { calculateShopeePrice, calculateShopeeInventory, ShopeePolicyError } from "./policy.js";
import { mapShopeeCategory, mapShopeeAttributes } from "./mapper.js";

/**
 * Prepares and validates a complete Shopee listing draft from a CanonicalProduct.
 * 
 * Guarantees:
 * 1. ZERO mutation of the input CanonicalProduct and its inner objects.
 * 2. Deterministic title sanitization and length compliance (local configurable rule default: 120 chars).
 * 3. Never fabricates "No Brand" or unverified numeric category IDs.
 * 4. Separate validationReady, eligibleForApproval, and canPublish semantics.
 *    (canPublish is ALWAYS false until explicit human APPROVE with resolved category and stock).
 */
export function buildShopeeDraft(
  product: CanonicalProduct,
  config: ShopeePreparationConfig = {}
): ShopeeListingDraft {
  const issues: MarketplaceValidationIssue[] = [];
  const sellerAccountKey = config.sellerAccountKey ?? config.shopId ?? "local-demo-shop";
  const shopId = config.shopId ?? sellerAccountKey;

  // 1. Title Preparation (Deterministic & length bounded)
  const maxTitleLen = config.maxTitleLength ?? 120;
  const prefix = config.titlePrefix ? `${config.titlePrefix.trim()} ` : "";
  let preparedTitle = `${prefix}${product.title.trim()}`.replace(/\s+/g, " ");
  if (preparedTitle.length > maxTitleLen) {
    preparedTitle = preparedTitle.substring(0, maxTitleLen).trim();
    issues.push({
      code: "SHOPEE_TITLE_TRUNCATED",
      field: "preparedTitle",
      message: `Title exceeded ${maxTitleLen} characters and was safely truncated`,
      severity: "WARNING",
    });
  }

  if (preparedTitle.length < 5) {
    issues.push({
      code: "SHOPEE_TITLE_TOO_SHORT",
      field: "preparedTitle",
      message: `Prepared title must be at least 5 characters long`,
      severity: "BLOCKER",
    });
  }

  // 2. Description Preparation (Factual content preservation, untrusted data isolated)
  const preparedDescription = product.description.trim();
  const minDescLen = config.minDescriptionLength ?? 20;
  if (preparedDescription.length < minDescLen) {
    issues.push({
      code: "SHOPEE_DESCRIPTION_TOO_SHORT",
      field: "preparedDescription",
      message: `Product description has only ${preparedDescription.length} characters (minimum required is ${minDescLen})`,
      severity: "WARNING",
    });
  }

  // 3. Category Mapping
  const category = mapShopeeCategory(product.categoryPath, config);
  if (category.status === "blocked") {
    issues.push({
      code: "MARKETPLACE_CATEGORY_BLOCKED",
      field: "category",
      message: category.reason ?? "Source category cannot be mapped to Shopee",
      severity: "BLOCKER",
    });
  } else if (category.status === "needs_review") {
    issues.push({
      code: "MARKETPLACE_CATEGORY_NEEDS_REVIEW",
      field: "category",
      message: category.reason ?? "Category mapping requires manual confirmation or verified numeric ID",
      severity: "WARNING",
    });
  }

  // 4. Attribute Mapping & Brand handling
  const { attributes, issues: attrIssues } = mapShopeeAttributes(product);
  issues.push(...attrIssues);
  const brand = product.brand?.trim() || undefined;

  // 5. Image Preparation & Validation
  const imageDrafts: ShopeeImageDraft[] = [];
  const seenImageUrls = new Set<string>();

  for (let i = 0; i < product.images.length; i++) {
    const rawImg = product.images[i];
    if (!rawImg || !rawImg.url) continue;

    const url = rawImg.url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      imageDrafts.push({
        sourceUrl: url,
        position: imageDrafts.length + 1,
        valid: false,
        validationError: "Image URL must use http or https protocol",
      });
      issues.push({
        code: "SHOPEE_IMAGE_INVALID_PROTOCOL",
        field: `images[${i}]`,
        message: `Image URL "${url}" is invalid`,
        severity: "WARNING",
      });
      continue;
    }

    if (seenImageUrls.has(url)) {
      continue; // Deduplicate
    }

    seenImageUrls.add(url);
    imageDrafts.push({
      sourceUrl: url,
      position: imageDrafts.length + 1,
      valid: true,
    });
  }

  if (imageDrafts.filter((img) => img.valid).length === 0) {
    issues.push({
      code: "MARKETPLACE_IMAGES_REQUIRED",
      field: "images",
      message: "At least one valid image is required to publish a Shopee listing",
      severity: "BLOCKER",
    });
  }

  // 6. Variants, Pricing & Stock Policy Application
  const variantDrafts: ShopeeVariantDraft[] = [];
  let maxWeight = 0;

  for (let idx = 0; idx < product.variants.length; idx++) {
    const v = product.variants[idx];
    if (!v) continue;

    // Pricing Policy
    let pricingResult;
    try {
      pricingResult = calculateShopeePrice(v.price.final, {
        markupMode: config.markupMode,
        markupValue: config.markupValue,
        roundingUnit: config.roundingUnit,
      });
    } catch (err) {
      issues.push({
        code: "MARKETPLACE_PRICE_INVALID",
        field: `variants[${idx}].price`,
        message: err instanceof Error ? err.message : String(err),
        severity: "BLOCKER",
      });
      pricingResult = {
        sourceFinalPrice: v.price.final || 0,
        markupMode: config.markupMode ?? "percentage",
        markupValue: config.markupValue ?? 20,
        preRoundPrice: 0,
        roundingAdjustment: 0,
        finalSellingPrice: 0,
      };
    }

    // Stock Policy
    let inventoryResult: ShopeeInventoryDraft;
    try {
      inventoryResult = calculateShopeeInventory(v.inventory, {
        safetyStock: config.safetyStock,
        undisclosedStockPolicy: config.undisclosedStockPolicy,
      });
    } catch (err) {
      if (err instanceof ShopeePolicyError) {
        issues.push({
          code: err.code,
          field: `variants[${idx}].inventory`,
          message: err.message,
          severity: "BLOCKER",
        });
        inventoryResult = {
          sourceAvailable: v.inventory.available,
          sourceExact: v.inventory.exact,
          sourceQuantity: v.inventory.quantity,
          destinationQuantity: undefined,
          destinationStock: undefined,
          policy: "unknown_blocked",
          policyApplied: "unknown_blocked",
          status: "blocked",
          publishable: false,
        };
      } else {
        throw err;
      }
    }

    if (inventoryResult.status === "blocked") {
      issues.push({
        code:
          inventoryResult.policy === "inconsistent_stock_blocked"
            ? "MARKETPLACE_STOCK_INCONSISTENT"
            : "MARKETPLACE_STOCK_UNKNOWN",
        field: `variants[${idx}].inventory`,
        message: `Variant ${v.sourceSkuId} has invalid or incomplete stock in source and cannot be published`,
        severity: "BLOCKER",
      });
    } else if (inventoryResult.status === "needs_review") {
      issues.push({
        code: "MARKETPLACE_STOCK_UNDISCLOSED",
        field: `variants[${idx}].inventory`,
        message: `Variant ${v.sourceSkuId} has undisclosed stock quantity; requires manual safety stock setting`,
        severity: "WARNING",
      });
    }

    const weightGrams = typeof v.weightGrams === "number" && v.weightGrams > 0 ? v.weightGrams : undefined;
    if (weightGrams === undefined) {
      issues.push({
        code: "MARKETPLACE_WEIGHT_REQUIRED",
        field: `variants[${idx}].weightGrams`,
        message: `Variant ${v.sourceSkuId} has no source weight specified; destination weight is required`,
        severity: "BLOCKER",
      });
    } else if (weightGrams > maxWeight) {
      maxWeight = weightGrams;
    }

    let varStatus: ShopeeVariantDraft["status"] = "ACTIVE";
    if (inventoryResult.destinationQuantity === 0) {
      varStatus = "OUT_OF_STOCK";
    } else if (inventoryResult.status === "blocked") {
      varStatus = "BLOCKED";
    } else if (inventoryResult.status === "needs_review") {
      varStatus = "NEEDS_REVIEW";
    }

    const shopeeVariationSku = v.merchantSku ?? v.sourceSkuId;

    variantDrafts.push({
      sourceSkuId: v.sourceSkuId,
      merchantSku: v.merchantSku,
      displaySku: v.displaySku,
      shopeeVariationSku,
      attributes: { ...v.attributes },
      tierIndex: idx,
      pricing: pricingResult,
      inventory: inventoryResult,
      weightGrams,
      status: varStatus,
    });
  }

  if (variantDrafts.length === 0) {
    issues.push({
      code: "SHOPEE_VARIANTS_REQUIRED",
      field: "variants",
      message: "Listing must have at least one product variant",
      severity: "BLOCKER",
    });
  }

  // 7. Validation Evaluation & Publication Readiness
  const blockerCount = issues.filter((i) => i.severity === "BLOCKER").length;
  const warningCount = issues.filter((i) => i.severity === "WARNING").length;
  const validationReady = blockerCount === 0;
  const eligibleForApproval = validationReady;
  // canPublish is strictly false until human review decision APPROVE is recorded AND all fields resolved
  const canPublish = false;

  const validation: MarketplaceValidationResult = {
    valid: blockerCount === 0,
    validationReady,
    eligibleForApproval,
    canPublish,
    issues,
    blockerCount,
    warningCount,
  };

  // Determine initial workflow status
  let draftStatus: ShopeeListingDraft["status"] = "READY_FOR_REVIEW";
  if (blockerCount > 0) {
    draftStatus = "BLOCKED";
  } else if (category.status === "needs_review" || warningCount > 0) {
    draftStatus = "NEEDS_REVIEW";
  } else {
    draftStatus = "READY_FOR_REVIEW";
  }

  const idempotencyKey = formatIdempotencyKey({
    marketplace: "shopee",
    sellerAccount: sellerAccountKey,
    source: "jakmall",
    sourceProductId: product.sourceProductId,
    operationType: "CREATE_LISTING",
  });

  return {
    marketplace: "shopee",
    shopId,
    sellerAccountKey,
    source: "jakmall",
    sourceProductId: product.sourceProductId,
    sourceUrl: product.sourceUrl,
    sourceSellerName: product.seller.name,
    sourceTitle: product.title,
    preparedTitle,
    sourceDescription: product.description,
    preparedDescription,
    brand,
    category,
    attributes,
    variants: variantDrafts,
    images: imageDrafts,
    totalWeightGrams: maxWeight > 0 ? maxWeight : undefined,
    status: draftStatus,
    validation,
    idempotencyKey,
    createdAt: new Date(),
  };
}

/**
 * Applies a human operator's review decision to a Shopee draft.
 * 
 * Rules:
 * - A draft with active BLOCKER issues cannot be approved.
 * - An approved draft can only reach canPublish: true if:
 *   1. Category is verified/manual (status === "mapped" and targetCategoryId exists)
 *   2. Inventory policies are resolved (no destinationQuantity === undefined)
 *   3. No active blockers exist
 */
export function applyHumanReview(
  draft: ShopeeListingDraft,
  decision: HumanReviewRecord
): ShopeeListingDraft {
  if (decision.decision === "APPROVE") {
    if (draft.validation.blockerCount > 0) {
      throw new Error(
        `Cannot approve draft with ${draft.validation.blockerCount} active blockers. Fix blockers before approving.`
      );
    }

    if (draft.category.status !== "mapped" || !draft.category.targetCategoryId) {
      throw new Error(
        `Cannot approve draft for publication without a verified destination category ID. Category status is currently "${draft.category.status}".`
      );
    }

    const unresolvedInventory = draft.variants.some(
      (v) => v.inventory.destinationQuantity === undefined
    );
    if (unresolvedInventory) {
      throw new Error(
        "Cannot approve draft for publication with unresolved inventory quantities. Please configure safety stock or review variants."
      );
    }

    return {
      ...draft,
      review: decision,
      status: "APPROVED_FOR_PUBLISH",
      validation: {
        ...draft.validation,
        eligibleForApproval: false,
        canPublish: true,
      },
    };
  }

  if (decision.decision === "REJECT") {
    return {
      ...draft,
      review: decision,
      status: "REJECTED",
      validation: {
        ...draft.validation,
        eligibleForApproval: false,
        canPublish: false,
      },
    };
  }

  // EDIT_REQUIRED
  return {
    ...draft,
    review: decision,
    status: "EDIT_REQUIRED",
    validation: {
      ...draft.validation,
      eligibleForApproval: true,
      canPublish: false,
    },
  };
}
