import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  normalizeProductUrl,
  scanCatalogPageHtml,
  extractNextPageUrl,
} from "../src/catalog/url-discovery.js";
import { CatalogImportService, type HtmlFetcherFn } from "../src/catalog/catalog-import-service.js";
import type { SourceAdapter } from "../src/jakmall/adapter.js";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import { normalizeToCanonical } from "../src/jakmall/normalizer.js";
import type { CanonicalProduct } from "../src/canonical/types.js";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures");
const catalogPage1Html = fs.readFileSync(path.join(FIXTURES_DIR, "catalog-store.html"), "utf-8");
const catalogPage2Html = fs.readFileSync(path.join(FIXTURES_DIR, "catalog-store-page2.html"), "utf-8");
const acmicHtml = fs.readFileSync(path.join(FIXTURES_DIR, "acmic.html"), "utf-8");
const momoHtml = fs.readFileSync(path.join(FIXTURES_DIR, "momo.html"), "utf-8");

// ----------------------------------------------------------------------
// URL DISCOVERY & NORMALIZATION TESTS
// ----------------------------------------------------------------------

test("1. extracts valid JakMall product URLs and normalizes protocol and hostname", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const raw = "http://jakmall.com/acmic-official-store/acmic-cpd65-charger";
  const normalized = normalizeProductUrl(raw, base);

  assert.equal(normalized, "https://www.jakmall.com/acmic-official-store/acmic-cpd65-charger");
});

test("2. resolves relative product URLs safely against the base catalog page", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const relativeHref = "/acmic-official-store/acmic-powerbank-10000mah";
  const normalized = normalizeProductUrl(relativeHref, base);

  assert.equal(normalized, "https://www.jakmall.com/acmic-official-store/acmic-powerbank-10000mah");
});

test("3. deduplicates duplicate links on the same page", () => {
  const scan = scanCatalogPageHtml(catalogPage1Html, "https://www.jakmall.com/acmic-official-store");

  // In catalog-store.html, CPD65 appears twice (with different fragments)
  // Cable appears twice (relative and duplicate)
  const cpd65Urls = scan.productUrls.filter((u) => u.url.includes("acmic-cpd65"));
  assert.equal(cpd65Urls.length, 1, "Duplicate product URL must only appear once in scan result");

  const cableUrls = scan.productUrls.filter((u) => u.url.includes("acmic-kabel-data"));
  assert.equal(cableUrls.length, 1, "Duplicate cable link must only appear once in scan result");
});

test("4. strips anchor fragments during normalization to collapse variants to canonical product", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const urlWithFragment1 = "/acmic-official-store/acmic-cpd65-charger#5502951494118";
  const urlWithFragment2 = "/acmic-official-store/acmic-cpd65-charger#7340637866967";

  const norm1 = normalizeProductUrl(urlWithFragment1, base);
  const norm2 = normalizeProductUrl(urlWithFragment2, base);

  assert.equal(norm1, norm2);
  assert.equal(norm1, "https://www.jakmall.com/acmic-official-store/acmic-cpd65-charger");
});

test("5. rejects non-JakMall links and prevents SSRF", () => {
  const base = "https://www.jakmall.com/acmic-official-store";

  assert.equal(normalizeProductUrl("https://evil.com/product", base), null);
  assert.equal(normalizeProductUrl("http://localhost:3000/product", base), null);
  assert.equal(normalizeProductUrl("http://169.254.169.254/metadata", base), null);
  assert.equal(normalizeProductUrl("file:///etc/passwd", base), null);
  assert.equal(normalizeProductUrl("javascript:alert(1)", base), null);
  assert.equal(normalizeProductUrl("mailto:support@jakmall.com", base), null);
});

test("6. skips obvious non-product navigation links and utility pages", () => {
  const base = "https://www.jakmall.com/acmic-official-store";

  assert.equal(normalizeProductUrl("/", base), null);
  assert.equal(normalizeProductUrl("/cart", base), null);
  assert.equal(normalizeProductUrl("/checkout", base), null);
  assert.equal(normalizeProductUrl("/login", base), null);
  assert.equal(normalizeProductUrl("/register", base), null);
  assert.equal(normalizeProductUrl("/help", base), null);
  assert.equal(normalizeProductUrl("/about", base), null);
  assert.equal(normalizeProductUrl("/terms", base), null);
  assert.equal(normalizeProductUrl("/privacy", base), null);
  assert.equal(normalizeProductUrl("/c/handphone-tablet", base), null);
  assert.equal(normalizeProductUrl("/kategori/elektronik", base), null);
  assert.equal(normalizeProductUrl("/acmic-official-store", base), null); // store root
  assert.equal(normalizeProductUrl("/acmic-official-store/info", base), null); // store sub-tab
  assert.equal(normalizeProductUrl("/acmic-official-store/ulasan", base), null); // store sub-tab
  assert.equal(normalizeProductUrl("/acmic-official-store/kebijakan", base), null); // store sub-tab
});

test("7. strips tracking query parameters during normalization", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const urlWithTracking =
    "/acmic-official-store/acmic-powerbank?utm_source=fb&utm_medium=cpc&ref=affiliate&spm=123";
  const normalized = normalizeProductUrl(urlWithTracking, base);

  assert.equal(normalized, "https://www.jakmall.com/acmic-official-store/acmic-powerbank");
});

test("8. correctly discovers pagination next page URL", () => {
  const scan1 = scanCatalogPageHtml(catalogPage1Html, "https://www.jakmall.com/acmic-official-store", 1);
  assert.equal(scan1.nextPageUrl, "https://www.jakmall.com/acmic-official-store?page=2");

  const scan2 = scanCatalogPageHtml(catalogPage2Html, "https://www.jakmall.com/acmic-official-store?page=2", 2);
  assert.equal(scan2.nextPageUrl, null, "Page 2 has no next page link");
});

// ----------------------------------------------------------------------
// CATALOG IMPORT SERVICE TESTS
// ----------------------------------------------------------------------

test("9. bounded maxProducts limits discovery and import across pagination", async () => {
  const mockFetcher: HtmlFetcherFn = async (url: string) => {
    if (url.includes("page=2")) {
      return { html: catalogPage2Html, finalUrl: "https://www.jakmall.com/acmic-official-store?page=2" };
    }
    return { html: catalogPage1Html, finalUrl: "https://www.jakmall.com/acmic-official-store" };
  };

  const service = new CatalogImportService({
    htmlFetcher: mockFetcher,
  });

  // Limit maxProducts to 2
  const { discoveredUrls, pagesScanned } = await service.discoverProductUrls(
    "https://www.jakmall.com/acmic-official-store",
    { maxProducts: 2, maxPages: 5 }
  );

  assert.equal(discoveredUrls.length, 2, "Must respect maxProducts ceiling");
  assert.equal(pagesScanned, 1, "Should stop scanning pages once maxProducts is reached on page 1");
});

test("10. bounded maxPages limits pagination crawl depth", async () => {
  let pageCount = 0;
  const mockFetcher: HtmlFetcherFn = async (url: string) => {
    pageCount++;
    // Continuously returns HTML with rel="next"
    const htmlWithNext = `
      <html><body>
        <div class="product-item"><a href="/store/product-${pageCount}">Product ${pageCount}</a></div>
        <div class="pagination"><a rel="next" href="/store?page=${pageCount + 1}">Next</a></div>
      </body></html>
    `;
    return { html: htmlWithNext, finalUrl: `https://www.jakmall.com/store?page=${pageCount}` };
  };

  const service = new CatalogImportService({ htmlFetcher: mockFetcher });

  const { discoveredUrls, pagesScanned } = await service.discoverProductUrls(
    "https://www.jakmall.com/store",
    { maxPages: 2, maxProducts: 100 }
  );

  assert.equal(pagesScanned, 2, "Must stop when maxPages limit is reached");
  assert.equal(discoveredUrls.length, 2);
});

test("11. repeated-page protection stops infinite crawl loop", async () => {
  let calls = 0;
  const mockFetcher: HtmlFetcherFn = async () => {
    calls++;
    // Loop: points next page to itself
    const htmlLoop = `
      <html><body>
        <a href="/store/prod-1">Prod 1</a>
        <a rel="next" href="/store?page=1">Loop Next</a>
      </body></html>
    `;
    return { html: htmlLoop, finalUrl: "https://www.jakmall.com/store?page=1" };
  };

  const service = new CatalogImportService({ htmlFetcher: mockFetcher });

  const { pagesScanned } = await service.discoverProductUrls(
    "https://www.jakmall.com/store?page=1",
    { maxPages: 10 }
  );

  assert.equal(pagesScanned, 1, "Must terminate when revisiting same URL");
  assert.equal(calls, 1);
});

test("12. single-product failure does not abort batch import (failure isolation)", async () => {
  const mockFetcher: HtmlFetcherFn = async () => ({
    html: catalogPage1Html,
    finalUrl: "https://www.jakmall.com/acmic-official-store",
  });

  const parsedAcmic = parseJakmallHtml(acmicHtml);
  const parsedMomo = parseJakmallHtml(momoHtml);

  const mockAdapter: SourceAdapter = {
    async fetchProduct(url: string): Promise<CanonicalProduct> {
      if (url.includes("powerbank")) {
        // Simulated failure for product 2
        throw new Error("HTTP 500: JakMall product page temporarily unavailable");
      }
      if (url.includes("kabel")) {
        return normalizeToCanonical(parsedMomo, url);
      }
      return normalizeToCanonical(parsedAcmic, url);
    },
    async verifySource() {
      return { healthy: true, status: "OK", latencyMs: 1 };
    },
  };

  const service = new CatalogImportService({
    htmlFetcher: mockFetcher,
    sourceAdapter: mockAdapter,
  });

  const result = await service.importCatalog("https://www.jakmall.com/acmic-official-store", {
    maxProducts: 3,
    concurrency: 2,
  });

  assert.equal(result.status, "CATALOG_IMPORT_PARTIAL");
  assert.equal(result.discoveredCount, 3);
  assert.equal(result.importedCount, 2, "2 successful products must be collected");
  assert.equal(result.failedCount, 1, "1 failed product must be isolated");
  assert.equal(result.failures[0]?.error.includes("JakMall product page temporarily unavailable"), true);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0]?.sourceProductId, "6970238281488");
});

test("13. zero products discovered returns ZERO_PRODUCTS_DISCOVERED", async () => {
  const emptyHtml = `<html><body><nav><a href="/cart">Cart</a></nav><p>No products</p></body></html>`;
  const mockFetcher: HtmlFetcherFn = async () => ({
    html: emptyHtml,
    finalUrl: "https://www.jakmall.com/empty-store",
  });

  const service = new CatalogImportService({ htmlFetcher: mockFetcher });
  const result = await service.importCatalog("https://www.jakmall.com/empty-store");

  assert.equal(result.status, "ZERO_PRODUCTS_DISCOVERED");
  assert.equal(result.discoveredCount, 0);
  assert.equal(result.importedCount, 0);
  assert.equal(result.products.length, 0);
});

test("14. deduplicates across pagination boundaries", async () => {
  const mockFetcher: HtmlFetcherFn = async (url: string) => {
    if (url.includes("page=2")) {
      return { html: catalogPage2Html, finalUrl: "https://www.jakmall.com/acmic-official-store?page=2" };
    }
    return { html: catalogPage1Html, finalUrl: "https://www.jakmall.com/acmic-official-store" };
  };

  const service = new CatalogImportService({ htmlFetcher: mockFetcher });
  const { discoveredUrls, pagesScanned } = await service.discoverProductUrls(
    "https://www.jakmall.com/acmic-official-store",
    { maxPages: 2, maxProducts: 20 }
  );

  assert.equal(pagesScanned, 2);
  // Page 1 has 3 unique products: CPD65, Powerbank, Kabel Data
  // Page 2 has CPD65 (duplicate), Wireless Charger, Earphone TWS
  // Total unique should be 5
  assert.equal(discoveredUrls.length, 5);

  const cpd65Count = discoveredUrls.filter((u) => u.url.includes("acmic-cpd65")).length;
  assert.equal(cpd65Count, 1, "Cross-page duplicate must be deduplicated to exactly 1 URL");
});

test("15. zero mutation of existing canonical contracts", async () => {
  const parsedAcmic = parseJakmallHtml(acmicHtml);
  const canonical = normalizeToCanonical(parsedAcmic, "https://www.jakmall.com/acmic-official-store/acmic-cpd65");
  const canonicalBeforeJson = JSON.stringify(canonical);

  const mockFetcher: HtmlFetcherFn = async () => ({
    html: catalogPage1Html,
    finalUrl: "https://www.jakmall.com/acmic-official-store",
  });

  const mockAdapter: SourceAdapter = {
    async fetchProduct(): Promise<CanonicalProduct> {
      return canonical;
    },
    async verifySource() {
      return { healthy: true, status: "OK", latencyMs: 1 };
    },
  };

  const service = new CatalogImportService({
    htmlFetcher: mockFetcher,
    sourceAdapter: mockAdapter,
  });

  const result = await service.importCatalog("https://www.jakmall.com/acmic-official-store", {
    maxProducts: 1,
  });

  assert.equal(result.status, "CATALOG_IMPORT_COMPLETED");
  const canonicalAfterJson = JSON.stringify(canonical);
  assert.equal(canonicalBeforeJson, canonicalAfterJson, "CanonicalProduct must remain strictly immutable");
});

// ----------------------------------------------------------------------
// PHASE 6A REPAIR: FOCUSED CLASSIFIER REGRESSION TESTS
// ----------------------------------------------------------------------

test("16. /member/purchase-history/payment is NEVER classified as a product", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const raw =
    "https://www.jakmall.com/member/purchase-history/payment?jtm=c31f910604ceaff2529f297be9e94c3da06642854e8999896ab0412ad8d3e9ed5428852b3c94da014ce5476aa73e5624ee5ba3a8f96c3db4accc205b56af905d278e5d455c83c6f0a3cc277cc18801b94823ea2a4f03692d44acf2c26240a67316ca2c40906fa1";
  const result = normalizeProductUrl(raw, base);
  assert.equal(result, null, "Must strictly reject member purchase history payment URL");
});

test("17. URLs carrying long jtm/query tokens on non-product paths remain rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(
    normalizeProductUrl("https://www.jakmall.com/peluang-usaha?jtm=789c8b56cac8cf4d2d484c4f", base),
    null
  );
  assert.equal(
    normalizeProductUrl("https://www.jakmall.com/watchlist?jtm=04ab679c29ecfd29bccba9ce", base),
    null
  );
  assert.equal(
    normalizeProductUrl("https://www.jakmall.com/recently-viewed?jtm=1f84759938e354d858c", base),
    null
  );
  assert.equal(
    normalizeProductUrl("https://www.jakmall.com/top-100?jtm=789c8b56ca484d4c492d52d2", base),
    null
  );
});

test("18. /member/* is rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/member/profile", base), null);
  assert.equal(normalizeProductUrl("/member/orders", base), null);
  assert.equal(normalizeProductUrl("/member/message/detail", base), null);
  assert.equal(normalizeProductUrl("/member/wishlist", base), null);
  assert.equal(normalizeProductUrl("/member/settings", base), null);
});

test("19. /cart/* is rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/cart", base), null);
  assert.equal(normalizeProductUrl("/cart/items", base), null);
  assert.equal(normalizeProductUrl("/cart/header", base), null);
  assert.equal(normalizeProductUrl("/cart/checked", base), null);
});

test("20. /checkout/* is rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/checkout", base), null);
  assert.equal(normalizeProductUrl("/checkout/single/3143953031042", base), null);
  assert.equal(normalizeProductUrl("/checkout/payment", base), null);
});

test("21. /login and auth-related links are rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/login", base), null);
  assert.equal(normalizeProductUrl("/login?_r=xyz", base), null);
  assert.equal(normalizeProductUrl("/register", base), null);
  assert.equal(normalizeProductUrl("/register?_r=xyz", base), null);
  assert.equal(normalizeProductUrl("/auth/google", base), null);
});

test("22. real known JakMall product-detail URLs remain accepted", () => {
  const base = "https://www.jakmall.com/acmic-official-store";
  const url1 = "https://www.jakmall.com/acmic-official-store/acmic-cfm100-kabel-data-charger-micro-usb-100cm-fast-charging-cable";
  const url2 = "https://www.jakmall.com/acmic-official-store/acmic-cfl100-kabel-data-charger-iphone-lightning-fast-charging-cable";
  const url3 = "https://www.jakmall.com/acmic-official-store/acmic-velcro-strap-cable-tie-organizer-pengikat-perekat-kabel-holder";
  const url4 = "https://www.jakmall.com/p/kabel-data-type-c";

  assert.equal(normalizeProductUrl(url1, base), url1);
  assert.equal(normalizeProductUrl(url2, base), url2);
  assert.equal(normalizeProductUrl(url3, base), url3);
  assert.equal(normalizeProductUrl(url4, base), url4);
});

test("23. tracking-query normalization does not turn a non-product path into a product", () => {
  const base = "https://www.jakmall.com";
  const nonProductWithQuery = "/help/faq?utm_source=google&ref=123&jtm=abc";
  assert.equal(normalizeProductUrl(nonProductWithQuery, base), null);
});

test("24. generic multi-segment paths are NOT automatically assumed to be products", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/store-reviews/11ea32aaf11fd06eb56c0242cc0b7aff", base), null);
  assert.equal(normalizeProductUrl("/store-information/11ea32aaf11fd06eb56c0242cc0b7aff", base), null);
  assert.equal(normalizeProductUrl("/store-statistics/11ea32aaf11fd06eb56c0242cc0b7aff", base), null);
  assert.equal(normalizeProductUrl("/a/b/c/d", base), null);
  assert.equal(normalizeProductUrl("/api/v1/endpoint", base), null);
});

test("25. catalog navigation links are rejected", () => {
  const base = "https://www.jakmall.com";
  assert.equal(normalizeProductUrl("/c/handphone-tablet", base), null);
  assert.equal(normalizeProductUrl("/kategori/komputer-laptop", base), null);
  assert.equal(normalizeProductUrl("/category/audio", base), null);
});

test("26. embedded state var result extracts valid products and pagination", () => {
  const embeddedHtml = `
    <html>
      <head><title>Store</title></head>
      <body>
        <script>
          var result = {
            "products": [
              {
                "name": "ACMIC CFM100 Kabel Data",
                "url": "https://www.jakmall.com/acmic-official-store/acmic-cfm100-kabel-data#123",
                "variants": { "123": { "price": 19900 } }
              },
              {
                "name": "ACMIC CFL100 Kabel Data",
                "url": "/acmic-official-store/acmic-cfl100-kabel-data",
                "variants": { "456": { "price": 19900 } }
              }
            ],
            "pagination": {
              "next": "https://www.jakmall.com/acmic-official-store?page=2"
            }
          };
        </script>
      </body>
    </html>
  `;
  const scan = scanCatalogPageHtml(embeddedHtml, "https://www.jakmall.com/acmic-official-store", 1);
  assert.equal(scan.productUrls.length, 2);
  assert.equal(scan.productUrls[0]?.url, "https://www.jakmall.com/acmic-official-store/acmic-cfm100-kabel-data");
  assert.equal(scan.productUrls[1]?.url, "https://www.jakmall.com/acmic-official-store/acmic-cfl100-kabel-data");
  assert.equal(scan.nextPageUrl, "https://www.jakmall.com/acmic-official-store?page=2");
});
