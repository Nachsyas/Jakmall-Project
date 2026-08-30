import test from "node:test";
import assert from "node:assert/strict";
import {
  ShopeeListingVerifier,
  type ShopeeRemoteReader,
  type RemoteShopeeListingState,
} from "../src/marketplace/shopee/verifier.js";
import type {
  MarketplacePublishResult,
} from "../src/marketplace/types.js";
import type { ShopeeListingDraft } from "../src/marketplace/shopee/types.js";

function getMinimalDraft(): ShopeeListingDraft {
  return {
    marketplace: "shopee",
    shopId: "local-demo-shop",
    sellerAccountKey: "local-demo-shop",
    source: "jakmall",
    sourceProductId: "prod-1",
    sourceUrl: "https://www.jakmall.com/item",
    sourceSellerName: "Seller",
    sourceTitle: "Charger 65W",
    preparedTitle: "Charger 65W Fast",
    sourceDescription: "Desc",
    preparedDescription: "Desc",
    brand: "ACMIC",
    category: {
      sourceCategoryPath: ["Electronics"],
      confidence: 1.0,
      method: "rule",
      status: "mapped",
      targetCategoryId: "manual-cat-1",
    },
    attributes: [],
    variants: [
      {
        sourceSkuId: "sku-1",
        shopeeVariationSku: "SKU-PRO",
        attributes: { Option: "PRO" },
        tierIndex: 0,
        pricing: {
          sourceFinalPrice: 379000,
          markupMode: "percentage",
          markupValue: 20,
          preRoundPrice: 454800,
          roundingAdjustment: 200,
          finalSellingPrice: 455000,
        },
        inventory: {
          sourceAvailable: true,
          sourceExact: true,
          destinationQuantity: 3,
          destinationStock: 3,
          policy: "exact_passthrough",
          policyApplied: "exact_passthrough",
          status: "resolved",
          publishable: true,
        },
        weightGrams: 230,
        status: "ACTIVE",
      },
    ],
    images: [],
    totalWeightGrams: 230,
    status: "READY_FOR_REVIEW",
    validation: {
      valid: true,
      validationReady: true,
      eligibleForApproval: true,
      canPublish: false,
      issues: [],
      blockerCount: 0,
      warningCount: 0,
    },
    idempotencyKey: "shopee:local-demo-shop:jakmall:prod-1:CREATE_LISTING",
    createdAt: new Date(),
  };
}

test("ShopeeListingVerifier handles dry-run operations cleanly with NOT_APPLICABLE_TO_DRY_RUN", async () => {
  const verifier = new ShopeeListingVerifier();
  const dryRunResult: MarketplacePublishResult = {
    status: "DRY_RUN_COMPLETED",
    mode: "dry_run",
    marketplace: "shopee",
    preparedAt: new Date(),
    idempotencyKey: "key-1",
    preparedOperation: {},
    simulatedPayload: {},
  };

  const result = await verifier.verify(dryRunResult, getMinimalDraft());
  assert.equal(result.status, "NOT_APPLICABLE_TO_DRY_RUN");
  assert.notEqual(result.status, "VERIFIED", "Dry run must never report fake VERIFIED");
});

test("ShopeeListingVerifier verifies simulated mock reader state (test-only, not live remote verification)", async () => {
  const draft = getMinimalDraft();
  const mockRemoteState: RemoteShopeeListingState = {
    itemId: "remote-item-1",
    title: draft.preparedTitle,
    status: "NORMAL",
    variants: [
      {
        variationSku: "SKU-PRO",
        price: 455000,
        stock: 3,
      },
    ],
  };

  const mockReader: ShopeeRemoteReader = {
    async fetchListingState(itemId: string) {
      assert.equal(itemId, "remote-item-1");
      return mockRemoteState;
    },
  };

  const verifier = new ShopeeListingVerifier(mockReader);
  const publishSuccess: MarketplacePublishResult = {
    status: "PUBLISHED",
    mode: "publish",
    marketplace: "shopee",
    marketplaceListingId: "remote-item-1",
    publishedAt: new Date(),
    idempotencyKey: "key-1",
  };

  const result = await verifier.verify(publishSuccess, draft);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.mismatches.length, 0);
});

test("ShopeeListingVerifier detects price and stock mismatches with VERIFY_MISMATCH", async () => {
  const draft = getMinimalDraft();
  const mismatchedRemoteState: RemoteShopeeListingState = {
    itemId: "remote-item-1",
    title: draft.preparedTitle,
    status: "NORMAL",
    variants: [
      {
        variationSku: "SKU-PRO",
        price: 400000, // Expected 455000
        stock: 1, // Expected 3
      },
    ],
  };

  const mockReader: ShopeeRemoteReader = {
    async fetchListingState() {
      return mismatchedRemoteState;
    },
  };

  const verifier = new ShopeeListingVerifier(mockReader);
  const publishSuccess: MarketplacePublishResult = {
    status: "PUBLISHED",
    mode: "publish",
    marketplace: "shopee",
    marketplaceListingId: "remote-item-1",
    publishedAt: new Date(),
    idempotencyKey: "key-1",
  };

  const result = await verifier.verify(publishSuccess, draft);
  assert.equal(result.status, "VERIFY_MISMATCH");
  assert.ok(result.mismatches.length >= 2);
});

test("ShopeeListingVerifier returns VERIFY_NOT_FOUND when listing missing in marketplace", async () => {
  const mockReader: ShopeeRemoteReader = {
    async fetchListingState() {
      return null;
    },
  };

  const verifier = new ShopeeListingVerifier(mockReader);
  const publishSuccess: MarketplacePublishResult = {
    status: "PUBLISHED",
    mode: "publish",
    marketplace: "shopee",
    marketplaceListingId: "nonexistent-item",
    publishedAt: new Date(),
    idempotencyKey: "key-1",
  };

  const result = await verifier.verify(publishSuccess, getMinimalDraft());
  assert.equal(result.status, "VERIFY_NOT_FOUND");
});

test("ShopeeListingVerifier registers mismatch when expected stock is unresolved and never defaults to 0", async () => {
  const draft = getMinimalDraft();
  draft.variants[0]!.inventory.destinationQuantity = undefined;
  draft.variants[0]!.inventory.destinationStock = undefined;

  const mockRemoteState: RemoteShopeeListingState = {
    itemId: "remote-item-1",
    title: draft.preparedTitle,
    status: "NORMAL",
    variants: [
      {
        variationSku: "SKU-PRO",
        price: 455000,
        stock: 0, // Remote has 0, but expected is undefined; must never consider this matched
      },
    ],
  };

  const mockReader: ShopeeRemoteReader = {
    async fetchListingState() {
      return mockRemoteState;
    },
  };

  const verifier = new ShopeeListingVerifier(mockReader);
  const publishSuccess: MarketplacePublishResult = {
    status: "PUBLISHED",
    mode: "publish",
    marketplace: "shopee",
    marketplaceListingId: "remote-item-1",
    publishedAt: new Date(),
    idempotencyKey: "key-1",
  };

  const result = await verifier.verify(publishSuccess, draft);
  assert.equal(result.status, "VERIFY_MISMATCH");
  const stockMismatch = result.mismatches.find((m) => m.field.includes("stock"));
  assert.ok(stockMismatch);
  assert.ok(stockMismatch.message.includes("unresolved (undefined)"));
});
