import fs from "node:fs";
import path from "node:path";
import { CatalogImportService, type HtmlFetcherFn } from "../src/catalog/catalog-import-service.js";
import { validateJakmallUrl } from "../src/jakmall/client.js";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import type { SourceAdapter } from "../src/jakmall/adapter.js";
import type { CanonicalProduct } from "../src/canonical/types.js";

async function main() {
  const args = process.argv.slice(2);
  let target = "tests/fixtures/catalog-store.html";
  let maxProducts = 10;
  let maxPages = 3;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--limit" && i + 1 < args.length) {
      maxProducts = parseInt(args[++i]!, 10) || 10;
    } else if (arg === "--pages" && i + 1 < args.length) {
      maxPages = parseInt(args[++i]!, 10) || 3;
    } else if (!arg.startsWith("--")) {
      target = arg;
    }
  }

  console.log("==================================================");
  console.log("            JakMall Catalog Discovery             ");
  console.log("==================================================");
  console.log(`Target      : ${target}`);
  console.log(`Limit       : ${maxProducts} products max`);
  console.log(`Max Pages   : ${maxPages} pages max\n`);

  const isHttp = target.startsWith("http://") || target.startsWith("https://");

  let service: CatalogImportService;

  if (isHttp) {
    try {
      validateJakmallUrl(target);
    } catch (err) {
      console.error(`Invalid source URL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    service = new CatalogImportService();
  } else {
    // Local offline fixture mode
    const resolvedPath = path.resolve(process.cwd(), target);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Fixture file not found: ${resolvedPath}`);
      process.exit(1);
    }

    const fixtureHtml = fs.readFileSync(resolvedPath, "utf-8");
    const page2Path = path.resolve(path.dirname(resolvedPath), "catalog-store-page2.html");
    const page2Html = fs.existsSync(page2Path) ? fs.readFileSync(page2Path, "utf-8") : null;

    const mockFetcher: HtmlFetcherFn = async (url: string) => {
      if (url.includes("page=2") && page2Html) {
        return { html: page2Html, finalUrl: "https://www.jakmall.com/acmic-official-store?page=2" };
      }
      return { html: fixtureHtml, finalUrl: "https://www.jakmall.com/acmic-official-store" };
    };

    // Mock SourceAdapter using real acmic fixture for offline demonstration
    const acmicFixturePath = path.resolve(process.cwd(), "tests/fixtures/acmic.html");
    const acmicHtml = fs.existsSync(acmicFixturePath)
      ? fs.readFileSync(acmicFixturePath, "utf-8")
      : fixtureHtml;

    const mockAdapter: SourceAdapter = {
      async fetchProduct(url: string): Promise<CanonicalProduct> {
        const parsed = parseJakmallHtml(acmicHtml);
        return normalizeToCanonical(parsed, url);
      },
      async verifySource() {
        return { healthy: true, status: "OK", latencyMs: 5 };
      },
    };

    service = new CatalogImportService({
      htmlFetcher: mockFetcher,
      sourceAdapter: mockAdapter,
    });
    target = "https://www.jakmall.com/acmic-official-store (local fixture simulation)";
  }

  try {
    const result = await service.importCatalog(
      isHttp ? target : "https://www.jakmall.com/acmic-official-store",
      {
        maxProducts,
        maxPages,
      }
    );

    console.log("==================================================");
    console.log("JakMall Catalog Discovery Result");
    console.log("==================================================");
    console.log(`Source              : ${result.sourceUrl}`);
    console.log(`Pages scanned       : ${result.pagesScanned}`);
    console.log(`Products discovered : ${result.discoveredCount}`);
    console.log(`Imported            : ${result.importedCount}`);
    console.log(`Failed              : ${result.failedCount}`);

    if (result.products.length > 0) {
      console.log("\nProducts:");
      result.products.forEach((p, idx) => {
        const priceStr =
          p.priceRange.min === p.priceRange.max
            ? `Rp${p.priceRange.min.toLocaleString("id-ID")}`
            : `Rp${p.priceRange.min.toLocaleString("id-ID")} - Rp${p.priceRange.max.toLocaleString("id-ID")}`;
        console.log(
          `${idx + 1}. [${p.sourceProductId}] ${p.title} (${p.variantCount} SKUs, ${priceStr})`
        );
        console.log(`   URL: ${p.sourceUrl}`);
      });
    }

    if (result.failures.length > 0) {
      console.log("\nFailures:");
      result.failures.forEach((f, idx) => {
        console.log(`${idx + 1}. ${f.url} -> Error: ${f.error} (${f.code ?? "UNKNOWN"})`);
      });
    }

    console.log(`\nStatus: ${result.status}`);

    if (result.status === "CATALOG_IMPORT_FAILED" || result.status === "ZERO_PRODUCTS_DISCOVERED") {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Catalog discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
