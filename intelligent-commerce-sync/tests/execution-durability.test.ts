import test from "node:test";
import assert from "node:assert/strict";
import type {
  PrismaClient,
  SyncJob,
  IdempotencyRecord,
  SyncEvent,
  AuditLog,
  ProductSource,
  SourceSnapshot,
  MarketplaceListing,
  MarketplaceListingVariant,
  Prisma,
} from "@prisma/client";
import {
  type CreateListingExecutionPayload,
  type DurableExecutionPayload,
  DurableExecutionIdentityError,
  DurablePayloadValidationError,
  mapSyncOperationTypeToJobType,
  PayloadImmutabilityViolationError,
  type UpdatePriceExecutionPayload,
  type UpdateStockExecutionPayload,
  assertDurablePayloadReadyForExecution,
} from "../src/execution/types.js";
import { validateDurableExecutionPayload } from "../src/execution/durable-payload.js";
import {
  SyncRuntimeRepository,
  isIdempotencyKeyUniqueConflict,
} from "../src/persistence/repositories/sync-runtime-repository.js";
import type { SyncPlannedOperation } from "../src/sync/types.js";

interface MockPrismaOptions {
  failOnIdempotencyCreateWithP2002?: boolean;
  p2002Target?: string | string[];
  failWithGenericError?: boolean;
  seedIdempotencyRecords?: IdempotencyRecord[];
  seedSyncJobs?: SyncJob[];
  seedListingVariants?: MarketplaceListingVariant[];
  customListingVariants?: MarketplaceListingVariant[];
  customSourceSnapshots?: SourceSnapshot[];
}

/**
 * In-memory Mock PrismaClient with seed entity stores to test repository transactions,
 * entity identity checks, P2002 race recovery, variant integrity, and immutability invariants.
 */
function createMockPrismaClient(options: MockPrismaOptions = {}): PrismaClient {
  const productSourceStore = new Map<string, ProductSource>([
    [
      "ps-001",
      {
        id: "ps-001",
        productId: "prod-001",
        source: "jakmall",
        sourceProductId: "6970238281488",
        sourceUrl: "https://www.jakmall.com/item/1",
        sourceSellerId: "seller-jakmall-1",
        sourceSellerName: "Jakmall Store",
        lastFetchedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "ps-002",
      {
        id: "ps-002",
        productId: "prod-002",
        source: "jakmall",
        sourceProductId: "7372731614335",
        sourceUrl: "https://www.jakmall.com/item/2",
        sourceSellerId: "seller-jakmall-2",
        sourceSellerName: "Jakmall Store 2",
        lastFetchedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "ps-synthetic",
      {
        id: "ps-synthetic",
        productId: "prod-synthetic",
        source: "jakmall",
        sourceProductId: "123",
        sourceUrl: "https://www.jakmall.com/item/123",
        sourceSellerId: "seller-123",
        sourceSellerName: "Synthetic Store",
        lastFetchedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  ]);

  const sourceSnapshotStore = new Map<string, SourceSnapshot>([
    [
      "snap-001",
      {
        id: "snap-001",
        productSourceId: "ps-001",
        sourceHash: "hash-001",
        contentHash: "chash-001",
        priceHash: "phash-001",
        inventoryHash: "ihash-001",
        variantHash: "vhash-001",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
    [
      "snap-002",
      {
        id: "snap-002",
        productSourceId: "ps-001",
        sourceHash: "hash-002",
        contentHash: "chash-002",
        priceHash: "phash-002",
        inventoryHash: "ihash-002",
        variantHash: "vhash-002",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
    [
      "snap-other-ps",
      {
        id: "snap-other-ps",
        productSourceId: "ps-002", // Belongs to ps-002
        sourceHash: "hash-other",
        contentHash: "chash-other",
        priceHash: "phash-other",
        inventoryHash: "ihash-other",
        variantHash: "vhash-other",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
    [
      "snap-01",
      {
        id: "snap-01",
        productSourceId: "ps-synthetic",
        sourceHash: "hash-synth-1",
        contentHash: "chash-synth-1",
        priceHash: "phash-synth-1",
        inventoryHash: "ihash-synth-1",
        variantHash: "vhash-synth-1",
        canonicalPayload: {
          variants: [{ sourceSkuId: "sku1" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  ]);

  if (options.customSourceSnapshots) {
    for (const snap of options.customSourceSnapshots) {
      sourceSnapshotStore.set(snap.id, snap);
    }
  }

  const marketplaceListingStore = new Map<string, MarketplaceListing>([
    [
      "listing-001",
      {
        id: "listing-001",
        productId: "prod-001",
        marketplace: "shopee",
        sellerAccountKey: "seller_main",
        remoteListingId: "shopee-item-999",
        status: "PUBLISHED",
        lastVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "listing-wrong-prod",
      {
        id: "listing-wrong-prod",
        productId: "prod-999",
        marketplace: "shopee",
        sellerAccountKey: "seller_main",
        remoteListingId: "shopee-item-wrong",
        status: "PUBLISHED",
        lastVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "listing-no-remote",
      {
        id: "listing-no-remote",
        productId: "prod-001",
        marketplace: "shopee",
        sellerAccountKey: "seller_main",
        remoteListingId: null,
        status: "DRAFT",
        lastVerifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    [
      "listing-blank-remote",
      {
        id: "listing-blank-remote",
        productId: "prod-001",
        marketplace: "shopee",
        sellerAccountKey: "seller_main",
        remoteListingId: "   ",
        status: "DRAFT",
        lastVerifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  ]);

  const listingVariantsStore = new Map<string, MarketplaceListingVariant[]>();
  if (options.customListingVariants !== undefined) {
    for (const lv of options.customListingVariants) {
      const existing = listingVariantsStore.get(lv.listingId) ?? [];
      existing.push(lv);
      listingVariantsStore.set(lv.listingId, existing);
    }
  } else {
    listingVariantsStore.set("listing-001", [
      {
        id: "lv-001",
        listingId: "listing-001",
        sourceSkuId: "5502951494118",
        destinationSku: "dest-001",
        remoteVariantId: "remote-var-001",
        lastKnownDestinationPrice: 450000,
        lastKnownDestinationStock: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    listingVariantsStore.set("listing-no-remote", [
      {
        id: "lv-nr-001",
        listingId: "listing-no-remote",
        sourceSkuId: "5502951494118",
        destinationSku: "dest-001",
        remoteVariantId: null,
        lastKnownDestinationPrice: 450000,
        lastKnownDestinationStock: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    listingVariantsStore.set("listing-blank-remote", [
      {
        id: "lv-br-001",
        listingId: "listing-blank-remote",
        sourceSkuId: "5502951494118",
        destinationSku: "dest-001",
        remoteVariantId: null,
        lastKnownDestinationPrice: 450000,
        lastKnownDestinationStock: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  }

  if (options.seedListingVariants) {
    for (const lv of options.seedListingVariants) {
      const existing = listingVariantsStore.get(lv.listingId) ?? [];
      existing.push(lv);
      listingVariantsStore.set(lv.listingId, existing);
    }
  }

  const idempotencyStore = new Map<string, IdempotencyRecord>();
  if (options.seedIdempotencyRecords) {
    for (const rec of options.seedIdempotencyRecords) {
      idempotencyStore.set(rec.key, rec);
    }
  }

  const syncJobStore = new Map<string, SyncJob>();
  if (options.seedSyncJobs) {
    for (const job of options.seedSyncJobs) {
      syncJobStore.set(job.id, job);
    }
  }

  const syncEventStore: SyncEvent[] = [];
  const auditLogStore: AuditLog[] = [];

  let idCounter = 1;

  const mockTx = {
    productSource: {
      findUnique: async ({ where }: { where: { id: string } }) => productSourceStore.get(where.id) ?? null,
    },
    sourceSnapshot: {
      findUnique: async ({ where }: { where: { id: string } }) => sourceSnapshotStore.get(where.id) ?? null,
    },
    marketplaceListing: {
      findUnique: async ({ where }: { where: { id: string } }) => marketplaceListingStore.get(where.id) ?? null,
    },
    marketplaceListingVariant: {
      findMany: async ({ where }: { where: { listingId: string } }) => listingVariantsStore.get(where.listingId) ?? [],
    },
    idempotencyRecord: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        return idempotencyStore.get(where.key) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failOnIdempotencyCreateWithP2002) {
          const p2002Err = new Error("Unique constraint failed on the fields: (`key`)");
          (p2002Err as unknown as { code: string; meta: { target: unknown } }).code = "P2002";
          (p2002Err as unknown as { code: string; meta: { target: unknown } }).meta = {
            target: options.p2002Target ?? ["key"],
          };
          throw p2002Err;
        }
        if (options.failWithGenericError) {
          throw new Error("Database connection lost");
        }

        const id = `idem-${idCounter++}`;
        const record: IdempotencyRecord = {
          id,
          key: data["key"] as string,
          operationType: data["operationType"] as string,
          status: data["status"] as "STARTED" | "COMPLETED" | "FAILED",
          marketplace: (data["marketplace"] as string) ?? null,
          sellerAccountKey: (data["sellerAccountKey"] as string) ?? null,
          productSourceId: (data["productSourceId"] as string) ?? null,
          syncJobId: (data["syncJobId"] as string) ?? null,
          result: null,
          createdAt: new Date(),
          completedAt: null,
        };
        idempotencyStore.set(record.key, record);
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        let target: IdempotencyRecord | undefined;
        for (const rec of idempotencyStore.values()) {
          if (rec.id === where.id) {
            target = rec;
            break;
          }
        }
        if (!target) throw new Error("IdempotencyRecord not found");
        const updated: IdempotencyRecord = { ...target, ...data } as IdempotencyRecord;
        idempotencyStore.set(updated.key, updated);
        return updated;
      },
    },
    syncJob: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        return syncJobStore.get(where.id) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `job-${idCounter++}`;
        const job: SyncJob = {
          id,
          productSourceId: (data["productSourceId"] as string) ?? null,
          marketplaceListingId: (data["marketplaceListingId"] as string) ?? null,
          sourceSnapshotId: (data["sourceSnapshotId"] as string) ?? null,
          operationType: data["operationType"] as SyncJob["operationType"],
          jobType: data["jobType"] as SyncJob["jobType"],
          status: data["status"] as SyncJob["status"],
          idempotencyKey: data["idempotencyKey"] as string,
          executionPayload: data["executionPayload"] as Prisma.JsonValue,
          payloadVersion: (data["payloadVersion"] as number) ?? 1,
          attemptCount: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        syncJobStore.set(id, job);
        return job;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = syncJobStore.get(where.id);
        if (!existing) throw new Error("SyncJob not found");
        const updated: SyncJob = { ...existing, ...data, updatedAt: new Date() };
        syncJobStore.set(where.id, updated);
        return updated;
      },
    },
    syncEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const event: SyncEvent = {
          id: `event-${idCounter++}`,
          syncJobId: (data["syncJobId"] as string) ?? null,
          productSourceId: (data["productSourceId"] as string) ?? null,
          marketplaceListingId: (data["marketplaceListingId"] as string) ?? null,
          sourceSnapshotId: (data["sourceSnapshotId"] as string) ?? null,
          eventType: data["eventType"] as SyncEvent["eventType"],
          payload: (data["payload"] as Prisma.JsonValue) ?? null,
          createdAt: new Date(),
        };
        syncEventStore.push(event);
        return event;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const log: AuditLog = {
          id: `audit-${idCounter++}`,
          actorType: data["actorType"] as string,
          actorId: (data["actorId"] as string) ?? null,
          action: data["action"] as string,
          entityType: data["entityType"] as string,
          entityId: data["entityId"] as string,
          before: (data["before"] as Prisma.JsonValue) ?? null,
          after: (data["after"] as Prisma.JsonValue) ?? null,
          metadata: (data["metadata"] as Prisma.JsonValue) ?? null,
          createdAt: new Date(),
        };
        auditLogStore.push(log);
        return log;
      },
    },
  };

  return {
    $transaction: async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      return fn(mockTx);
    },
    productSource: mockTx.productSource,
    sourceSnapshot: mockTx.sourceSnapshot,
    marketplaceListing: mockTx.marketplaceListing,
    marketplaceListingVariant: mockTx.marketplaceListingVariant,
    syncJob: mockTx.syncJob,
    idempotencyRecord: mockTx.idempotencyRecord,
    syncEvent: mockTx.syncEvent,
    auditLog: mockTx.auditLog,
    $disconnect: async () => {},
  } as unknown as PrismaClient;
}

// ----------------------------------------------------------------------
// Tests: Durable Execution Contract & Validation (Restored 1–40)
// ----------------------------------------------------------------------

test("1. CREATE_LISTING exact operation type survives durable mapping", () => {
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "ACMIC CPD65 GaN 65W Super Fast Charger",
    preparedDescription: "Original ACMIC Fast Charger 65W with Multi-port Protection",
    targetCategoryId: "100012",
    targetCategoryName: "Handphone & Aksesoris > Charger",
    brand: "ACMIC",
    totalWeightGrams: 250,
    images: [{ url: "https://img.jakmall.com/item1.jpg", position: 1 }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "ACMIC-CPD65-PRO",
        attributes: { Type: "PRO Only" },
        targetPriceIdr: 454800,
        inventory: { resolution: "RESOLVED", targetQuantity: 3 },
      },
    ],
  };

  const validated = validateDurableExecutionPayload(payload);
  assert.equal(validated.operationType, "CREATE_LISTING");
  assert.equal(validated.schemaVersion, 1);
  assert.equal(validated.variants.length, 1);
  assert.equal(validated.variants[0]?.targetPriceIdr, 454800);
});

test("2. UPDATE_PRICE exact operation type survives durable mapping", () => {
  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-002",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [
      {
        sourceSkuId: "5502951494118",
        targetPriceIdr: 499000,
      },
    ],
  };

  const validated = validateDurableExecutionPayload(payload);
  assert.equal(validated.operationType, "UPDATE_PRICE");
  assert.equal(validated.variants[0]?.targetPriceIdr, 499000);
});

test("3. UPDATE_STOCK exact operation type survives durable mapping", () => {
  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-002",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [
      {
        sourceSkuId: "5502951494118",
        inventory: { resolution: "RESOLVED", targetQuantity: 15 },
      },
    ],
  };

  const validated = validateDurableExecutionPayload(payload);
  assert.equal(validated.operationType, "UPDATE_STOCK");
  if (validated.operationType === "UPDATE_STOCK") {
    assert.equal(validated.variants[0]?.inventory.resolution, "RESOLVED");
  }
});

test("4. jobType remains broad and is NOT used to infer operation type", () => {
  assert.equal(mapSyncOperationTypeToJobType("CREATE_LISTING"), "FULL_SYNC");
  assert.equal(mapSyncOperationTypeToJobType("UPDATE_PRICE"), "PRICE_UPDATE");
  assert.equal(mapSyncOperationTypeToJobType("UPDATE_STOCK"), "STOCK_UPDATE");
});

test("5. UPDATE_PRICE payload rejects: zero, negative, decimal price, duplicate SKU, empty variants", () => {
  const base: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    remoteListingId: "shopee-item-1",
    variants: [{ sourceSkuId: "sku1", targetPriceIdr: 100000 }],
  };

  assert.throws(
    () => validateDurableExecutionPayload({ ...base, variants: [{ sourceSkuId: "sku1", targetPriceIdr: 0 }] }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, variants: [{ sourceSkuId: "sku1", targetPriceIdr: -500 }] }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, variants: [{ sourceSkuId: "sku1", targetPriceIdr: 1500.5 }] }),
    DurablePayloadValidationError
  );
  assert.throws(
    () =>
      validateDurableExecutionPayload({
        ...base,
        variants: [
          { sourceSkuId: "sku1", targetPriceIdr: 100000 },
          { sourceSkuId: "sku1", targetPriceIdr: 120000 },
        ],
      }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, variants: [] }),
    DurablePayloadValidationError
  );
});

test("6. UPDATE_STOCK payload rejects: negative, decimal quantity, duplicate SKU, empty variants", () => {
  const base: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    remoteListingId: "shopee-item-1",
    variants: [{ sourceSkuId: "sku1", inventory: { resolution: "RESOLVED", targetQuantity: 10 } }],
  };

  assert.throws(
    () =>
      validateDurableExecutionPayload({
        ...base,
        variants: [{ sourceSkuId: "sku1", inventory: { resolution: "RESOLVED", targetQuantity: -1 } }],
      }),
    DurablePayloadValidationError
  );
  assert.throws(
    () =>
      validateDurableExecutionPayload({
        ...base,
        variants: [{ sourceSkuId: "sku1", inventory: { resolution: "RESOLVED", targetQuantity: 5.5 } }],
      }),
    DurablePayloadValidationError
  );
  assert.throws(
    () =>
      validateDurableExecutionPayload({
        ...base,
        variants: [
          { sourceSkuId: "sku1", inventory: { resolution: "RESOLVED", targetQuantity: 10 } },
          { sourceSkuId: "sku1", inventory: { resolution: "RESOLVED", targetQuantity: 20 } },
        ],
      }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, variants: [] }),
    DurablePayloadValidationError
  );
});

test("7. BLOCKED UPDATE_PRICE can be durably represented without remote ID", () => {
  const blockedPayload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    variants: [{ sourceSkuId: "sku1", targetPriceIdr: 100000 }],
  };

  const validated = validateDurableExecutionPayload(blockedPayload);
  assert.equal(validated.operationType, "UPDATE_PRICE");
  assert.equal(validated.remoteListingId, undefined);
});

test("8. BLOCKED UPDATE_STOCK can be durably represented without remote ID", () => {
  const blockedPayload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    variants: [{ sourceSkuId: "sku1", inventory: { resolution: "BLOCKED" } }],
  };

  const validated = validateDurableExecutionPayload(blockedPayload);
  assert.equal(validated.operationType, "UPDATE_STOCK");
  if (validated.operationType === "UPDATE_STOCK") {
    assert.equal(validated.variants[0]?.inventory.resolution, "BLOCKED");
  }
});

test("9. REQUIRES_REVIEW UPDATE_STOCK can preserve NEEDS_REVIEW inventory", () => {
  const reviewPayload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    variants: [{ sourceSkuId: "sku1", inventory: { resolution: "NEEDS_REVIEW" } }],
  };

  const validated = validateDurableExecutionPayload(reviewPayload);
  assert.equal(validated.operationType, "UPDATE_STOCK");
  if (validated.operationType === "UPDATE_STOCK") {
    assert.equal(validated.variants[0]?.inventory.resolution, "NEEDS_REVIEW");
  }
});

test("10. ELIGIBLE UPDATE_PRICE rejects absent remote ID", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurablePayloadValidationError
  );
});

test("11. ELIGIBLE UPDATE_STOCK rejects absent remote ID", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Inventory changed",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", inventory: { resolution: "RESOLVED", targetQuantity: 10 } }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurablePayloadValidationError
  );
});

test("12. ELIGIBLE UPDATE_STOCK rejects unresolved quantity", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Inventory changed",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", inventory: { resolution: "NEEDS_REVIEW" } }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurablePayloadValidationError
  );
});

test("13. CREATE_LISTING review payload can contain unresolved inventory", () => {
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Draft Title",
    preparedDescription: "Draft Description",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "NEEDS_REVIEW" },
      },
    ],
  };

  const validated = validateDurableExecutionPayload(payload);
  assert.equal(validated.operationType, "CREATE_LISTING");
  if (validated.operationType === "CREATE_LISTING") {
    assert.equal(validated.variants[0]?.inventory.resolution, "NEEDS_REVIEW");
  }
});

test("14. CREATE execution readiness rejects unresolved inventory", () => {
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Draft Title",
    preparedDescription: "Draft Description",
    targetCategoryId: "1001",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "NEEDS_REVIEW" },
      },
    ],
  };

  assert.throws(
    () => assertDurablePayloadReadyForExecution(payload),
    DurablePayloadValidationError
  );
});

test("15. CREATE execution readiness rejects unresolved category", () => {
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Draft Title",
    preparedDescription: "Draft Description",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  assert.throws(
    () => assertDurablePayloadReadyForExecution(payload),
    DurablePayloadValidationError
  );
});

test("16. CREATE execution readiness accepts fully resolved intent", () => {
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Description",
    targetCategoryId: "1001",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  assert.doesNotThrow(() => assertDurablePayloadReadyForExecution(payload));
});

test("17. UPDATE execution readiness accepts valid resolved intent", () => {
  const pricePayload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };
  assert.doesNotThrow(() => assertDurablePayloadReadyForExecution(pricePayload));

  const stockPayload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-999",
    variants: [{ sourceSkuId: "5502951494118", inventory: { resolution: "RESOLVED", targetQuantity: 10 } }],
  };
  assert.doesNotThrow(() => assertDurablePayloadReadyForExecution(stockPayload));
});

test("18. CREATE review replacement may move snapshot A -> B when both snapshots belong to same ProductSource", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "First snapshot requires review",
  };

  const payload1: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Original Title",
    preparedDescription: "Original Description",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "NEEDS_REVIEW" },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: payload1,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const payload2: CreateListingExecutionPayload = {
    ...payload1,
    sourceSnapshotId: "snap-002",
    preparedTitle: "Updated Title for snap-002",
  };

  const replaced = await repo.replaceReviewPayload({
    syncJobId: created.syncJob.id,
    newPayload: payload2,
    reviewedBy: "operator-1",
    notes: "Refreshed to snap-002",
  });

  assert.equal(replaced.syncJob.sourceSnapshotId, "snap-002");
  assert.equal(replaced.syncJob.payloadVersion, 2);
});

test("19. CREATE snapshot change to another ProductSource rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "First snapshot",
  };

  const payload1: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "NEEDS_REVIEW" },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: payload1,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const foreignSnapshotPayload: CreateListingExecutionPayload = {
    ...payload1,
    sourceSnapshotId: "snap-other-ps",
  };

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: foreignSnapshotPayload,
      }),
    DurableExecutionIdentityError
  );
});

test("20. UPDATE_PRICE snapshot replacement rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Price review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: { ...payload, sourceSnapshotId: "snap-002" },
      }),
    PayloadImmutabilityViolationError
  );
});

test("21. UPDATE_STOCK snapshot replacement rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Inventory review",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", inventory: { resolution: "NEEDS_REVIEW" } }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: { ...payload, sourceSnapshotId: "snap-002" },
      }),
    PayloadImmutabilityViolationError
  );
});

test("22. existing reservation null syncJobId rejected", async () => {
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const existingRecord: IdempotencyRecord = {
    id: "idem-null-job",
    key: op.idempotencyKey,
    operationType: op.operationType,
    status: "STARTED",
    marketplace: op.marketplace,
    sellerAccountKey: op.sellerAccountKey,
    productSourceId: "ps-001",
    syncJobId: null,
    result: null,
    createdAt: new Date(),
    completedAt: null,
  };

  const mockPrisma = createMockPrismaClient({
    seedIdempotencyRecords: [existingRecord],
  });
  const repo = new SyncRuntimeRepository(mockPrisma);

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("23. unrelated P2002 rejected", async () => {
  const racingMockPrisma = createMockPrismaClient({
    failOnIdempotencyCreateWithP2002: true,
    p2002Target: ["email_key"], // Unrelated unique target!
  });
  const repo = new SyncRuntimeRepository(racingMockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    (err: unknown) => {
      assert(err instanceof Error);
      assert((err as unknown as { code: string }).code === "P2002");
      return true;
    }
  );
});

test("24. idempotency-key P2002 conservative matching", () => {
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: ["key"] } }), true);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: "idempotency_records_key_key" } }), true);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: "idempotency_key" } }), true);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: "destinationSku_key" } }), false);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: "email_key" } }), false);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: "marketplaceListing_key" } }), false);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: ["destinationSku_key"] } }), false);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002", meta: { target: ["email"] } }), false);
  assert.equal(isIdempotencyKeyUniqueConflict({ code: "P2002" }), false);
  assert.equal(isIdempotencyKeyUniqueConflict(new Error("network timeout")), false);
});

test("25. unknown snapshot sourceSkuId rejected", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "UNKNOWN-SKU-999", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("26. update sourceSkuId without listing variant mapping rejected", async () => {
  const customPrisma = createMockPrismaClient({
    seedListingVariants: [
      {
        id: "lv-other",
        listingId: "listing-unmapped",
        sourceSkuId: "other-sku",
        destinationSku: "dest-other",
        remoteVariantId: "remote-var-2",
        lastKnownDestinationPrice: 100,
        lastKnownDestinationStock: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-unmapped",
      }),
    DurableExecutionIdentityError
  );
});

test("27. security denylist rejects metadata secret keys: token, credentials, clientSecret, privateKey", () => {
  const base = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "123",
    sourceSnapshotId: "snap-01",
    marketplace: "shopee",
    sellerAccountKey: "seller1",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [],
    variants: [
      {
        sourceSkuId: "sku1",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 10000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  assert.throws(
    () => validateDurableExecutionPayload({ ...base, metadata: { token: "secret_tok_123" } }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, metadata: { credentials: { key: "abc" } } }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, metadata: { clientSecret: "super_secret" } }),
    DurablePayloadValidationError
  );
  assert.throws(
    () => validateDurableExecutionPayload({ ...base, metadata: { privateKey: "-----BEGIN RSA..." } }),
    DurablePayloadValidationError
  );
});

// ----------------------------------------------------------------------
// Tests: Blocker 1 — Snapshot Validation Fail-Closed
// ----------------------------------------------------------------------

test("28. Blocker 1: malformed canonicalPayload rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-malformed",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: "not-an-object" as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);
  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-malformed",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-malformed",
      }),
    DurableExecutionIdentityError
  );
});

test("29. Blocker 1: missing canonical variants array rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-missing-variants",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: { title: "No variants" } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);
  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-missing-variants",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-missing-variants",
      }),
    DurableExecutionIdentityError
  );
});

test("30. Blocker 1: duplicate canonical sourceSkuId in snapshot rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-dup-sku",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }, { sourceSkuId: "5502951494118" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);
  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };
  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-dup-sku",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-dup-sku",
      }),
    DurableExecutionIdentityError
  );
});

// ----------------------------------------------------------------------
// Tests: Blocker 3 — ELIGIBLE Update Authoritative Remote ID Validation
// ----------------------------------------------------------------------

test("31. Blocker 3: ELIGIBLE update with persisted null remote ID rejected", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-no-remote", // Has null remoteListingId
      }),
    DurableExecutionIdentityError
  );
});

test("32. Blocker 3: ELIGIBLE update with blank persisted remote ID rejected", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-blank-remote", // Has whitespace remoteListingId
      }),
    DurableExecutionIdentityError
  );
});

// ----------------------------------------------------------------------
// Tests: Blocker 4 — Review Resolution of Update Execution Target
// ----------------------------------------------------------------------

test("33. Blocker 4: BLOCKED UPDATE_PRICE null listing -> validated listing allowed via resolveReviewExecutionTarget", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Listing not found at planning time",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  assert.equal(created.status, "CREATED");
  if (created.status !== "CREATED") throw new Error("Expected CREATED");
  assert.equal(created.syncJob.status, "BLOCKED");
  assert.equal(created.syncJob.marketplaceListingId, null);

  // Reviewer discovers and links listing-001
  const resolved = await repo.resolveReviewExecutionTarget({
    syncJobId: created.syncJob.id,
    marketplaceListingId: "listing-001",
    reviewedBy: "operator-5",
    notes: "Matched to listing-001",
  });

  assert.equal(resolved.syncJob.marketplaceListingId, "listing-001");
  assert.equal(resolved.syncJob.payloadVersion, 2);
  const updatedPayload = resolved.syncJob.executionPayload as unknown as UpdatePriceExecutionPayload;
  assert.equal(updatedPayload.remoteListingId, "shopee-item-999");
});

test("34. Blocker 4: resolved marketplaceListingId cannot later change", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to resolve to a different listing
  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-other",
      }),
    PayloadImmutabilityViolationError
  );
});

test("35. Review remote ID immutability: removing existing remoteListingId in replaceReviewPayload is rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Replacement payload omits remoteListingId
  const strippedPayload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    // remoteListingId omitted
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 110000 }],
  };

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: strippedPayload,
      }),
    PayloadImmutabilityViolationError
  );
});

// ----------------------------------------------------------------------
// Tests: Blocker 2 — Marketplace Variant Mapping Fail-Closed
// ----------------------------------------------------------------------

test("36. Blocker 2: zero listing variant mappings rejected with DurableExecutionIdentityError", async () => {
  const customPrisma = createMockPrismaClient({
    customListingVariants: [], // Explicitly zero variants across all listings
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001", // Has no matching listing variants in customPrisma
      }),
    DurableExecutionIdentityError
  );
});

test("37. Blocker 2: partial variant mappings rejected with DurableExecutionIdentityError", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-multi-var",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }, { sourceSkuId: "second-sku" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
    seedListingVariants: [
      // listing-001 only has 5502951494118, missing second-sku
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-multi-var",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-multi-var",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [
      { sourceSkuId: "5502951494118", targetPriceIdr: 100000 },
      { sourceSkuId: "second-sku", targetPriceIdr: 120000 },
    ],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-multi-var",
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("38. Blocker 2: complete subset mappings accepted", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-multi-var-ok",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }, { sourceSkuId: "second-sku" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
    seedListingVariants: [
      {
        id: "lv-002",
        listingId: "listing-001",
        sourceSkuId: "second-sku",
        destinationSku: "dest-002",
        remoteVariantId: "remote-var-002",
        lastKnownDestinationPrice: 120000,
        lastKnownDestinationStock: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-multi-var-ok",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-multi-var-ok",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [
      { sourceSkuId: "5502951494118", targetPriceIdr: 100000 },
      { sourceSkuId: "second-sku", targetPriceIdr: 120000 },
    ],
  };

  const res = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-multi-var-ok",
    marketplaceListingId: "listing-001",
  });
  assert.equal(res.status, "CREATED");
});

// ----------------------------------------------------------------------
// Tests: Blocker 3 — Mismatched & Matching Authoritative Remote ID
// ----------------------------------------------------------------------

test("39. Blocker 3: mismatched persisted/payload remoteListingId rejected", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-DIFFERENT", // Mismatch with listing-001 (shopee-item-999)
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  await assert.rejects(
    async () =>
      repo.reserveSyncJob({
        operation: op,
        payload,
        productSourceId: "ps-001",
        sourceSnapshotId: "snap-001",
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("40. Blocker 3: matching authoritative remoteListingId accepted", async () => {
  const repo = new SyncRuntimeRepository(createMockPrismaClient());
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const res = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  assert.equal(res.status, "CREATED");
});

// ----------------------------------------------------------------------
// Tests: Blocker 4 — Review Target-Resolution Lifecycle
// ----------------------------------------------------------------------

test("41. Blocker 4: BLOCKED UPDATE_STOCK null listing -> validated listing allowed via resolveReviewExecutionTarget", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-001",
    eligibility: "BLOCKED",
    reason: "Listing not found at planning time",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", inventory: { resolution: "RESOLVED", targetQuantity: 10 } }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  assert.equal(created.status, "CREATED");
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const resolved = await repo.resolveReviewExecutionTarget({
    syncJobId: created.syncJob.id,
    marketplaceListingId: "listing-001",
    reviewedBy: "operator-1",
  });

  assert.equal(resolved.syncJob.marketplaceListingId, "listing-001");
  const updatedPayload = resolved.syncJob.executionPayload as unknown as UpdateStockExecutionPayload;
  assert.equal(updatedPayload.remoteListingId, "shopee-item-999");
});

test("42. Blocker 4: resolved remoteListingId cannot later change in resolveReviewExecutionTarget", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to resolve to a listing with different remoteListingId or re-resolving
  const resolved = await repo.resolveReviewExecutionTarget({
    syncJobId: created.syncJob.id,
    marketplaceListingId: "listing-001",
  });
  assert.equal(resolved.syncJob.marketplaceListingId, "listing-001");
});

test("43. Blocker 4: target listing from another Product rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-wrong-prod", // Belongs to prod-999
      }),
    DurableExecutionIdentityError
  );
});

test("44. Blocker 4: target listing with wrong marketplace rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "tokopedia", // Tokopedia operation
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "tokopedia:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "tokopedia:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "tokopedia",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to resolve to a Shopee listing
  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-001", // Marketplace is 'shopee'
      }),
    DurableExecutionIdentityError
  );
});

test("45. Blocker 4: target listing with wrong seller rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_other",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_other:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_other:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_other",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-001", // sellerAccountKey is 'seller_main'
      }),
    DurableExecutionIdentityError
  );
});

test("46. Fix 2: resolver rejects target listing with null remoteListingId", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-no-remote",
      }),
    DurableExecutionIdentityError
  );
});

test("47. Blocker 4: variant mapping missing on target listing rejected during resolveReviewExecutionTarget", async () => {

  const customPrisma = createMockPrismaClient({
    customListingVariants: [], // Explicitly zero variants across all listings
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("48. Blocker 4: idempotencyKey and sourceSnapshotId remain identical after target resolution", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const resolved = await repo.resolveReviewExecutionTarget({
    syncJobId: created.syncJob.id,
    marketplaceListingId: "listing-001",
  });

  assert.equal(resolved.syncJob.idempotencyKey, op.idempotencyKey);
  assert.equal(resolved.syncJob.sourceSnapshotId, "snap-001");
});

// ----------------------------------------------------------------------
// Tests: Final Micro-Fix 1, 2, 3
// ----------------------------------------------------------------------

test("49. Fix 1: CREATE_LISTING NEEDS_REVIEW cannot call resolveReviewExecutionTarget", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "First snapshot",
  };

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-001",
      }),
    DurableExecutionIdentityError
  );
});

test("50. Fix 2: replaceReviewPayload cannot add remoteListingId when previously absent", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    // remoteListingId is undefined
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to introduce remoteListingId via replaceReviewPayload
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          remoteListingId: "shopee-item-introduced",
        },
      }),
    PayloadImmutabilityViolationError
  );
});

test("51. Fix 2: replaceReviewPayload cannot change resolved remoteListingId", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to change remoteListingId
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          remoteListingId: "shopee-item-changed",
        },
      }),
    PayloadImmutabilityViolationError
  );
});

test("52. Fix 2: resolver rejects blank persisted remoteListingId", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-blank-remote",
      }),
    DurableExecutionIdentityError
  );
});

test("53. Fix 2: preexisting mismatching remoteListingId rejected by resolver", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "BLOCKED",
    reason: "Blocked",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-DIFFERENT",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to resolve to listing-001 (which has remoteListingId 'shopee-item-999')
  await assert.rejects(
    async () =>
      repo.resolveReviewExecutionTarget({
        syncJobId: created.syncJob.id,
        marketplaceListingId: "listing-001",
      }),
    PayloadImmutabilityViolationError
  );
});

test("54. Fix 3: CREATE replacement malformed canonical payload rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-malformed-replace",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: "invalid-json" as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload1: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: payload1,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload1,
          sourceSnapshotId: "snap-malformed-replace",
        },
      }),
    DurableExecutionIdentityError
  );
});

test("55. Fix 3: CREATE replacement empty canonical variants rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-empty-var-replace",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: { variants: [] } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload1: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: payload1,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload1,
          sourceSnapshotId: "snap-empty-var-replace",
        },
      }),
    DurableExecutionIdentityError
  );
});

test("56. Fix 3: CREATE replacement duplicate canonical sourceSkuId rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-dup-var-replace",
        productSourceId: "ps-001",
        sourceHash: "h1",
        contentHash: "c1",
        priceHash: "p1",
        inventoryHash: "i1",
        variantHash: "v1",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }, { sourceSkuId: "5502951494118" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload1: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: payload1,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload1,
          sourceSnapshotId: "snap-dup-var-replace",
        },
      }),
    DurableExecutionIdentityError
  );
});

test("57. Fix 3: extractCanonicalSnapshotSkuSet pure helper validation", async () => {
  const { extractCanonicalSnapshotSkuSet } = await import(
    "../src/persistence/repositories/sync-runtime-repository.js"
  );

  const valid = extractCanonicalSnapshotSkuSet({
    variants: [{ sourceSkuId: "sku-a" }, { sourceSkuId: "sku-b" }],
  });
  assert.equal(valid.size, 2);
  assert.equal(valid.has("sku-a"), true);
  assert.equal(valid.has("sku-b"), true);

  assert.throws(() => extractCanonicalSnapshotSkuSet(null), DurableExecutionIdentityError);
  assert.throws(() => extractCanonicalSnapshotSkuSet({}), DurableExecutionIdentityError);
  assert.throws(() => extractCanonicalSnapshotSkuSet({ variants: [] }), DurableExecutionIdentityError);
  assert.throws(
    () => extractCanonicalSnapshotSkuSet({ variants: [{ sourceSkuId: "sku-1" }, { sourceSkuId: "sku-1" }] }),
    DurableExecutionIdentityError
  );
});

// ----------------------------------------------------------------------
// Tests: Review Payload Source Integrity (Tests 58 - 67)
// ----------------------------------------------------------------------

test("58. Review Integrity: CREATE replacement with same snapshot but unknown SKU rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting replacement with unknown SKU on the same snapshot
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [
            {
              sourceSkuId: "unknown-sku-999",
              destinationSku: "dest1",
              attributes: {},
              targetPriceIdr: 100000,
              inventory: { resolution: "RESOLVED", targetQuantity: 5 },
            },
          ],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("59. Review Integrity: CREATE replacement with same snapshot but missing canonical SKU rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-two-skus",
        productSourceId: "ps-001",
        sourceHash: "h2",
        contentHash: "c2",
        priceHash: "p2",
        inventoryHash: "i2",
        variantHash: "v2",
        canonicalPayload: {
          variants: [{ sourceSkuId: "sku-alpha" }, { sourceSkuId: "sku-beta" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-two-skus",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "sku-alpha",
        destinationSku: "dest-a",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
      {
        sourceSkuId: "sku-beta",
        destinationSku: "dest-b",
        attributes: {},
        targetPriceIdr: 120000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-two-skus",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting replacement with only one of the two canonical SKUs
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [
            {
              sourceSkuId: "sku-alpha",
              destinationSku: "dest-a",
              attributes: {},
              targetPriceIdr: 110000,
              inventory: { resolution: "RESOLVED", targetQuantity: 5 },
            },
          ],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("60. Review Integrity: CREATE replacement with same snapshot exact canonical SKU set accepted", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const replaced = await repo.replaceReviewPayload({
    syncJobId: created.syncJob.id,
    newPayload: {
      ...payload,
      preparedTitle: "Updated Title for Review",
      variants: [
        {
          sourceSkuId: "5502951494118",
          destinationSku: "dest1",
          attributes: {},
          targetPriceIdr: 150000,
          inventory: { resolution: "RESOLVED", targetQuantity: 10 },
        },
      ],
    },
  });

  assert.equal(replaced.syncJob.payloadVersion, 2);
  const replacedPayload = replaced.syncJob.executionPayload as unknown as CreateListingExecutionPayload;
  assert.equal(replacedPayload.preparedTitle, "Updated Title for Review");
  const firstVariant = replacedPayload.variants[0];
  if (!firstVariant) throw new Error("Expected at least one variant");
  assert.equal(firstVariant.targetPriceIdr, 150000);
});

test("61. Review Integrity: UPDATE_PRICE replacement with unknown snapshot SKU rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to replace with an SKU not in snap-001
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [{ sourceSkuId: "unknown-snapshot-sku", targetPriceIdr: 110000 }],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("62. Review Integrity: UPDATE_STOCK replacement with unknown snapshot SKU rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [
      {
        sourceSkuId: "5502951494118",
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting to replace with an SKU not in snap-001
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [
            {
              sourceSkuId: "unknown-snapshot-sku",
              inventory: { resolution: "RESOLVED", targetQuantity: 8 },
            },
          ],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("63. Review Integrity: UPDATE replacement with resolved listing but missing listing variant mapping rejected", async () => {
  const customPrisma = createMockPrismaClient({
    customSourceSnapshots: [
      {
        id: "snap-with-unmapped-sku",
        productSourceId: "ps-001",
        sourceHash: "h-unmapped",
        contentHash: "c-unmapped",
        priceHash: "p-unmapped",
        inventoryHash: "i-unmapped",
        variantHash: "v-unmapped",
        canonicalPayload: {
          variants: [{ sourceSkuId: "5502951494118" }, { sourceSkuId: "sku-unmapped-on-listing" }],
        } as unknown as Prisma.JsonValue,
        sourceFetchedAt: new Date(),
        capturedAt: new Date(),
      },
    ],
  });
  const repo = new SyncRuntimeRepository(customPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-with-unmapped-sku",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-with-unmapped-sku",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-with-unmapped-sku",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Attempting replacement with 'sku-unmapped-on-listing' (exists in snapshot, but missing on listing-001)
  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [{ sourceSkuId: "sku-unmapped-on-listing", targetPriceIdr: 120000 }],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("64. Review Integrity: UPDATE replacement with valid snapshot SKU and valid listing mapping accepted", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const replaced = await repo.replaceReviewPayload({
    syncJobId: created.syncJob.id,
    newPayload: {
      ...payload,
      variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 250000 }],
    },
  });

  assert.equal(replaced.syncJob.payloadVersion, 2);
  const replacedPayload = replaced.syncJob.executionPayload as unknown as UpdatePriceExecutionPayload;
  const firstVariant = replacedPayload.variants[0];
  if (!firstVariant) throw new Error("Expected at least one variant");
  assert.equal(firstVariant.targetPriceIdr, 250000);
});

test("65. Review Integrity: corrupted job.operationType vs payload operationType rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Corrupt persisted job.operationType
  created.syncJob.operationType = "CREATE_LISTING";

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 120000 }],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("66. Review Integrity: UPDATE job.sourceSnapshotId vs payload sourceSnapshotId mismatch rejected", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    remoteListingId: "shopee-item-999",
    variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 100000 }],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
    marketplaceListingId: "listing-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Corrupt persisted job.sourceSnapshotId
  created.syncJob.sourceSnapshotId = "snap-002";

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          variants: [{ sourceSkuId: "5502951494118", targetPriceIdr: 120000 }],
        },
      }),
    DurableExecutionIdentityError
  );
});

test("67. Review Integrity: CREATE current job/payload snapshot disagreement rejected before attempting snapshot refresh", async () => {
  const mockPrisma = createMockPrismaClient();
  const repo = new SyncRuntimeRepository(mockPrisma);

  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    baseOperationKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    idempotencyKey: "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING",
    eligibility: "REQUIRES_REVIEW",
    reason: "Review",
  };

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snap-001",
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    preparedTitle: "Title",
    preparedDescription: "Desc",
    images: [{ url: "https://img.jakmall.com/1.jpg" }],
    variants: [
      {
        sourceSkuId: "5502951494118",
        destinationSku: "dest1",
        attributes: {},
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: "ps-001",
    sourceSnapshotId: "snap-001",
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  // Corrupt persisted job.sourceSnapshotId
  created.syncJob.sourceSnapshotId = "snap-corrupted";

  await assert.rejects(
    async () =>
      repo.replaceReviewPayload({
        syncJobId: created.syncJob.id,
        newPayload: {
          ...payload,
          sourceSnapshotId: "snap-002",
        },
      }),
    DurableExecutionIdentityError
  );
});
