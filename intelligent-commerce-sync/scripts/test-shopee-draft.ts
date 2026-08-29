#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  parseJakmallHtml,
  normalizeToCanonical,
  buildShopeeDraft,
  ShopeeMarketplaceAdapter,
  type CanonicalProduct,
} from "../src/index.js";

async function main() {
  const target = process.argv[2] ?? "tests/fixtures/acmic.html";

  console.log("==================================================");
  console.log("   Shopee Listing Preparation & Review Preview    ");
  console.log("==================================================");
  console.log(`Target: ${target}\n`);

  let canonical: CanonicalProduct;

  if (target.startsWith("http://") || target.startsWith("https://")) {
    console.log(`[1/4] Fetching live URL: ${target}...`);
    const adapter = new (await import("../src/jakmall/adapter.js")).JakMallSourceAdapter();
    canonical = await adapter.fetchProduct(target);
  } else {
    console.log(`[1/4] Reading local HTML fixture: ${target}...`);
    const resolvedPath = path.resolve(process.cwd(), target);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: File not found at ${resolvedPath}`);
      process.exit(1);
    }
    const html = fs.readFileSync(resolvedPath, "utf-8");
    const parsed = parseJakmallHtml(html);
    canonical = normalizeToCanonical(
      parsed,
      "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
    );
  }

  console.log(`      ✓ Canonical Product ID : ${canonical.sourceProductId}`);
  console.log(`      ✓ Title                : "${canonical.title}"`);
  console.log(`      ✓ Total Variants       : ${canonical.variants.length}`);

  console.log("\n[2/4] Applying Shopee Mapping, Pricing & Stock Policy...");
  const draft = buildShopeeDraft(canonical, {
    sellerAccountKey: "local-demo-shop", // Explicit local demo identifier (not a real Shopee seller account)
    markupMode: "percentage",
    markupValue: 20, // 20% markup
    roundingUnit: 1000,
    safetyStock: 5,
    undisclosedStockPolicy: "needs_review",
  });

  console.log(`      ✓ Prepared Title       : "${draft.preparedTitle}"`);
  console.log(`      ✓ Category Suggestion  : ${draft.category.targetCategoryName ?? "None"}`);
  console.log(`      ✓ Category ID          : ${draft.category.targetCategoryId ?? "UNRESOLVED"}`);
  console.log(`      ✓ Category Status      : ${draft.category.status.toUpperCase()} (${draft.category.method})`);
  console.log(`      ✓ Source Brand         : ${draft.brand ?? "None (UNSET)"}`);

  console.log("\n[3/4] Variants & Inventory Breakdown:");
  console.log("--------------------------------------------------------------------------------------------------");
  console.log(
    " SKU ID         | Shopee SKU       | Attrs               | Source Final | Selling Price | Stock | Status"
  );
  console.log("--------------------------------------------------------------------------------------------------");
  for (const v of draft.variants) {
    const sku = v.sourceSkuId.padEnd(14, " ");
    const shopeeSku = v.shopeeVariationSku.padEnd(16, " ");
    const attrs = Object.values(v.attributes).join(", ").slice(0, 19).padEnd(19, " ");
    const srcPrice = `Rp${v.pricing.sourceFinalPrice.toLocaleString("id-ID")}`.padEnd(12, " ");
    const sellPrice = `Rp${v.pricing.finalSellingPrice.toLocaleString("id-ID")}`.padEnd(13, " ");
    const stockDisplay = v.inventory.destinationQuantity !== undefined ? `${v.inventory.destinationQuantity}` : "UNDISCLOSED";
    const stock = stockDisplay.padEnd(5, " ");
    const status = v.status.padEnd(12, " ");
    console.log(` ${sku} | ${shopeeSku} | ${attrs} | ${srcPrice} | ${sellPrice} | ${stock} | ${status}`);
  }
  console.log("--------------------------------------------------------------------------------------------------");

  console.log("\n[4/4] Validation & Safety Review:");
  console.log(`      Validation Ready      : ${draft.validation.validationReady}`);
  console.log(`      Eligible for Approval : ${draft.validation.eligibleForApproval}`);
  console.log(`      Human Review          : ${draft.review?.decision ?? "PENDING"}`);
  console.log(`      Can Publish           : ${draft.validation.canPublish}`);
  console.log(`      Blockers              : ${draft.validation.blockerCount}`);
  console.log(`      Warnings              : ${draft.validation.warningCount}`);

  if (draft.validation.issues.length > 0) {
    console.log("\n      Detailed Issues:");
    for (const issue of draft.validation.issues) {
      console.log(`      - [${issue.severity}] (${issue.code}) ${issue.field}: ${issue.message}`);
    }
  }

  console.log("\n[5/5] Executing Adapter Simulation (Dry Run)...");
  console.log("      Adapter Mode          : DRY_RUN");
  const shopeeAdapter = new ShopeeMarketplaceAdapter();
  const dryRunResult = await shopeeAdapter.publishListing(draft, "dry_run");

  console.log(`      ✓ Adapter Result       : ${dryRunResult.status}`);
  console.log(`      ✓ Idempotency Key      : ${dryRunResult.idempotencyKey}`);

  console.log("\n==================================================");
  console.log(`FINAL WORKFLOW STATE   : ${draft.status}`);
  console.log(`FINAL ADAPTER RESULT   : ${dryRunResult.status}`);
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Diagnostic execution error:", err);
  process.exit(1);
});
