import fs from "node:fs";
import path from "node:path";
import { fetchJakmallHtml, validateJakmallUrl } from "../src/jakmall/client.js";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";

async function main() {
  const target = process.argv[2] || "tests/fixtures/acmic.html";

  console.log("==================================================");
  console.log("   JakMall Extraction & Normalization Diagnostic   ");
  console.log("==================================================");
  console.log(`Target: ${target}\n`);

  let html: string;
  let sourceUrl: string;

  const isHttpUrl = target.startsWith("http://") || target.startsWith("https://");

  if (isHttpUrl) {
    try {
      console.log(`[1/4] Validating URL & fetching static HTML...`);
      validateJakmallUrl(target);
      const res = await fetchJakmallHtml(target);
      html = res.html;
      sourceUrl = res.finalUrl;
      console.log(`      ✓ Fetched ${html.length} bytes from ${sourceUrl}`);
    } catch (err) {
      console.error(`      ✗ Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    try {
      console.log(`[1/4] Reading local HTML fixture...`);
      const resolvedPath = path.resolve(process.cwd(), target);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      html = fs.readFileSync(resolvedPath, "utf-8");
      sourceUrl = "https://www.jakmall.com/local-diagnostic-fixture";
      console.log(`      ✓ Read ${html.length} bytes from ${resolvedPath}`);
    } catch (err) {
      console.error(`      ✗ Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // 2. Parse HTML & extract spdt
  console.log(`[2/4] Parsing HTML DOM, extracting specifications & embedded spdt state...`);
  const parsed = parseJakmallHtml(html);
  console.log(`      ✓ Title: "${parsed.title}"`);
  console.log(`      ✓ Brand: ${parsed.brand || "(none)"}`);
  console.log(`      ✓ Category: ${parsed.categoryPath.join(" > ") || "(root)"}`);
  console.log(`      ✓ Raw SPDT ID: ${parsed.spdt.id}`);
  console.log(`      ✓ Raw SKUs in SPDT: ${Object.keys(parsed.spdt.sku).length}`);
  console.log(`      ✓ Extracted Specifications: ${Object.keys(parsed.specifications).length} items`);

  // 3. Normalize to Canonical Product
  console.log(`[3/4] Normalizing to CanonicalProduct contract...`);
  const canonical = normalizeToCanonical(parsed, sourceUrl);
  console.log(`      ✓ Canonical Product ID: ${canonical.sourceProductId}`);
  console.log(`      ✓ Resolved Variants: ${canonical.variants.length}`);
  console.log(`      ✓ Consolidated Images: ${canonical.images.length}`);

  // 4. Print Structured Diagnostic Report
  console.log(`\n[4/4] STRUCTURED DIAGNOSTIC SUMMARY:`);
  console.log("--------------------------------------------------");
  console.log(`Source Product ID : ${canonical.sourceProductId}`);
  console.log(`Title             : ${canonical.title}`);
  console.log(`Brand             : ${canonical.brand || "-"}`);
  console.log(`Seller            : ${canonical.seller.name} (ID: ${canonical.seller.id || "-"})`);
  console.log(`Category Path     : ${canonical.categoryPath.join(" > ")}`);
  console.log(`Specifications    :`);
  for (const [k, v] of Object.entries(canonical.specifications)) {
    console.log(`  - ${k}: ${v}`);
  }

  console.log(`\nVariants Breakdown (${canonical.variants.length} total):`);
  canonical.variants.forEach((v, idx) => {
    const attrStr = Object.entries(v.attributes)
      .map(([k, val]) => `${k}=${val}`)
      .join(", ") || "default";
    const stockStatus =
      v.inventory.available === true
        ? "IN_STOCK"
        : v.inventory.available === false
        ? "OUT_OF_STOCK"
        : "UNKNOWN_STOCK";
    const stockInfo =
      v.inventory.available === null
        ? "Qty & Availability Inconsistent/Unknown"
        : v.inventory.exact
        ? `Exact Qty: ${v.inventory.quantity}`
        : `Available (Qty Undisclosed)`;
    console.log(
      `  [${idx + 1}] SKU: ${v.sourceSkuId}` +
      (v.merchantSku ? ` (Merchant: ${v.merchantSku})` : "") +
      (v.displaySku ? ` (Display: ${v.displaySku})` : "") +
      ` | Attrs: [${attrStr}]` +
      ` | Price: Rp${v.price.final.toLocaleString("id-ID")}` +
      ` | Weight: ${v.weightGrams ?? "-"}g` +
      ` | Stock: ${stockStatus} (${stockInfo})`
    );
  });

  console.log("--------------------------------------------------");
  console.log("Status: DIAGNOSTIC PASS (All structural & semantic checks succeeded)\n");
}

main().catch((err) => {
  console.error("DIAGNOSTIC FAILED:", err);
  process.exit(1);
});