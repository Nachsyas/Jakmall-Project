import type { CanonicalProduct } from "../canonical/types.js";

export interface CatalogDiscoveryOptions {
  /** Maximum number of product URLs to discover across all pages (default: 20, bounds: 1..100) */
  maxProducts?: number | undefined;
  /** Maximum number of catalog/store pages to scan (default: 3, bounds: 1..10) */
  maxPages?: number | undefined;
  /** Request timeout in milliseconds for fetching catalog pages (default: 15000) */
  timeoutMs?: number | undefined;
  /** Custom user agent header */
  userAgent?: string | undefined;
}

export interface CatalogImportOptions extends CatalogDiscoveryOptions {
  /** Maximum concurrent product imports (default: 2, bounds: 1..5) */
  concurrency?: number | undefined;
  /** Whether to persist imported products into PostgreSQL via Prisma (default: false) */
  persist?: boolean | undefined;
}

export interface DiscoveredProductUrl {
  /** Normalized, fragment-stripped product URL */
  url: string;
  /** Raw anchor href found on page */
  rawHref: string;
  /** Link anchor text or title if present */
  titleHint?: string | undefined;
  /** Page number where link was discovered */
  foundOnPage: number;
}

export interface CatalogPageScanResult {
  /** Page URL that was scanned */
  pageUrl: string;
  /** Page number in the scan sequence (1-indexed) */
  pageNumber: number;
  /** Product URLs discovered on this page */
  productUrls: DiscoveredProductUrl[];
  /** Next page URL if pagination was detected, null otherwise */
  nextPageUrl: string | null;
}

export interface CatalogImportProductEntry {
  sourceProductId: string;
  sourceUrl: string;
  title: string;
  brand?: string | undefined;
  categoryPath: string[];
  variantCount: number;
  priceRange: {
    min: number;
    max: number;
  };
  persisted?:
    | {
        productId: string;
        productSourceId: string;
        sourceSnapshotId: string;
      }
    | undefined;
  canonical: CanonicalProduct;
}

export interface CatalogImportFailure {
  url: string;
  error: string;
  code?: string | undefined;
}

export type CatalogImportStatus =
  | "CATALOG_IMPORT_COMPLETED"
  | "CATALOG_IMPORT_PARTIAL"
  | "CATALOG_IMPORT_FAILED"
  | "ZERO_PRODUCTS_DISCOVERED";

export interface CatalogImportResult {
  status: CatalogImportStatus;
  sourceUrl: string;
  pagesScanned: number;
  discoveredCount: number;
  importedCount: number;
  failedCount: number;
  skippedCount: number;
  products: CatalogImportProductEntry[];
  failures: CatalogImportFailure[];
}
