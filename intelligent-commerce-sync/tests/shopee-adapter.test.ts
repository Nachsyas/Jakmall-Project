import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import { buildShopeeDraft, applyHumanReview } from "../src/marketplace/shopee/builder.js";
import { ShopeeMarketplaceAdapter, type ShopeeTransport } from "../src/marketplace/shopee/adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

function getAcmicDraft(categoryOverrideId?: string) {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );
  return buildShopeeDraft(canonical, {
    categoryOverrideId,
    sellerAccountKey: "local-demo-shop",
  });
}

test("ShopeeMarketplaceAdapter dry_run mode generates simulated payload without remote call", async () => {
  let transportCalls = 0;
  const mockTransport: ShopeeTransport = {
    async publishItem() {
      transportCalls++;
      return { itemId: "mock-123" };
    },
  };

  const adapter = new ShopeeMarketplaceAdapter(undefined, mockTransport);
  const draft = getAcmicDraft();

  const result = await adapter.publishListing(draft, "dry_run");

  assert.equal(result.status, "DRY_RUN_COMPLETED");
  assert.equal(result.mode, "dry_run");
  assert.equal(transportCalls, 0, "dry_run must never perform remote calls");
  assert.ok(result.simulatedPayload);
  assert.equal(result.simulatedPayload["item_name"], draft.preparedTitle);
});

test("ShopeeMarketplaceAdapter publish mode blocks when credentials are missing", async () => {
  // Clear environment credentials for this test
  delete process.env.SHOPEE_PARTNER_KEY;
  delete process.env.SHOPEE_SHOP_ID;

  const adapter = new ShopeeMarketplaceAdapter(); // No credentials supplied
  // Provide manual category ID so draft can reach approved state
  const draft = getAcmicDraft("manual-cat-override-99");

  // Approve draft so review gate passes
  const approvedDraft = applyHumanReview(draft, {
    decision: "APPROVE",
    reviewedBy: "reviewer-1",
    reviewedAt: new Date(),
  });

  const result = await adapter.publishListing(approvedDraft, "publish");

  assert.equal(result.status, "BLOCKED_BY_CREDENTIALS");
  assert.notEqual(result.status, "PUBLISHED", "Must never fake successful publish without credentials");
  assert.ok(result.blockers.length > 0);
  assert.equal(result.blockers[0]?.code, "MARKETPLACE_CREDENTIALS_MISSING");
});

test("ShopeeMarketplaceAdapter publish mode blocks unapproved drafts requiring review", async () => {
  const adapter = new ShopeeMarketplaceAdapter();
  const draft = getAcmicDraft("manual-cat-override-99");

  assert.equal(draft.review, undefined);

  const result = await adapter.publishListing(draft, "publish");
  assert.equal(result.status, "BLOCKED_BY_REVIEW");
});

test("authorized publication boundary tested using mock transport (test-only, not live Shopee write)", async () => {
  let publishedPayload: Record<string, unknown> | null = null;
  const mockTransport: ShopeeTransport = {
    async publishItem(payload) {
      publishedPayload = payload;
      return { itemId: "mock-shopee-item-998877", rawResponse: { mockSuccess: true } };
    },
  };

  const creds = {
    partnerId: "test-partner-123",
    partnerKey: "mock-secret-key",
    shopId: "mock-shop-1",
    accessToken: "mock-token-abc",
  };

  const adapter = new ShopeeMarketplaceAdapter(creds, mockTransport);
  const draft = getAcmicDraft("manual-cat-override-99");
  const approvedDraft = applyHumanReview(draft, {
    decision: "APPROVE",
    reviewedBy: "operator-1",
    reviewedAt: new Date(),
  });

  const result = await adapter.publishListing(approvedDraft, "publish");

  assert.equal(result.status, "PUBLISHED");
  if (result.status === "PUBLISHED") {
    assert.equal(result.marketplaceListingId, "mock-shopee-item-998877");
    assert.ok(publishedPayload);
  }
});

test("ShopeeMarketplaceAdapter publish mode blocks when destination category is unresolved", async () => {
  const adapter = new ShopeeMarketplaceAdapter();
  const draft = getAcmicDraft(); // Unresolved category

  const result = await adapter.publishListing(draft, "publish");
  assert.equal(result.status, "BLOCKED_BY_VALIDATION");
  assert.equal(result.blockers[0]?.code, "MARKETPLACE_CATEGORY_UNRESOLVED");
});
