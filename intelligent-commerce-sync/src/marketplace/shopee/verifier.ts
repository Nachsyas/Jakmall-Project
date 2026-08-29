import type {
  MarketplaceVerificationResult,
  MarketplaceVerificationMismatchDetail,
  MarketplacePublishResult,
} from "../types.js";
import type { ShopeeListingDraft } from "./types.js";

export interface RemoteShopeeListingState {
  itemId: string;
  title: string;
  status: string; // e.g. "NORMAL", "BANNED", "UNLIST"
  variants: Array<{
    variationSku: string;
    price: number;
    stock: number;
  }>;
}

export interface ShopeeRemoteReader {
  fetchListingState(itemId: string): Promise<RemoteShopeeListingState | null>;
}

/**
 * Verifier engine that performs read-after-write verification on Shopee listings.
 * 
 * Rules:
 * - Dry-run operations return "NOT_APPLICABLE_TO_DRY_RUN".
 * - Blocked or failed publications return "BLOCKED" or "FAILED".
 * - For published items, reads current state and checks title, variant count, prices, and stock.
 * - Missing listing returns "VERIFY_NOT_FOUND".
 * - Discrepancy returns "VERIFY_MISMATCH".
 * - Perfect match returns "VERIFIED".
 */
export class ShopeeListingVerifier {
  constructor(private readonly reader?: ShopeeRemoteReader | undefined) {}

  async verify(
    publishResult: MarketplacePublishResult,
    expectedDraft: ShopeeListingDraft
  ): Promise<MarketplaceVerificationResult> {
    const verifiedAt = new Date();

    if (publishResult.status !== "PUBLISHED") {
      if (publishResult.status === "DRY_RUN_COMPLETED") {
        return {
          status: "NOT_APPLICABLE_TO_DRY_RUN",
          marketplace: "shopee",
          verifiedAt,
          mismatches: [],
          message: "Read-after-write verification is not applicable to dry-run operations",
        };
      }
      if (publishResult.status === "PUBLISH_FAILED") {
        return {
          status: "FAILED",
          marketplace: "shopee",
          verifiedAt,
          mismatches: [],
          message: `Verification failed because publish operation failed: ${publishResult.error}`,
        };
      }
      return {
        status: "BLOCKED",
        marketplace: "shopee",
        verifiedAt,
        mismatches: [],
        message: `Verification skipped because publication was blocked: ${publishResult.status}`,
      };
    }

    // Verification on PUBLISHED listing
    const listingId = publishResult.marketplaceListingId;
    if (!this.reader) {
      return {
        status: "FAILED",
        marketplace: "shopee",
        marketplaceListingId: listingId,
        verifiedAt,
        mismatches: [],
        message: "Verification reader not configured for remote Shopee access",
      };
    }

    try {
      const remote = await this.reader.fetchListingState(listingId);
      if (!remote) {
        return {
          status: "VERIFY_NOT_FOUND",
          marketplace: "shopee",
          marketplaceListingId: listingId,
          verifiedAt,
          mismatches: [],
          message: `Listing ${listingId} not found on Shopee marketplace`,
        };
      }

      const mismatches: MarketplaceVerificationMismatchDetail[] = [];

      // Check Title
      if (remote.title !== expectedDraft.preparedTitle) {
        mismatches.push({
          field: "title",
          expected: expectedDraft.preparedTitle,
          actual: remote.title,
          message: `Title mismatch: expected "${expectedDraft.preparedTitle}", got "${remote.title}"`,
        });
      }

      // Check Variant Count
      if (remote.variants.length !== expectedDraft.variants.length) {
        mismatches.push({
          field: "variantCount",
          expected: expectedDraft.variants.length,
          actual: remote.variants.length,
          message: `Variant count mismatch: expected ${expectedDraft.variants.length}, got ${remote.variants.length}`,
        });
      }

      // Check Prices & Stock per variant
      for (const expectedVar of expectedDraft.variants) {
        const remoteVar = remote.variants.find(
          (rv) => rv.variationSku === expectedVar.shopeeVariationSku
        );

        if (!remoteVar) {
          mismatches.push({
            field: `variants[${expectedVar.shopeeVariationSku}]`,
            expected: expectedVar.shopeeVariationSku,
            actual: null,
            message: `Variant SKU "${expectedVar.shopeeVariationSku}" missing in remote listing`,
          });
          continue;
        }

        if (remoteVar.price !== expectedVar.pricing.finalSellingPrice) {
          mismatches.push({
            field: `variants[${expectedVar.shopeeVariationSku}].price`,
            expected: expectedVar.pricing.finalSellingPrice,
            actual: remoteVar.price,
            message: `Price mismatch for SKU "${expectedVar.shopeeVariationSku}": expected Rp${expectedVar.pricing.finalSellingPrice}, got Rp${remoteVar.price}`,
          });
        }

        const expectedStock = expectedVar.inventory.destinationQuantity ?? expectedVar.inventory.destinationStock ?? 0;
        if (remoteVar.stock !== expectedStock) {
          mismatches.push({
            field: `variants[${expectedVar.shopeeVariationSku}].stock`,
            expected: expectedStock,
            actual: remoteVar.stock,
            message: `Stock mismatch for SKU "${expectedVar.shopeeVariationSku}": expected ${expectedStock}, got ${remoteVar.stock}`,
          });
        }
      }

      if (mismatches.length > 0) {
        return {
          status: "VERIFY_MISMATCH",
          marketplace: "shopee",
          marketplaceListingId: listingId,
          verifiedAt,
          mismatches,
          message: `Verification found ${mismatches.length} discrepancies between draft and remote listing`,
        };
      }

      return {
        status: "VERIFIED",
        marketplace: "shopee",
        marketplaceListingId: listingId,
        verifiedAt,
        mismatches: [],
        message: "Remote Shopee listing perfectly verified against approved draft",
      };
    } catch (err) {
      return {
        status: "FAILED",
        marketplace: "shopee",
        marketplaceListingId: listingId,
        verifiedAt,
        mismatches: [],
        message: `Remote verification call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
