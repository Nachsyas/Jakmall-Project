import type { SourceAdapter } from "../jakmall/adapter.js";
import { JakMallSourceAdapter } from "../jakmall/adapter.js";
import {
  fetchJakmallHtml,
  validateJakmallUrl,
  type JakmallFetchOptions,
} from "../jakmall/client.js";
import type {
  CatalogDiscoveryOptions,
  CatalogImportOptions,
  CatalogImportProductEntry,
  CatalogImportFailure,
  CatalogImportResult,
  CatalogImportStatus,
  DiscoveredProductUrl,
} from "./types.js";
import { scanCatalogPageHtml } from "./url-discovery.js";
import type { CatalogPersistenceService } from "./catalog-persistence.js";

export type HtmlFetcherFn = (
  url: string,
  options?: JakmallFetchOptions
) => Promise<{ html: string; finalUrl: string }>;

export interface CatalogImportServiceDeps {
  sourceAdapter?: SourceAdapter | undefined;
  htmlFetcher?: HtmlFetcherFn | undefined;
  persistenceService?: CatalogPersistenceService | undefined;
}

export class CatalogImportService {
  private readonly sourceAdapter: SourceAdapter;
  private readonly htmlFetcher: HtmlFetcherFn;
  private readonly persistenceService?: CatalogPersistenceService | undefined;

  constructor(deps: CatalogImportServiceDeps = {}) {
    this.sourceAdapter = deps.sourceAdapter ?? new JakMallSourceAdapter();
    this.htmlFetcher = deps.htmlFetcher ?? fetchJakmallHtml;
    this.persistenceService = deps.persistenceService;
  }

  /**
   * Discovers product URLs from a JakMall catalog/store page with bounded pagination.
   */
  async discoverProductUrls(
    catalogUrl: string,
    options: CatalogDiscoveryOptions = {}
  ): Promise<{
    discoveredUrls: DiscoveredProductUrl[];
    pagesScanned: number;
  }> {
    validateJakmallUrl(catalogUrl);

    const maxProducts = Math.max(1, Math.min(100, options.maxProducts ?? 20));
    const maxPages = Math.max(1, Math.min(10, options.maxPages ?? 3));
    const timeoutMs = Math.max(1000, Math.min(60000, options.timeoutMs ?? 15000));
    const userAgent = options.userAgent;

    const visitedPageUrls = new Set<string>();
    const discoveredMap = new Map<string, DiscoveredProductUrl>();
    let currentPageUrl: string | null = catalogUrl;
    let pagesScanned = 0;

    while (currentPageUrl && pagesScanned < maxPages && discoveredMap.size < maxProducts) {
      // Repeated-page loop protection
      if (visitedPageUrls.has(currentPageUrl)) {
        break;
      }
      visitedPageUrls.add(currentPageUrl);

      const fetchOpts: JakmallFetchOptions = { timeoutMs };
      if (userAgent !== undefined) {
        fetchOpts.userAgent = userAgent;
      }

      const { html, finalUrl } = await this.htmlFetcher(currentPageUrl, fetchOpts);
      pagesScanned++;

      const scanResult = scanCatalogPageHtml(html, finalUrl, pagesScanned);

      for (const item of scanResult.productUrls) {
        if (discoveredMap.size >= maxProducts) {
          break;
        }
        if (!discoveredMap.has(item.url)) {
          discoveredMap.set(item.url, item);
        }
      }

      if (discoveredMap.size >= maxProducts) {
        break;
      }

      currentPageUrl = scanResult.nextPageUrl;
    }

    return {
      discoveredUrls: Array.from(discoveredMap.values()),
      pagesScanned,
    };
  }

  /**
   * Discovers and imports products from a JakMall catalog/store page:
   * 1. Discovers unique product URLs with bounded pagination.
   * 2. Iterates imports with bounded concurrency using the existing JakMallSourceAdapter.
   * 3. Implements strict failure isolation (one failed product does not abort the batch).
   * 4. Optionally persists canonical products using CatalogPersistenceService.
   * 5. Returns deterministic structured status.
   */
  async importCatalog(
    catalogUrl: string,
    options: CatalogImportOptions = {}
  ): Promise<CatalogImportResult> {
    const { discoveredUrls, pagesScanned } = await this.discoverProductUrls(catalogUrl, options);

    if (discoveredUrls.length === 0) {
      return {
        status: "ZERO_PRODUCTS_DISCOVERED",
        sourceUrl: catalogUrl,
        pagesScanned,
        discoveredCount: 0,
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        products: [],
        failures: [],
      };
    }

    const concurrency = Math.max(1, Math.min(5, options.concurrency ?? 2));
    const shouldPersist = options.persist ?? false;

    const products: CatalogImportProductEntry[] = [];
    const failures: CatalogImportFailure[] = [];

    // Process in bounded concurrency chunks
    for (let i = 0; i < discoveredUrls.length; i += concurrency) {
      const chunk = discoveredUrls.slice(i, i + concurrency);

      const chunkResults = await Promise.all(
        chunk.map(async (discovered) => {
          try {
            const canonical = await this.sourceAdapter.fetchProduct(discovered.url);

            // Compute price bounds
            let minPrice = Infinity;
            let maxPrice = -Infinity;
            for (const v of canonical.variants) {
              if (v.price.final < minPrice) minPrice = v.price.final;
              if (v.price.final > maxPrice) maxPrice = v.price.final;
            }
            if (minPrice === Infinity) minPrice = 0;
            if (maxPrice === -Infinity) maxPrice = 0;

            let persisted: CatalogImportProductEntry["persisted"] = undefined;
            if (shouldPersist && this.persistenceService) {
              persisted = await this.persistenceService.persistCanonicalProduct(canonical);
            }

            const entry: CatalogImportProductEntry = {
              sourceProductId: canonical.sourceProductId,
              sourceUrl: canonical.sourceUrl,
              title: canonical.title,
              brand: canonical.brand,
              categoryPath: canonical.categoryPath,
              variantCount: canonical.variants.length,
              priceRange: {
                min: minPrice,
                max: maxPrice,
              },
              persisted,
              canonical,
            };

            return { success: true as const, entry };
          } catch (err: any) {
            const failure: CatalogImportFailure = {
              url: discovered.url,
              error: err instanceof Error ? err.message : String(err),
              code: typeof err?.code === "string" ? err.code : undefined,
            };
            return { success: false as const, failure };
          }
        })
      );

      for (const res of chunkResults) {
        if (res.success) {
          products.push(res.entry);
        } else {
          failures.push(res.failure);
        }
      }
    }

    let status: CatalogImportStatus;
    if (products.length > 0 && failures.length === 0) {
      status = "CATALOG_IMPORT_COMPLETED";
    } else if (products.length > 0 && failures.length > 0) {
      status = "CATALOG_IMPORT_PARTIAL";
    } else {
      status = "CATALOG_IMPORT_FAILED";
    }

    return {
      status,
      sourceUrl: catalogUrl,
      pagesScanned,
      discoveredCount: discoveredUrls.length,
      importedCount: products.length,
      failedCount: failures.length,
      skippedCount: 0,
      products,
      failures,
    };
  }
}
