import type { CanonicalProduct } from "../../canonical/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceOperationMode,
  MarketplacePublishResult,
  MarketplaceValidationResult,
  MarketplaceVerificationResult,
} from "../types.js";
import type {
  ShopeeListingDraft,
  ShopeePreparationConfig,
} from "./types.js";
import { buildShopeeDraft } from "./builder.js";
import { ShopeeListingVerifier, type ShopeeRemoteReader } from "./verifier.js";

export interface ShopeeCredentials {
  partnerId: string;
  partnerKey: string;
  shopId: string;
  accessToken: string;
}

export interface ShopeeTransport {
  publishItem(payload: Record<string, unknown>): Promise<{ itemId: string; rawResponse?: Record<string, unknown> }>;
}

/**
 * Concrete MarketplaceAdapter implementation for Shopee Indonesia.
 * 
 * Supports:
 * - Deterministic draft preparation from CanonicalProduct
 * - Validation & human review compliance checks
 * - Dry-run payload simulation without network side-effects
 * - Safe authorized publishing boundary (strictly reports BLOCKED_BY_CREDENTIALS when missing)
 * - Read-after-write verification
 */
export class ShopeeMarketplaceAdapter implements MarketplaceAdapter<ShopeeListingDraft> {
  readonly marketplaceName = "shopee";
  private readonly verifier: ShopeeListingVerifier;

  constructor(
    private readonly credentials?: ShopeeCredentials | undefined,
    private readonly transport?: ShopeeTransport | undefined,
    remoteReader?: ShopeeRemoteReader | undefined
  ) {
    this.verifier = new ShopeeListingVerifier(remoteReader);
  }

  async prepareListing(
    product: CanonicalProduct,
    config: ShopeePreparationConfig = {}
  ): Promise<ShopeeListingDraft> {
    return buildShopeeDraft(product, config);
  }

  async validateListing(draft: ShopeeListingDraft): Promise<MarketplaceValidationResult> {
    return draft.validation;
  }

  async publishListing(
    draft: ShopeeListingDraft,
    mode: MarketplaceOperationMode
  ): Promise<MarketplacePublishResult> {
    // 1. Dry Run Mode
    if (mode === "dry_run") {
      if (draft.validation.blockerCount > 0) {
        return {
          status: "BLOCKED_BY_VALIDATION",
          mode: "dry_run",
          marketplace: "shopee",
          reason: `Draft has ${draft.validation.blockerCount} active blocker(s)`,
          blockers: draft.validation.issues.filter((i) => i.severity === "BLOCKER"),
          idempotencyKey: draft.idempotencyKey,
        };
      }

      // Generate internal prepared marketplace operation
      const preparedOperation: Record<string, unknown> = {
        title: draft.preparedTitle,
        description: draft.preparedDescription,
        category: {
          targetCategoryId: draft.category.targetCategoryId,
          suggestion: draft.category.targetCategoryName,
        },
        brand: draft.brand,
        weightGrams: draft.totalWeightGrams,
        variants: draft.variants.map((v) => ({
          sourceSkuId: v.sourceSkuId,
          destinationSku: v.shopeeVariationSku,
          attributes: v.attributes,
          sellingPriceIdr: v.pricing.finalSellingPrice,
          destinationQuantity: v.inventory.destinationQuantity,
        })),
        images: draft.images.filter((img) => img.valid).map((img) => ({ url: img.sourceUrl })),
      };

      return {
        status: "DRY_RUN_COMPLETED",
        mode: "dry_run",
        marketplace: "shopee",
        simulatedListingId: `sim-shopee-${draft.sourceProductId}`,
        preparedAt: new Date(),
        idempotencyKey: draft.idempotencyKey,
        preparedOperation,
        simulatedPayload: preparedOperation,
      };
    }

    // 2. Publish Mode: Safety Gates

    // Gate A: Validation Blockers
    if (draft.validation.blockerCount > 0) {
      return {
        status: "BLOCKED_BY_VALIDATION",
        mode: "publish",
        marketplace: "shopee",
        reason: `Publication blocked: Draft contains ${draft.validation.blockerCount} active blocker(s)`,
        blockers: draft.validation.issues.filter((i) => i.severity === "BLOCKER"),
        idempotencyKey: draft.idempotencyKey,
      };
    }

    // Gate B: Category Verification Check
    if (draft.category.status !== "mapped" || !draft.category.targetCategoryId) {
      return {
        status: "BLOCKED_BY_VALIDATION",
        mode: "publish",
        marketplace: "shopee",
        reason: `Publication blocked: Destination Shopee category ID is unresolved (status: ${draft.category.status})`,
        blockers: [
          {
            code: "MARKETPLACE_CATEGORY_UNRESOLVED",
            field: "category",
            message: "A verified or manual numeric Shopee category ID is required before publication",
            severity: "BLOCKER",
          },
        ],
        idempotencyKey: draft.idempotencyKey,
      };
    }

    // Gate C: Human Review Gate
    if (
      draft.status !== "APPROVED_FOR_PUBLISH" ||
      !draft.review ||
      draft.review.decision !== "APPROVE"
    ) {
      return {
        status: "BLOCKED_BY_REVIEW",
        mode: "publish",
        marketplace: "shopee",
        reason: "Publication blocked: Draft requires human review approval before publish",
        blockers: [
          {
            code: "MARKETPLACE_REVIEW_REQUIRED",
            field: "review",
            message: "Draft has not received an 'APPROVE' decision from human operator",
            severity: "BLOCKER",
          },
        ],
        idempotencyKey: draft.idempotencyKey,
      };
    }

    // Gate D: Credentials Check (Never bypass credentials even if transport is provided)
    const creds = this.resolveCredentials();
    if (!creds) {
      return {
        status: "BLOCKED_BY_CREDENTIALS",
        mode: "publish",
        marketplace: "shopee",
        reason:
          "Publication blocked: Shopee Open Platform credentials not configured (requires SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID, SHOPEE_ACCESS_TOKEN)",
        blockers: [
          {
            code: "MARKETPLACE_CREDENTIALS_MISSING",
            field: "credentials",
            message: "Shopee API partner credentials or OAuth access token missing in environment",
            severity: "BLOCKER",
          },
        ],
        idempotencyKey: draft.idempotencyKey,
      };
    }

    // Gate E: Execution via Authorized Transport (e.g. In test context or live partner SDK)
    if (this.transport) {
      try {
        const internalPreparedPayload: Record<string, unknown> = {
          title: draft.preparedTitle,
          description: draft.preparedDescription,
          category: {
            targetCategoryId: draft.category.targetCategoryId,
            suggestion: draft.category.targetCategoryName,
          },
          brand: draft.brand,
          weightGrams: draft.totalWeightGrams,
          variants: draft.variants.map((v) => ({
            sourceSkuId: v.sourceSkuId,
            destinationSku: v.shopeeVariationSku,
            attributes: v.attributes,
            sellingPriceIdr: v.pricing.finalSellingPrice,
            destinationQuantity: v.inventory.destinationQuantity,
          })),
          images: draft.images.filter((img) => img.valid).map((img) => ({ url: img.sourceUrl })),
        };

        const response = await this.transport.publishItem(internalPreparedPayload);
        return {
          status: "PUBLISHED",
          mode: "publish",
          marketplace: "shopee",
          marketplaceListingId: response.itemId,
          publishedAt: new Date(),
          idempotencyKey: draft.idempotencyKey,
          rawResponse: response.rawResponse,
        };
      } catch (err) {
        return {
          status: "PUBLISH_FAILED",
          mode: "publish",
          marketplace: "shopee",
          error: err instanceof Error ? err.message : String(err),
          idempotencyKey: draft.idempotencyKey,
        };
      }
    }

    // If credentials are present but no remote transport configured in PoC
    return {
      status: "BLOCKED_BY_PLATFORM_ACCESS",
      mode: "publish",
      marketplace: "shopee",
      reason: "Official Shopee Open Platform partner transport not initialized for remote network write",
      blockers: [
        {
          code: "MARKETPLACE_TRANSPORT_UNAVAILABLE",
          field: "transport",
          message: "Shopee HTTP transport client required for live network write",
          severity: "BLOCKER",
        },
      ],
      idempotencyKey: draft.idempotencyKey,
    };
  }

  async verifyListing(
    publishResult: MarketplacePublishResult,
    expectedDraft: ShopeeListingDraft
  ): Promise<MarketplaceVerificationResult> {
    return this.verifier.verify(publishResult, expectedDraft);
  }

  private resolveCredentials(): ShopeeCredentials | null {
    if (this.credentials) {
      return this.credentials;
    }

    const partnerId = process.env.SHOPEE_PARTNER_ID;
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;
    const shopId = process.env.SHOPEE_SHOP_ID;
    const accessToken = process.env.SHOPEE_ACCESS_TOKEN;

    if (partnerId && partnerKey && shopId && accessToken) {
      return { partnerId, partnerKey, shopId, accessToken };
    }

    return null;
  }
}
