import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ZodError } from "zod";
import { handleCors, type CorsOptions } from "./cors.js";
import { ProductService } from "./services/product-service.js";
import { CatalogImportService } from "../catalog/catalog-import-service.js";
import { CatalogPersistenceService } from "../catalog/catalog-persistence.js";
import { ShopeePrepareService } from "./services/shopee-prepare-service.js";
import { ReviewQueryService } from "./services/review-query-service.js";
import { JobQueryService } from "./services/job-query-service.js";
import {
  CatalogDiscoverSchema,
  CatalogImportSchema,
  ProductListQuerySchema,
} from "./validation.js";
import { getPrismaClient } from "../persistence/prisma.js";
import type { ApiErrorResponse } from "./types.js";

export interface ApiServerDeps {
  productService?: ProductService | undefined;
  catalogImportService?: CatalogImportService | undefined;
  shopeePrepareService?: ShopeePrepareService | undefined;
  reviewQueryService?: ReviewQueryService | undefined;
  jobQueryService?: JobQueryService | undefined;
  corsOptions?: CorsOptions | undefined;
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): void {
  const payload: ApiErrorResponse = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  sendJson(res, statusCode, payload);
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = 1048576
): Promise<unknown> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json"
    );
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    let byteLength = 0;

    req.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        req.destroy();
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "Request payload exceeds 1MB limit"));
        return;
      }
      raw += chunk.toString("utf-8");
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        reject(new ApiError(400, "BAD_REQUEST", "Malformed JSON request body"));
      }
    });

    req.on("error", (err) => {
      reject(new ApiError(400, "REQUEST_READ_ERROR", err.message));
    });
  });
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Creates the HTTP Request Listener with all routes and middleware.
 */
export function createApiRequestListener(deps: ApiServerDeps = {}) {
  const productService = deps.productService ?? new ProductService();
  const catalogPersistence = new CatalogPersistenceService(getPrismaClient());
  const catalogImportService =
    deps.catalogImportService ??
    new CatalogImportService({ persistenceService: catalogPersistence });
  const shopeePrepareService = deps.shopeePrepareService ?? new ShopeePrepareService();
  const reviewQueryService = deps.reviewQueryService ?? new ReviewQueryService();
  const jobQueryService = deps.jobQueryService ?? new JobQueryService();
  const corsOptions = deps.corsOptions ?? {};

  return async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. CORS Preflight & Headers
    if (handleCors(req, res, corsOptions)) {
      return;
    }

    try {
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = parsedUrl.pathname;
      const method = req.method?.toUpperCase() ?? "GET";

      // ----------------------------------------------------------------------
      // ROUTE: GET /api/health
      // ----------------------------------------------------------------------
      if (pathname === "/api/health") {
        if (method !== "GET") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/health`);
          return;
        }

        let dbStatus: "connected" | "disconnected" | "unconfigured" = "unconfigured";
        if (process.env["DATABASE_URL"]) {
          try {
            await getPrismaClient().$queryRaw`SELECT 1`;
            dbStatus = "connected";
          } catch {
            dbStatus = "disconnected";
          }
        }

        const redisStatus: "connected" | "disconnected" | "unconfigured" = process.env["REDIS_URL"]
          ? "connected"
          : "unconfigured";

        sendJson(res, 200, {
          status: "ok",
          timestamp: new Date().toISOString(),
          services: {
            database: dbStatus,
            redis: redisStatus,
          },
        });
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: GET /api/products
      // ----------------------------------------------------------------------
      if (pathname === "/api/products") {
        if (method !== "GET") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/products`);
          return;
        }

        const rawQuery = {
          limit: parsedUrl.searchParams.get("limit") ?? undefined,
          offset: parsedUrl.searchParams.get("offset") ?? undefined,
          q: parsedUrl.searchParams.get("q") ?? undefined,
          status: parsedUrl.searchParams.get("status") ?? undefined,
        };

        const validatedQuery = ProductListQuerySchema.parse(rawQuery);
        const result = await productService.listProducts(validatedQuery);
        sendJson(res, 200, result);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: GET /api/products/:id
      // ----------------------------------------------------------------------
      const productDetailMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (productDetailMatch && !pathname.endsWith("/prepare-shopee")) {
        if (method !== "GET") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for product detail`);
          return;
        }

        const productId = productDetailMatch[1]!;
        const detail = await productService.getProductById(productId);
        if (!detail) {
          sendError(res, 404, "PRODUCT_NOT_FOUND", `Product not found: ${productId}`);
          return;
        }

        sendJson(res, 200, detail);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: POST /api/catalog/discover
      // ----------------------------------------------------------------------
      if (pathname === "/api/catalog/discover") {
        if (method !== "POST") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/catalog/discover`);
          return;
        }

        const body = await readJsonBody(req);
        const validated = CatalogDiscoverSchema.parse(body);

        const { discoveredUrls, pagesScanned } = await catalogImportService.discoverProductUrls(
          validated.url,
          {
            maxProducts: validated.maxProducts,
            maxPages: validated.maxPages,
          }
        );

        sendJson(res, 200, {
          sourceUrl: validated.url,
          pagesScanned,
          discoveredCount: discoveredUrls.length,
          discoveredUrls,
        });
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: POST /api/catalog/import
      // ----------------------------------------------------------------------
      if (pathname === "/api/catalog/import") {
        if (method !== "POST") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/catalog/import`);
          return;
        }

        const body = await readJsonBody(req);
        const validated = CatalogImportSchema.parse(body);

        const result = await catalogImportService.importCatalog(validated.url, {
          maxProducts: validated.maxProducts,
          maxPages: validated.maxPages,
          persist: validated.persist ?? true,
        });

        sendJson(res, 200, result);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: POST /api/products/:id/prepare-shopee
      // ----------------------------------------------------------------------
      const prepareMatch = pathname.match(/^\/api\/products\/([^/]+)\/prepare-shopee$/);
      if (prepareMatch) {
        if (method !== "POST") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for prepare-shopee`);
          return;
        }

        const productId = prepareMatch[1]!;
        let body: any = {};
        if (req.headers["content-type"]?.includes("application/json")) {
          body = await readJsonBody(req);
        }

        const prepared = await shopeePrepareService.prepareProduct(productId, body);
        if (!prepared) {
          sendError(res, 404, "PRODUCT_NOT_FOUND", `Product not found: ${productId}`);
          return;
        }

        sendJson(res, 200, prepared);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: GET /api/reviews
      // ----------------------------------------------------------------------
      if (pathname === "/api/reviews") {
        if (method !== "GET") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/reviews`);
          return;
        }

        const limit = parsedUrl.searchParams.get("limit");
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;
        const reviews = await reviewQueryService.listReviews({ limit: parsedLimit });
        sendJson(res, 200, reviews);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE: GET /api/jobs
      // ----------------------------------------------------------------------
      if (pathname === "/api/jobs") {
        if (method !== "GET") {
          sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} not allowed for /api/jobs`);
          return;
        }

        const limit = parsedUrl.searchParams.get("limit");
        const parsedLimit = limit ? parseInt(limit, 10) : undefined;
        const jobs = await jobQueryService.listJobs({ limit: parsedLimit });
        sendJson(res, 200, jobs);
        return;
      }

      // ----------------------------------------------------------------------
      // ROUTE NOT FOUND
      // ----------------------------------------------------------------------
      sendError(res, 404, "NOT_FOUND", `Cannot ${method} ${pathname}`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        sendError(res, err.statusCode, err.code, err.message, err.details);
        return;
      }

      if (err instanceof ZodError) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid request parameters", err.issues);
        return;
      }

      // Internal Server Error (Never leak stack trace to client)
      const message = err instanceof Error ? err.message : "Internal Server Error";
      sendError(res, 500, "INTERNAL_SERVER_ERROR", message);
    }
  };
}

/**
 * Creates a ready-to-listen node:http Server.
 */
export function createApiServer(deps: ApiServerDeps = {}): http.Server {
  const listener = createApiRequestListener(deps);
  return http.createServer((req, res) => {
    listener(req, res).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, "INTERNAL_SERVER_ERROR", "Fatal request error");
      }
    });
  });
}
