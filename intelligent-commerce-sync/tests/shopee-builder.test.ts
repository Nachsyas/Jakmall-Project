import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import { buildShopeeDraft, applyHumanReview } from "../src/marketplace/shopee/builder.js";
import type { CanonicalProduct } from "../src/canonical/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

test("buildShopeeDraft prepares ACMIC golden fixture into valid Shopee draft with semantic review status", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );

  const draft = buildShopeeDraft(canonical, {
    markupMode: "percentage",
    markupValue: 20,
    roundingUnit: 1000,
  });

  assert.equal(draft.marketplace, "shopee");
  assert.equal(draft.sourceProductId, "6970238281488");
  assert.equal(draft.variants.length, 9, "All 9 ACMIC variants must be preserved");

  // Category is a semantic suggestion and requires human review or manual category ID
  assert.equal(draft.category.status, "needs_review");
  assert.equal(draft.category.targetCategoryId, undefined);
  assert.equal(draft.category.targetCategoryName, "Aksesoris Handphone > Charger & Kabel > Kepala Charger");

  // Verify Active SKU (5502951494118)
  const activeVar = draft.variants.find((v) => v.sourceSkuId === "5502951494118");
  assert.ok(activeVar);
  assert.equal(activeVar.pricing.sourceFinalPrice, 379000);
  assert.equal(activeVar.pricing.finalSellingPrice, 455000);
  assert.equal(activeVar.inventory.destinationQuantity, 3);
  assert.equal(activeVar.inventory.policy, "exact_passthrough");
  assert.equal(activeVar.status, "ACTIVE");

  // Verify Out-of-Stock SKUs have destinationQuantity = 0
  const oosVar = draft.variants.find((v) => v.sourceSkuId === "7340637866967");
  assert.ok(oosVar);
  assert.equal(oosVar.pricing.sourceFinalPrice, 449000);
  assert.equal(oosVar.pricing.finalSellingPrice, 539000);
  assert.equal(oosVar.inventory.destinationQuantity, 0);
  assert.equal(oosVar.inventory.policy, "out_of_stock_zero");
  assert.equal(oosVar.status, "OUT_OF_STOCK");

  // Validation checks: Validation is ready, but canPublish is strictly FALSE before approval
  assert.equal(draft.validation.blockerCount, 0);
  assert.equal(draft.validation.validationReady, true);
  assert.equal(draft.validation.eligibleForApproval, true);
  assert.equal(draft.validation.canPublish, false, "canPublish must be false before human APPROVE");
  assert.equal(draft.status, "NEEDS_REVIEW");
});

test("buildShopeeDraft strictly does NOT mutate input CanonicalProduct (Zero Source Mutation Regression)", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );

  // Take a deep snapshot clone before buildShopeeDraft execution
  const canonicalSnapshot = JSON.parse(JSON.stringify(canonical));

  // Run buildShopeeDraft
  const draft = buildShopeeDraft(canonical, {
    markupMode: "percentage",
    markupValue: 35,
    roundingUnit: 500,
    titlePrefix: "[OFFICIAL]",
  });

  // Verify draft produced different values
  assert.ok(draft.preparedTitle.startsWith("[OFFICIAL]"));

  // Verify canonical object is 100% identical to snapshot
  assert.deepEqual(
    JSON.parse(JSON.stringify(canonical)),
    canonicalSnapshot,
    "CanonicalProduct was mutated during Shopee draft build!"
  );
  assert.equal(canonical.variants[0]?.price.final, 379000, "Variant price was mutated");
  assert.equal(canonical.title, canonicalSnapshot.title, "Title was mutated");
});

test("applyHumanReview manages review decisions and enforces category and stock resolution before approval", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );

  // 1. Unresolved category cannot be approved
  const draftUnresolvedCategory = buildShopeeDraft(canonical);
  assert.throws(
    () =>
      applyHumanReview(draftUnresolvedCategory, {
        decision: "APPROVE",
        reviewedBy: "operator-1",
        reviewedAt: new Date(),
      }),
    /Cannot approve draft for publication without a verified destination category ID/
  );

  // 2. Draft with manual category ID and resolved stock can be approved
  const draftResolved = buildShopeeDraft(canonical, {
    categoryOverrideId: "manual-charger-id",
  });
  assert.equal(draftResolved.category.status, "mapped");

  const approved = applyHumanReview(draftResolved, {
    decision: "APPROVE",
    reviewedBy: "operator-1",
    reviewedAt: new Date(),
  });
  assert.equal(approved.status, "APPROVED_FOR_PUBLISH");
  assert.equal(approved.validation.canPublish, true);
  assert.equal(approved.validation.eligibleForApproval, false);

  // 3. Rejection sets status to REJECTED and canPublish to false
  const rejected = applyHumanReview(draftResolved, {
    decision: "REJECT",
    reviewedBy: "operator-1",
    reviewedAt: new Date(),
    notes: "Declined by operator",
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.validation.canPublish, false);

  // 4. EDIT_REQUIRED sets status to EDIT_REQUIRED
  const editRequired = applyHumanReview(draftResolved, {
    decision: "EDIT_REQUIRED",
    reviewedBy: "operator-1",
    reviewedAt: new Date(),
    notes: "Fix title prefix",
  });
  assert.equal(editRequired.status, "EDIT_REQUIRED");
  assert.equal(editRequired.validation.canPublish, false);
});
