import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import vercelHandler, { createVercelHandler } from "../src/api/vercel-handler.js";
import { resolveApiBase } from "../web/src/lib/api.js";

let server: http.Server;
let baseUrl: string;

const mockProductService = {
  async listProducts(options: any = {}) {
    return {
      total: 1,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
      products: [
        {
          id: "prod_test_01",
          sourceProductId: "6970238281488",
          title: "ACMIC Power Bank",
          brand: "ACMIC",
          sourceUrl: "https://www.jakmall.com/acmic-official-store/acmic-cpd65",
          primaryImage: "https://static.jakmall.id/img1.jpg",
          variantCount: 1,
          priceRange: { min: 299000, max: 299000, currency: "IDR" },
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          status: "IMPORTED",
        },
      ],
    };
  },
  async getProductById(id: string) {
    return null;
  },
};

before(async () => {
  const handler = createVercelHandler({
    productService: mockProductService as any,
  });
  server = http.createServer((req, res) => {
    void handler(req, res);
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

test("1. Vercel adapter: GET /api/health reaches existing API logic", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.status, "ok");
  assert.ok(data.services);
  assert.ok("database" in data.services);
  assert.ok("redis" in data.services);
});

test("2. Vercel adapter: GET /api/products reaches existing API logic", async () => {
  const res = await fetch(`${baseUrl}/api/products`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(typeof data.total, "number");
  assert.equal(typeof data.limit, "number");
  assert.equal(typeof data.offset, "number");
  assert.ok(Array.isArray(data.products));
  assert.equal(data.products.length, 1);
});

test("3. Vercel adapter: POST JSON body survives pre-parsed req.body on /api/catalog/discover", async () => {
  let receivedPayload: unknown = null;
  const mockImportService = {
    discoverProductUrls: async (url: string, opts: any) => {
      receivedPayload = { url, opts };
      return { discoveredUrls: [], pagesScanned: 1 };
    },
  };

  const handler = createVercelHandler({
    catalogImportService: mockImportService as any,
  });

  const mockReq = {
    url: "/api/catalog/discover",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 10,
      maxPages: 1,
    },
  } as unknown as IncomingMessage;

  let statusCode = 0;
  let responseData: any = null;
  const mockRes = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk: string) => {
      statusCode = mockRes.statusCode;
      responseData = JSON.parse(chunk);
    },
  } as unknown as ServerResponse;

  await handler(mockReq, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(responseData.pagesScanned, 1);
  assert.deepEqual(receivedPayload, {
    url: "https://www.jakmall.com/acmic-official-store",
    opts: { maxProducts: 10, maxPages: 1 },
  });
});

test("4. Vercel adapter: POST JSON body survives pre-parsed req.body on /api/catalog/import", async () => {
  let importInvoked = false;
  const mockImportService = {
    importCatalog: async (url: string, opts: any) => {
      importInvoked = true;
      return { totalImported: 1, durationMs: 5 };
    },
  };

  const handler = createVercelHandler({
    catalogImportService: mockImportService as any,
  });

  const mockReq = {
    url: "/api/catalog/import",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 5,
      maxPages: 1,
    },
  } as unknown as IncomingMessage;

  let statusCode = 0;
  let responseData: any = null;
  const mockRes = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk: string) => {
      statusCode = mockRes.statusCode;
      responseData = JSON.parse(chunk);
    },
  } as unknown as ServerResponse;

  await handler(mockReq, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(importInvoked, true);
  assert.equal(responseData.totalImported, 1);
});

test("5. Vercel adapter: POST JSON body survives pre-parsed req.body on /api/products/:id/prepare-shopee", async () => {
  let passedProductId = "";
  let passedBody: any = null;
  const mockShopeeService = {
    prepareProduct: async (id: string, body: any) => {
      passedProductId = id;
      passedBody = body;
      return {
        productId: id,
        sourcePrice: 100000,
        sellingPrice: 120000,
        canPublish: false,
        reviewStatus: "NEEDS_REVIEW",
      };
    },
  };

  const handler = createVercelHandler({
    shopeePrepareService: mockShopeeService as any,
  });

  const mockReq = {
    url: "/api/products/prod_mock_99/prepare-shopee",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      markupPercentage: 20,
    },
  } as unknown as IncomingMessage;

  let statusCode = 0;
  let responseData: any = null;
  const mockRes = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk: string) => {
      statusCode = mockRes.statusCode;
      responseData = JSON.parse(chunk);
    },
  } as unknown as ServerResponse;

  await handler(mockReq, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(passedProductId, "prod_mock_99");
  assert.deepEqual(passedBody, { markupPercentage: 20 });
  assert.equal(responseData.canPublish, false);
});

test("6. Vercel adapter: API unknown route returns JSON 404, never HTML", async () => {
  const res = await fetch(`${baseUrl}/api/nonexistent-route-xyz`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  const data = (await res.json()) as any;
  assert.equal(data.error.code, "NOT_FOUND");
  assert.ok(data.error.message.includes("nonexistent-route-xyz"));
});

test("7. Frontend API client: production builds create same-origin /api/... URLs", () => {
  const base = resolveApiBase(undefined, true);
  assert.equal(base, "");
  const endpoint = `${base}/api/health`;
  assert.equal(endpoint, "/api/health");
});

test("8. Frontend API client: development retains localhost default, honors explicit overrides", () => {
  const devBase = resolveApiBase(undefined, false);
  assert.equal(devBase, "http://localhost:3001");
  assert.equal(`${devBase}/api/health`, "http://localhost:3001/api/health");

  const customBase = resolveApiBase("https://my-backend.example.com///", true);
  assert.equal(customBase, "https://my-backend.example.com");
  assert.equal(`${customBase}/api/health`, "https://my-backend.example.com/api/health");
});

test("9. SPA routing: regex rewrite pattern matches frontend routes and protects /api/*", () => {
  const pattern = /^\/((?!api(?:\/.*)?$).*)$/;

  assert.equal(pattern.test("/"), true);
  assert.equal(pattern.test("/products"), true);
  assert.equal(pattern.test("/products/prod_123"), true);
  assert.equal(pattern.test("/sync"), true);
  assert.equal(pattern.test("/reviews"), true);
  assert.equal(pattern.test("/activity"), true);

  assert.equal(pattern.test("/api"), false);
  assert.equal(pattern.test("/api/"), false);
  assert.equal(pattern.test("/api/health"), false);
  assert.equal(pattern.test("/api/products"), false);
  assert.equal(pattern.test("/api/catalog/discover"), false);
  assert.equal(pattern.test("/api/catalog/import"), false);
  assert.equal(pattern.test("/api/products/prod_123/prepare-shopee"), false);
  assert.equal(pattern.test("/api/unknown"), false);
});

test("10. Vercel adapter: Wildcard CORS is strictly rejected and explicit origin allowed", async () => {
  const customHandler = createVercelHandler({
    corsOptions: {
      allowedOrigins: ["https://intelligent-commerce-sync.vercel.app", "*"],
    },
  });

  const customServer = http.createServer((req, res) => {
    void customHandler(req, res);
  });

  await new Promise<void>((resolve) => {
    customServer.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const customAddr = customServer.address() as AddressInfo;
    const customUrl = `http://127.0.0.1:${customAddr.port}`;

    const resAllowed = await fetch(`${customUrl}/api/health`, {
      headers: { Origin: "https://intelligent-commerce-sync.vercel.app" },
    });
    assert.equal(
      resAllowed.headers.get("Access-Control-Allow-Origin"),
      "https://intelligent-commerce-sync.vercel.app"
    );

    const resWildcard = await fetch(`${customUrl}/api/health`, {
      headers: { Origin: "https://unauthorized-origin.com" },
    });
    assert.equal(resWildcard.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    await new Promise<void>((resolve) => {
      customServer.close(() => resolve());
    });
  }
});
