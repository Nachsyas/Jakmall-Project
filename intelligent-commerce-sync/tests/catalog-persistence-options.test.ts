import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { CanonicalProduct } from "../src/canonical/types.js";
import { CatalogPersistenceService } from "../src/catalog/catalog-persistence.js";

test("CatalogPersistenceService passes bounded transaction options { maxWait: 5000, timeout: 10000 }", async () => {
  let capturedOptions: unknown = null;

  const mockPrisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      capturedOptions = options;
      const mockTx = {
        productSource: {
          findUnique: async () => null,
          create: async () => ({ id: "mock-ps-id", productId: "mock-p-id" }),
        },
        product: {
          create: async () => ({ id: "mock-p-id" }),
        },
        sourceVariant: {
          upsert: async () => ({}),
        },
        sourceSnapshot: {
          create: async () => ({ id: "mock-snap-id" }),
        },
        syncEvent: {
          create: async () => ({}),
        },
      };
      return await fn(mockTx);
    },
  } as unknown as PrismaClient;

  const persistence = new CatalogPersistenceService(mockPrisma);

  const sampleCanonical: CanonicalProduct = {
    source: "jakmall",
    sourceProductId: "sample-id-12345",
    sourceUrl: "https://www.jakmall.com/sample-store/sample-item",
    title: "Sample Item",
    description: "Sample Description",
    brand: "SampleBrand",
    categoryPath: ["Category", "Subcategory"],
    variants: [],
    images: [],
    specifications: {},
    seller: { id: "seller-123", name: "Sample Store" },
    fetchedAt: new Date("2026-09-05T12:00:00.000Z"),
  };

  const result = await persistence.persistCanonicalProduct(sampleCanonical);

  assert.equal(result.productId, "mock-p-id");
  assert.equal(result.productSourceId, "mock-ps-id");
  assert.equal(result.sourceSnapshotId, "mock-snap-id");

  assert.deepEqual(capturedOptions, {
    maxWait: 5000,
    timeout: 10000,
  });
});
