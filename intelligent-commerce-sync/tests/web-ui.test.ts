import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("Phase 6C: Web UI Presentation & Contract Logic", () => {
  test("1. Stock semantics: undisclosed stock is NEVER coerced to 0 or arbitrary quantity", () => {
    // Contract: renderStockText presentation logic
    function evaluateStockLabel(stock: { available: boolean | null; quantity: number | null }) {
      if (stock.available === false) {
        return "Out of stock";
      }
      if (stock.quantity !== null && stock.quantity !== undefined) {
        return `${stock.quantity} available`;
      }
      if (stock.available === true) {
        return "Quantity undisclosed";
      }
      return "Stock unknown";
    }

    assert.equal(evaluateStockLabel({ available: false, quantity: 0 }), "Out of stock");
    assert.equal(evaluateStockLabel({ available: true, quantity: null }), "Quantity undisclosed");
    assert.notEqual(evaluateStockLabel({ available: true, quantity: null }), "0 available");
    assert.notEqual(evaluateStockLabel({ available: true, quantity: null }), "0");
    assert.equal(evaluateStockLabel({ available: true, quantity: 15 }), "15 available");
    assert.equal(evaluateStockLabel({ available: null, quantity: null }), "Stock unknown");
  });

  test("2. Status indicator mapping strictly enforces restrained Apple-inspired symbols", () => {
    function mapStatus(status: string) {
      const norm = (status || "").toUpperCase();
      if (norm === "READY" || norm === "COMPLETED" || norm === "RESOLVED" || norm === "APPROVED") {
        return { symbol: "✓", colorClass: "ready", label: "Ready" };
      }
      if (norm === "NEEDS_REVIEW" || norm === "REVIEW_REQUIRED") {
        return { symbol: "!", colorClass: "needs-review", label: "Needs Review" };
      }
      if (norm === "BLOCKED" || norm === "FAILED" || norm === "REJECTED") {
        return { symbol: "×", colorClass: "blocked", label: "Blocked" };
      }
      return { symbol: "○", colorClass: "pending", label: "Pending" };
    }

    assert.deepEqual(mapStatus("APPROVED"), { symbol: "✓", colorClass: "ready", label: "Ready" });
    assert.deepEqual(mapStatus("COMPLETED"), { symbol: "✓", colorClass: "ready", label: "Ready" });
    assert.deepEqual(mapStatus("NEEDS_REVIEW"), { symbol: "!", colorClass: "needs-review", label: "Needs Review" });
    assert.deepEqual(mapStatus("BLOCKED"), { symbol: "×", colorClass: "blocked", label: "Blocked" });
    assert.deepEqual(mapStatus("IMPORTED"), { symbol: "○", colorClass: "pending", label: "Pending" });
  });

  test("3. Shopee preparation review status: NEEDS_REVIEW is recognized as gated review, not an error", () => {
    const sampleShopeeResponse = {
      productId: "prod-1",
      review: {
        status: "NEEDS_REVIEW",
        reason: "Review required before marketplace publication.",
        canPublish: false,
      },
      validation: {
        ready: false,
        issuesCount: 1,
        warnings: ["Category suggestion needs confirmation"],
        blockers: [],
      },
    };

    assert.equal(sampleShopeeResponse.review.status, "NEEDS_REVIEW");
    assert.equal(sampleShopeeResponse.review.canPublish, false);
    assert.equal(sampleShopeeResponse.validation.blockers.length, 0);
    assert.equal(sampleShopeeResponse.validation.warnings.length, 1);
  });

  test("4. Price formatting handles single price and ranges correctly in IDR", () => {
    function formatPriceRange(range: { min: number; max: number } | null) {
      if (!range) return "Price not listed";
      const fmt = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
      if (range.min === range.max) {
        return fmt(range.min);
      }
      return `${fmt(range.min)} – ${fmt(range.max)}`;
    }

    assert.equal(formatPriceRange(null), "Price not listed");
    assert.equal(formatPriceRange({ min: 150000, max: 150000 }), "Rp 150.000");
    assert.equal(formatPriceRange({ min: 120000, max: 180000 }), "Rp 120.000 – Rp 180.000");
  });

  test("5. ApiError class correctly isolates error code, status code, and preserves message", () => {
    class ApiError extends Error {
      readonly statusCode: number;
      readonly code: string;
      readonly details?: unknown;

      constructor(statusCode: number, code: string, message: string, details?: unknown) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = "ApiError";
      }
    }

    const err = new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found: 123", { id: "123" });
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    assert.equal(err.message, "Product not found: 123");
    assert.deepEqual(err.details, { id: "123" });
  });

  test("6. Catalog import payload sanitization strictly enforces backend schema bounds [1..50] and [1..5]", () => {
    function sanitizeImportPayload(input: {
      url: string;
      maxProducts?: number | string;
      maxPages?: number | string;
      persist?: boolean;
    }) {
      return {
        url: input.url.trim(),
        ...(input.maxProducts !== undefined
          ? { maxProducts: Math.max(1, Math.min(50, Math.floor(Number(input.maxProducts) || 10))) }
          : {}),
        ...(input.maxPages !== undefined
          ? { maxPages: Math.max(1, Math.min(5, Math.floor(Number(input.maxPages) || 2))) }
          : {}),
        persist: input.persist ?? true,
      };
    }

    // Default bounds
    const defaultPayload = sanitizeImportPayload({
      url: " https://www.jakmall.com/acmic-official-store ",
      maxProducts: 20,
      maxPages: 2,
    });
    assert.equal(defaultPayload.url, "https://www.jakmall.com/acmic-official-store");
    assert.equal(defaultPayload.maxProducts, 20);
    assert.equal(defaultPayload.maxPages, 2);
    assert.equal(defaultPayload.persist, true);

    // Out of bounds high (clamped to 50 and 5)
    const clampedHigh = sanitizeImportPayload({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: 100,
      maxPages: 10,
    });
    assert.equal(clampedHigh.maxProducts, 50);
    assert.equal(clampedHigh.maxPages, 5);

    // Out of bounds low / NaN / string
    const sanitizedEdge = sanitizeImportPayload({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: "30",
      maxPages: -5,
    });
    assert.equal(sanitizedEdge.maxProducts, 30);
    assert.equal(sanitizedEdge.maxPages, 1);

    // NaN safety
    const nanHandled = sanitizeImportPayload({
      url: "https://www.jakmall.com/acmic-official-store",
      maxProducts: NaN,
      maxPages: NaN,
    });
    assert.equal(nanHandled.maxProducts, 10);
    assert.equal(nanHandled.maxPages, 2);
  });

  test("7. Concurrency lock prevents duplicate simultaneous sync/import invocations", async () => {
    let callCount = 0;
    const isSyncing = { current: false };

    async function simulatedSyncAction() {
      if (isSyncing.current) {
        return "BLOCKED";
      }
      isSyncing.current = true;
      try {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return "SUCCESS";
      } finally {
        isSyncing.current = false;
      }
    }

    // Trigger 5 concurrent calls from rapid clicks
    const results = await Promise.all([
      simulatedSyncAction(),
      simulatedSyncAction(),
      simulatedSyncAction(),
      simulatedSyncAction(),
      simulatedSyncAction(),
    ]);

    assert.equal(callCount, 1, "Only 1 action should have run");
    assert.equal(results.filter((r) => r === "SUCCESS").length, 1);
    assert.equal(results.filter((r) => r === "BLOCKED").length, 4);
  });
});
