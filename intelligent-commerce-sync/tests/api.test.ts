import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import type { ProductService } from "../src/api/services/product-service.js";
import type { CatalogImportService } from "../src/catalog/catalog-import-service.js";
import type { ShopeePrepareService } from "../src/api/services/shopee-prepare-service.js";
import type { ReviewQueryService } from "../src/api/services/review-query-service.js";
import type { JobQueryService } from "../src/api/services/job-query-service.js";
import type {
  ProductDetailDto,
  ProductListResponse,
  ReviewListResponse,
  JobListResponse,
  ShopeePrepareResponse,
} from "../src/api/types.js";
import type { CatalogImportResult } from "../src/catalog/types.js";

let server: Server;
let baseUrl: string;

// Mock dependencies
const mockProductService: Partial<ProductService> = {
  async listProducts(options = {}): Promise<ProductListResponse> {
    return {
      total: 1,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
      products: [
        {
          id: "prod_uuid_123",
          sourceProductId: "6970238281488",
          title: "ACMIC CPD65 GaN 65W Charger",
          brand: "ACMIC",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          primaryImage: "https://static.jakmall.id/img1.jpg",
          variantCount: 9,
          priceRange: { min: 299000, max: 449000, currency: "IDR" },
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          status: "IMPORTED",
        },
      ],
    };
  },

  async getProductById(id: string): Promise<ProductDetailDto | null> {
    if (id === "prod_uuid_123") {
      return {
        id: "prod_uuid_123",
        source: {
          type: "JAKMALL",
          sourceProductId: "6970238281488",
          url: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          sellerName: "ACMIC Official Store",
          lastFetchedAt: "2026-09-01T00:00:00.000Z",
        },
        canonical: {
          source: "jakmall",
          sourceProductId: "6970238281488",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          title: "ACMIC CPD65 GaN 65W Charger",
          description: "High power charger",
          brand: "ACMIC",
          categoryPath: ["Handphone", "Aksesoris"],
          variants: [],
          images: [],
          specifications: {},
          seller: { name: "ACMIC Official Store" },
          fetchedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        variants: [
          {
            sourceSkuId: "sku_1",
            merchantSku: "CPD65-BLK",
            displaySku: "Hitam",
            attributes: { Warna: "Hitam" },
            weightGrams: 200,
          },
        ],
        snapshots: [
          {
            id: "snap_1",
            capturedAt: "2026-09-01T00:00:00.000Z",
            priceHash: "hash_price_1",
            sourceHash: "hash_source_1",
          },
        ],
        listings: [],
      };
    }
    if (id === "exploding_product") {
      throw new Error("Simulated database failure during product fetch");
    }
    return null;
  },
};

const mockCatalogImportService: Partial<CatalogImportService> = {
  async discoverProductUrls(url, options) {
    return {
      discoveredUrls: [
        {
          url: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          rawHref: "/acmic-official-store/acmic-cpd65",
          titleHint: "ACMIC CPD65",
          foundOnPage: 1,
        },
      ],
      pagesScanned: 1,
    };
  },

  async importCatalog(url, options): Promise<CatalogImportResult> {
    return {
      status: "CATALOG_IMPORT_COMPLETED",
      sourceUrl: url,
      pagesScanned: 1,
      discoveredCount: 1,
      importedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      products: [
        {
          sourceProductId: "6970238281488",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          title: "ACMIC CPD65 GaN 65W Charger",
          categoryPath: ["Handphone", "Aksesoris"],
          variantCount: 9,
          priceRange: { min: 299000, max: 449000 },
          canonical: {} as any,
        },
      ],
      failures: [],
    };
  },
};

const mockShopeePrepareService: Partial<ShopeePrepareService> = {
  async prepareProduct(productId, config): Promise<ShopeePrepareResponse | null> {
    if (productId === "prod_uuid_123") {
      return {
        productId: "prod_uuid_123",
        sourceProductId: "6970238281488",
        preparedTitle: "ACMIC CPD65 GaN 65W Charger",
        sourceTitle: "ACMIC CPD65 GaN 65W Charger",
        sourceBrand: "ACMIC",
        category: {
          suggestion: "Charger Handphone",
          targetCategoryId: null,
          status: "needs_review",
          confidence: 0.85,
          method: "rule",
        },
        variants: [
          {
            sourceSkuId: "sku_1",
            variationSku: "CPD65-BLK",
            attributes: { Warna: "Hitam" },
            sourcePrice: 299000,
            sellingPrice: 358800,
            inventoryStatus: "needs_review",
            inventoryPolicy: "undisclosed_needs_review",
            destinationStock: null,
          },
        ],
        validation: {
          ready: false,
          eligibleForApproval: false,
          canPublish: false,
          blockers: ["Category mapping requires verification"],
          warnings: [],
          issues: [
            {
              code: "MARKETPLACE_CATEGORY_UNRESOLVED",
              field: "category",
              message: "Category mapping requires verification",
              severity: "BLOCKER",
            },
          ],
        },
        reviewStatus: "PENDING",
      };
    }
    return null;
  },
};

const mockReviewQueryService: Partial<ReviewQueryService> = {
  async listReviews(options): Promise<ReviewListResponse> {
    return {
      total: 1,
      reviews: [
        {
          id: "job_review_1",
          productId: "prod_uuid_123",
          sourceProductId: "6970238281488",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          operation: "CREATE_LISTING",
          status: "NEEDS_REVIEW",
          reason: "Category mapping requires review",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
  },
};

const mockJobQueryService: Partial<JobQueryService> = {
  async listJobs(options): Promise<JobListResponse> {
    return {
      total: 1,
      jobs: [
        {
          id: "job_1",
          productSourceId: "ps_1",
          sourceProductId: "6970238281488",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          operation: "CREATE_LISTING",
          jobType: "SOURCE_SYNC",
          status: "COMPLETED",
          attemptCount: 1,
          error: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
  },
};

before(async () => {
  server = createApiServer({
    productService: mockProductService as ProductService,
    catalogImportService: mockCatalogImportService as CatalogImportService,
    shopeePrepareService: mockShopeePrepareService as ShopeePrepareService,
    reviewQueryService: mockReviewQueryService as ReviewQueryService,
    jobQueryService: mockJobQueryService as JobQueryService,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ----------------------------------------------------------------------
// 1. HEALTH ENDPOINT
// ----------------------------------------------------------------------
test("1. GET /api/health returns ok status and services overview", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as any;
  assert.equal(body.status, "ok");
  assert.equal(typeof body.timestamp, "string");
  assert.equal(typeof body.services, "object");
  assert.equal(["connected", "disconnected", "unconfigured"].includes(body.services.database), true);
});

// ----------------------------------------------------------------------
// 2. PRODUCTS LIST
// ----------------------------------------------------------------------
test("2. GET /api/products returns structured product list", async () => {
  const res = await fetch(`${baseUrl}/api/products?limit=10&offset=0`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as any;
  assert.equal(body.total, 1);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
  assert.equal(Array.isArray(body.products), true);
  assert.equal(body.products[0].id, "prod_uuid_123");
  assert.equal(body.products[0].sourceProductId, "6970238281488");
  assert.equal(body.products[0].title, "ACMIC CPD65 GaN 65W Charger");
});

// ----------------------------------------------------------------------
// 3. PRODUCT DETAIL
// ----------------------------------------------------------------------
test("3. GET /api/products/:id returns detailed product information", async () => {
  const res = await fetch(`${baseUrl}/api/products/prod_uuid_123`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as any;
  assert.equal(body.id, "prod_uuid_123");
  assert.equal(body.source.sourceProductId, "6970238281488");
  assert.equal(body.source.sellerName, "ACMIC Official Store");
  assert.equal(body.canonical.title, "ACMIC CPD65 GaN 65W Charger");
  assert.equal(body.variants.length, 1);
  assert.equal(body.variants[0].displaySku, "Hitam");
  assert.equal(body.snapshots.length, 1);
});

// ----------------------------------------------------------------------
// 4. MISSING PRODUCT -> 404
// ----------------------------------------------------------------------
test("4. GET /api/products/missing returns structured 404", async () => {
  const res = await fetch(`${baseUrl}/api/products/non_existent_id`);
  assert.equal(res.status, 404);

  const body = (await res.json()) as any;
  assert.equal(body.error.code, "PRODUCT_NOT_FOUND");
  assert.equal(body.error.message.includes("non_existent_id"), true);
});

// ----------------------------------------------------------------------
// 5. VALID CATALOG DISCOVERY
// ----------------------------------------------------------------------
test("5. POST /api/catalog/discover succeeds with valid JakMall catalog URL", async () => {
  const res = await fetch(`${baseUrl}/api/catalog/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 10,
      maxPages: 1,
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.sourceUrl, "https://www.jakmall.com/acmic-official-store");
  assert.equal(body.discoveredCount, 1);
  assert.equal(body.discoveredUrls[0].url, "https://www.jakmall.com/acmic-official-store/acmic-cpd65");
});

// ----------------------------------------------------------------------
// 6. INVALID / NON-JAKMALL CATALOG URL REJECTED
// ----------------------------------------------------------------------
test("6. POST /api/catalog/discover rejects non-JakMall URL with 400 VALIDATION_ERROR", async () => {
  const res = await fetch(`${baseUrl}/api/catalog/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://evil.com/fake-store",
      maxProducts: 10,
    }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

// ----------------------------------------------------------------------
// 7. LIMITS ARE BOUNDED
// ----------------------------------------------------------------------
test("7. POST /api/catalog/discover rejects absurd limits with 400", async () => {
  const res = await fetch(`${baseUrl}/api/catalog/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 99999, // exceeds max 100
    }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

// ----------------------------------------------------------------------
// 8. CATALOG IMPORT DELEGATES TO CATALOGIMPORTSERVICE
// ----------------------------------------------------------------------
test("8. POST /api/catalog/import executes catalog import successfully", async () => {
  const res = await fetch(`${baseUrl}/api/catalog/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 5,
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status, "CATALOG_IMPORT_COMPLETED");
  assert.equal(body.importedCount, 1);
  assert.equal(body.failedCount, 0);
  assert.equal(body.products[0].sourceProductId, "6970238281488");
});

// ----------------------------------------------------------------------
// 9. PREPARE-SHOPEE DELEGATES TO EXISTING SHOPEE CORE
// ----------------------------------------------------------------------
test("9. POST /api/products/:id/prepare-shopee returns validated draft details", async () => {
  const res = await fetch(`${baseUrl}/api/products/prod_uuid_123/prepare-shopee`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.productId, "prod_uuid_123");
  assert.equal(body.sourceProductId, "6970238281488");
  assert.equal(body.preparedTitle, "ACMIC CPD65 GaN 65W Charger");
  assert.equal(body.category.status, "needs_review");
  assert.equal(body.validation.canPublish, false);
  assert.equal(body.validation.blockers.length, 1);
  assert.equal(body.variants.length, 1);
  assert.equal(body.variants[0].sellingPrice, 358800);
});

// ----------------------------------------------------------------------
// 10. MALFORMED REQUEST BODY -> STRUCTURED 400
// ----------------------------------------------------------------------
test("10. POST with malformed JSON body returns structured 400 BAD_REQUEST", async () => {
  const res = await fetch(`${baseUrl}/api/catalog/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ invalid_json: true, ",
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "BAD_REQUEST");
  assert.equal(body.error.message.includes("Malformed JSON"), true);
});

// ----------------------------------------------------------------------
// 11. UNSUPPORTED METHOD -> 405
// ----------------------------------------------------------------------
test("11. Unsupported HTTP method returns 405 METHOD_NOT_ALLOWED", async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    method: "POST",
  });

  assert.equal(res.status, 405);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

// ----------------------------------------------------------------------
// 12. INTERNAL EXCEPTIONS DO NOT EXPOSE STACK TRACES
// ----------------------------------------------------------------------
test("12. Server exceptions do not expose stack traces to clients", async () => {
  const res = await fetch(`${baseUrl}/api/products/exploding_product`);
  assert.equal(res.status, 500);

  const body = (await res.json()) as any;
  assert.equal(body.error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(body.stack, undefined, "Stack trace must never be returned");
  assert.equal(body.error.stack, undefined, "Stack trace must never be in error payload");
});

// ----------------------------------------------------------------------
// 13. NO SECRETS IN RESPONSES
// ----------------------------------------------------------------------
test("13. Responses do not contain credentials, tokens, or connection strings", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const rawText = await res.text();

  assert.equal(rawText.includes("DATABASE_URL"), false);
  assert.equal(rawText.includes("REDIS_URL"), false);
  assert.equal(rawText.includes("postgresql://"), false);
  assert.equal(rawText.includes("redis://"), false);
  assert.equal(rawText.includes("partner_key"), false);
  assert.equal(rawText.includes("access_token"), false);
});

// ----------------------------------------------------------------------
// 14. REVIEWS ENDPOINT
// ----------------------------------------------------------------------
test("14. GET /api/reviews returns review list for operator attention", async () => {
  const res = await fetch(`${baseUrl}/api/reviews`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as any;
  assert.equal(body.total, 1);
  assert.equal(Array.isArray(body.reviews), true);
  assert.equal(body.reviews[0].id, "job_review_1");
  assert.equal(body.reviews[0].status, "NEEDS_REVIEW");
  assert.equal(body.reviews[0].reason, "Category mapping requires review");
});

// ----------------------------------------------------------------------
// 15. JOBS ENDPOINT
// ----------------------------------------------------------------------
test("15. GET /api/jobs returns recent activity without sensitive metadata", async () => {
  const res = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as any;
  assert.equal(body.total, 1);
  assert.equal(Array.isArray(body.jobs), true);
  assert.equal(body.jobs[0].id, "job_1");
  assert.equal(body.jobs[0].operation, "CREATE_LISTING");
  assert.equal(body.jobs[0].status, "COMPLETED");
});

// ----------------------------------------------------------------------
// 16. CORS PREFLIGHT & ORIGIN CONTROLS
// ----------------------------------------------------------------------
test("16. OPTIONS request from allowed origin returns 204 with CORS headers", async () => {
  const res = await fetch(`${baseUrl}/api/products`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "GET",
    },
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
  assert.equal(res.headers.get("Access-Control-Allow-Methods")?.includes("GET"), true);
});

test("17. Request from disallowed origin does not receive Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${baseUrl}/api/products`, {
    method: "GET",
    headers: {
      Origin: "https://malicious-site.example.com",
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("18. Custom corsOptions supports production HTTPS origin and rejects wildcard", async () => {
  const customServer = createApiServer({
    corsOptions: {
      allowedOrigins: ["https://my-app.onrender.com", "*"],
    },
  });

  await new Promise<void>((resolve) => {
    customServer.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const customAddr = customServer.address() as AddressInfo;
    const customUrl = `http://127.0.0.1:${customAddr.port}`;

    // 18a: configured production HTTPS origin is allowed
    const resAllowed = await fetch(`${customUrl}/api/health`, {
      headers: { Origin: "https://my-app.onrender.com" },
    });
    assert.equal(resAllowed.headers.get("Access-Control-Allow-Origin"), "https://my-app.onrender.com");

    // 18b: wildcard is never allowed as an origin
    const resWildcard = await fetch(`${customUrl}/api/health`, {
      headers: { Origin: "https://random-attacker.com" },
    });
    assert.equal(resWildcard.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    await new Promise<void>((resolve) => {
      customServer.close(() => resolve());
    });
  }
});
