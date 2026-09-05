import type { CatalogImportResult, DiscoveredProductUrl } from "../catalog/types.js";
import type { CanonicalProduct } from "../canonical/types.js";

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  error: ApiErrorDetail;
}

export interface HealthResponse {
  status: "ok";
  timestamp: string;
  services: {
    database: "connected" | "disconnected" | "unconfigured";
    redis: "connected" | "disconnected" | "unconfigured";
  };
}

export interface ProductSummaryDto {
  id: string;
  sourceProductId: string;
  title: string;
  brand: string | null;
  sourceUrl: string;
  primaryImage: string | null;
  variantCount: number;
  priceRange: {
    min: number;
    max: number;
    currency: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface ProductListResponse {
  total: number;
  limit: number;
  offset: number;
  products: ProductSummaryDto[];
}

export interface ProductDetailDto {
  id: string;
  source: {
    type: string;
    sourceProductId: string;
    url: string;
    sellerName: string | null;
    lastFetchedAt: string | null;
  };
  canonical: CanonicalProduct | null;
  variants: Array<{
    sourceSkuId: string;
    merchantSku: string | null;
    displaySku: string | null;
    attributes: Record<string, string>;
    weightGrams: number | null;
  }>;
  snapshots: Array<{
    id: string;
    capturedAt: string;
    priceHash: string;
    sourceHash: string;
  }>;
  listings: Array<{
    id: string;
    marketplace: string;
    sellerAccountKey: string;
    remoteListingId: string | null;
    status: string;
  }>;
}

export interface CatalogDiscoverRequest {
  url: string;
  maxProducts?: number | undefined;
  maxPages?: number | undefined;
}

export interface CatalogDiscoverResponse {
  sourceUrl: string;
  pagesScanned: number;
  discoveredCount: number;
  discoveredUrls: DiscoveredProductUrl[];
}

export interface CatalogImportRequest {
  url: string;
  maxProducts?: number | undefined;
  maxPages?: number | undefined;
  persist?: boolean | undefined;
}

export interface CatalogImportResponse extends CatalogImportResult {}

export interface ShopeePrepareVariantDto {
  sourceSkuId: string;
  variationSku: string;
  attributes: Record<string, string>;
  sourcePrice: number;
  sellingPrice: number;
  inventoryStatus: string;
  inventoryPolicy: string;
  destinationStock: number | null;
}

export interface ShopeePrepareResponse {
  productId: string;
  sourceProductId: string;
  preparedTitle: string;
  sourceTitle: string;
  sourceBrand: string | null;
  category: {
    suggestion: string | null;
    targetCategoryId: string | null;
    status: string;
    confidence: number;
    method: string;
  };
  variants: ShopeePrepareVariantDto[];
  validation: {
    ready: boolean;
    eligibleForApproval: boolean;
    canPublish: boolean;
    blockers: string[];
    warnings: string[];
    issues: Array<{
      code: string;
      field?: string | undefined;
      message: string;
      severity: string;
    }>;
  };
  reviewStatus: string;
}

export interface ReviewItemDto {
  id: string;
  productId: string | null;
  sourceProductId: string | null;
  sourceUrl: string | null;
  operation: string;
  status: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewListResponse {
  total: number;
  reviews: ReviewItemDto[];
}

export interface JobItemDto {
  id: string;
  productSourceId: string | null;
  sourceProductId: string | null;
  sourceUrl: string | null;
  operation: string;
  jobType: string;
  status: string;
  attemptCount: number;
  error: {
    code: string;
    message: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobListResponse {
  total: number;
  jobs: JobItemDto[];
}
