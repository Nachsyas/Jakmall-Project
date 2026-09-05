/**
 * Typed API Client for Intelligent Commerce Sync
 * Consumes Phase 6B HTTP API endpoints on port 3001
 */

const rawApiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const API_BASE = rawApiBase.replace(/\/+$/, "");

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  services: {
    database: "connected" | "disconnected" | "unconfigured";
    redis: "connected" | "disconnected" | "unconfigured";
  };
}

export interface ProductSummary {
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
  products: ProductSummary[];
}

export interface ProductDetailVariant {
  id: string;
  sourceSkuId: string;
  name: string;
  sku: string | null;
  price: {
    original: number;
    final: number;
    discountPercent: number;
  };
  stock: {
    available: boolean | null;
    quantity: number | null;
    rawText: string | null;
  };
  attributes: Record<string, string>;
}

export interface ProductDetail {
  id: string;
  sourceProductId: string;
  title: string;
  brand: string | null;
  description: string;
  sourceUrl: string;
  sourceCategoryPath: string[];
  images: Array<{ url: string; position: number }>;
  variants: ProductDetailVariant[];
  specifications: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface DiscoveredUrlItem {
  url: string;
  rawHref: string;
  foundOnPage: number;
  titleHint?: string;
}

export interface CatalogDiscoverResponse {
  sourceUrl: string;
  pagesScanned: number;
  discoveredCount: number;
  discoveredUrls: DiscoveredUrlItem[];
}

export interface CatalogImportFailure {
  url: string;
  error: string;
  code: string;
}

export interface CatalogImportResponse {
  sourceUrl: string;
  pagesScanned: number;
  discoveredCount: number;
  importedCount: number;
  failedCount: number;
  products: Array<{
    id: string;
    sourceProductId: string;
    title: string;
    variantsCount: number;
    sourceUrl: string;
  }>;
  failures: CatalogImportFailure[];
}

export interface ShopeePrepareVariant {
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
  variants: ShopeePrepareVariant[];
  validation: {
    ready: boolean;
    eligibleForApproval: boolean;
    canPublish: boolean;
    blockers: string[];
    warnings: string[];
    issues: Array<{
      code: string;
      field?: string;
      message: string;
      severity: string;
    }>;
  };
  reviewStatus: string;
}

export interface ReviewItem {
  jobId: string;
  productId: string;
  productTitle: string;
  sourceProductId: string;
  status: string;
  reason: string;
  risk: string;
  blockers: string[];
  warnings: string[];
  categoryStatus: string;
  stockStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobItem {
  id: string;
  productId: string;
  productTitle: string;
  sourceProductId: string;
  operation: string;
  status: string;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network error";
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      `Unable to reach the local API at ${API_BASE}. Make sure the API is running on port 3001. (${msg})`
    );
  }

  if (!res.ok) {
    let errorData: any = null;
    try {
      errorData = await res.json();
    } catch {
      // ignore
    }
    const code = errorData?.error?.code || `HTTP_${res.status}`;
    let message = errorData?.error?.message || `Request failed with status ${res.status}`;
    const details = errorData?.error?.details;
    if (Array.isArray(details) && details.length > 0) {
      const issue = details[0];
      const field = issue.path ? issue.path.join(".") : "";
      if (field && issue.message) {
        message = `${message}: ${field} (${issue.message})`;
      } else if (issue.message) {
        message = `${message}: ${issue.message}`;
      }
    }
    throw new ApiError(res.status, code, message, details);
  }

  return (await res.json()) as T;
}

export const api = {
  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health");
  },

  getProducts(params: { limit?: number; offset?: number; q?: string; status?: string } = {}): Promise<ProductListResponse> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set("limit", params.limit.toString());
    if (params.offset !== undefined) search.set("offset", params.offset.toString());
    if (params.q) search.set("q", params.q);
    if (params.status) search.set("status", params.status);
    const qs = search.toString();
    return request<ProductListResponse>(`/api/products${qs ? `?${qs}` : ""}`);
  },

  async getProduct(id: string): Promise<ProductDetail> {
    const raw = await request<any>(`/api/products/${encodeURIComponent(id)}`);
    const c = raw.canonical || {};
    const variants: ProductDetailVariant[] = (c.variants || []).map((v: any, i: number) => ({
      id: v.sourceSkuId || `var-${i}`,
      sourceSkuId: v.sourceSkuId || "",
      name: v.name || Object.values(v.attributes || {}).join(" / ") || `Variant ${i + 1}`,
      sku: v.displaySku || v.sourceSku || v.sourceSkuId || null,
      price: {
        original: v.price?.list ?? v.price?.final ?? 0,
        final: v.price?.final ?? 0,
        discountPercent: v.price?.discountPercent ?? 0,
      },
      stock: {
        available: v.inventory?.available ?? null,
        quantity: v.inventory?.quantity ?? null,
        rawText: v.inventory?.rawText ?? null,
      },
      attributes: (v.attributes as Record<string, string>) || {},
    }));

    return {
      id: raw.id,
      sourceProductId: raw.source?.sourceProductId || "",
      title: c.title || raw.source?.sourceProductId || raw.id,
      brand: c.brand || null,
      description: c.description || "",
      sourceUrl: raw.source?.url || c.sourceUrl || "",
      sourceCategoryPath: c.categoryPath || [],
      images: Array.isArray(c.images) ? c.images : [],
      variants,
      specifications: c.specifications || {},
      createdAt: raw.snapshots?.[0]?.capturedAt || new Date().toISOString(),
      updatedAt: raw.snapshots?.[0]?.capturedAt || new Date().toISOString(),
      status: raw.listings?.[0]?.status || "IMPORTED",
    };
  },

  discoverCatalog(payload: { url: string; maxProducts?: number; maxPages?: number }): Promise<CatalogDiscoverResponse> {
    const sanitizedPayload = {
      url: payload.url.trim(),
      ...(payload.maxProducts !== undefined
        ? { maxProducts: Math.max(1, Math.min(50, Math.floor(Number(payload.maxProducts) || 20))) }
        : {}),
      ...(payload.maxPages !== undefined
        ? { maxPages: Math.max(1, Math.min(5, Math.floor(Number(payload.maxPages) || 2))) }
        : {}),
    };
    return request<CatalogDiscoverResponse>("/api/catalog/discover", {
      method: "POST",
      body: JSON.stringify(sanitizedPayload),
    });
  },

  importCatalog(payload: {
    url: string;
    maxProducts?: number;
    maxPages?: number;
    persist?: boolean;
  }): Promise<CatalogImportResponse> {
    const sanitizedPayload = {
      url: payload.url.trim(),
      ...(payload.maxProducts !== undefined
        ? { maxProducts: Math.max(1, Math.min(50, Math.floor(Number(payload.maxProducts) || 10))) }
        : {}),
      ...(payload.maxPages !== undefined
        ? { maxPages: Math.max(1, Math.min(5, Math.floor(Number(payload.maxPages) || 2))) }
        : {}),
      persist: payload.persist ?? true,
    };
    return request<CatalogImportResponse>("/api/catalog/import", {
      method: "POST",
      body: JSON.stringify(sanitizedPayload),
    });
  },

  prepareShopee(productId: string, config: Record<string, unknown> = {}): Promise<ShopeePrepareResponse> {
    return request<ShopeePrepareResponse>(`/api/products/${encodeURIComponent(productId)}/prepare-shopee`, {
      method: "POST",
      body: JSON.stringify(config),
    });
  },

  getReviews(params: { limit?: number } = {}): Promise<{ total: number; reviews: ReviewItem[] }> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set("limit", params.limit.toString());
    const qs = search.toString();
    return request<{ total: number; reviews: ReviewItem[] }>(`/api/reviews${qs ? `?${qs}` : ""}`);
  },

  getJobs(params: { limit?: number } = {}): Promise<{ total: number; jobs: JobItem[] }> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set("limit", params.limit.toString());
    const qs = search.toString();
    return request<{ total: number; jobs: JobItem[] }>(`/api/jobs${qs ? `?${qs}` : ""}`);
  },
};
