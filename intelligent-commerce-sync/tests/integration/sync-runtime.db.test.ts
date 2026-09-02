import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { SyncRuntimeRepository, isIdempotencyKeyUniqueConflict } from "../../src/persistence/repositories/sync-runtime-repository.js";
import {
  type CreateListingExecutionPayload,
  type UpdatePriceExecutionPayload,
  type UpdateStockExecutionPayload,
} from "../../src/execution/types.js";
import { validateDurableExecutionPayload } from "../../src/execution/durable-payload.js";
import {
  generateSyncBaseOperationKey,
  generateSyncOperationIdempotencyKey,
} from "../../src/sync/idempotency.js";
import type { SyncPlannedOperation } from "../../src/sync/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is required for DB integration tests. " +
    "Example: DATABASE_URL='postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public'"
  );
}

const NS = "phase4c1b_test_";

const fixtures = {
  productId: `${NS}prod_01`,
  productSourceId: `${NS}ps_01`,
  sourceProductId: `${NS}src_prod_01`,
  sourceSkuId1: `${NS}sku_01`,
  sourceSkuId2: `${NS}sku_02`,
  sourceSnapshotId1: `${NS}snap_01`,
  sourceSnapshotId2: `${NS}snap_02`,
  sourceSnapshotId3: `${NS}snap_03`,
  marketplaceListingId: `${NS}listing_01`,
  remoteListingId: `${NS}remote_01`,
  sellerAccountKey: `${NS}seller_main`,
  marketplace: "shopee",
  source: "jakmall",
};

async function cleanupTestNamespace(client: PrismaClient): Promise<void> {
  // Delete in FK-safe reverse order
  await client.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { startsWith: NS } },
        { actorId: { startsWith: NS } },
      ],
    },
  });

  await client.syncEvent.deleteMany({
    where: {
      OR: [
        { productSourceId: { startsWith: NS } },
        { marketplaceListingId: { startsWith: NS } },
        { sourceSnapshotId: { startsWith: NS } },
      ],
    },
  });

  await client.idempotencyRecord.deleteMany({
    where: {
      OR: [
        { key: { contains: NS } },
        { productSourceId: { startsWith: NS } },
        { sellerAccountKey: { startsWith: NS } },
      ],
    },
  });

  await client.syncJob.deleteMany({
    where: {
      OR: [
        { productSourceId: { startsWith: NS } },
        { marketplaceListingId: { startsWith: NS } },
        { sourceSnapshotId: { startsWith: NS } },
      ],
    },
  });

  await client.marketplaceListingVariant.deleteMany({
    where: {
      listingId: { startsWith: NS },
    },
  });

  await client.marketplaceListing.deleteMany({
    where: {
      OR: [
        { id: { startsWith: NS } },
        { productId: { startsWith: NS } },
        { sellerAccountKey: { startsWith: NS } },
      ],
    },
  });

  await client.sourceSnapshot.deleteMany({
    where: {
      productSourceId: { startsWith: NS },
    },
  });

  await client.sourceVariant.deleteMany({
    where: {
      productSourceId: { startsWith: NS },
    },
  });

  await client.productSource.deleteMany({
    where: {
      OR: [
        { id: { startsWith: NS } },
        { productId: { startsWith: NS } },
      ],
    },
  });

  await client.product.deleteMany({
    where: {
      id: { startsWith: NS },
    },
  });
}

let prisma: PrismaClient;
let repo: SyncRuntimeRepository;

before(async () => {
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  await cleanupTestNamespace(prisma);
  repo = new SyncRuntimeRepository(prisma);
});

after(async () => {
  if (prisma) {
    await cleanupTestNamespace(prisma);
    await prisma.$disconnect();
  }
});

// ----------------------------------------------------------------------
// DB-01 — CONNECTIVITY
// ----------------------------------------------------------------------
test("DB-01: Prisma connects to real PostgreSQL and executes raw queries", async () => {
  const result = await prisma.$queryRaw<Array<{ num: number }>>`SELECT 1 as num`;
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.num, 1);
});

// ----------------------------------------------------------------------
// DB-02 — PERSISTENCE GRAPH
// ----------------------------------------------------------------------
test("DB-02: Persist and read complete relational fixture graph", async () => {
  // 1. Product
  const product = await prisma.product.create({
    data: {
      id: fixtures.productId,
    },
  });
  assert.equal(product.id, fixtures.productId);

  // 2. ProductSource
  const productSource = await prisma.productSource.create({
    data: {
      id: fixtures.productSourceId,
      productId: fixtures.productId,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceUrl: "https://www.jakmall.com/p/test-01",
    },
  });
  assert.equal(productSource.id, fixtures.productSourceId);

  // 3. SourceVariants
  await prisma.sourceVariant.createMany({
    data: [
      {
        id: `${NS}sv_01`,
        productSourceId: fixtures.productSourceId,
        sourceSkuId: fixtures.sourceSkuId1,
        attributes: { color: "Black" },
      },
      {
        id: `${NS}sv_02`,
        productSourceId: fixtures.productSourceId,
        sourceSkuId: fixtures.sourceSkuId2,
        attributes: { color: "White" },
      },
    ],
  });

  // 4. SourceSnapshots
  const canonicalPayload1 = {
    variants: [
      { sourceSkuId: fixtures.sourceSkuId1 },
      { sourceSkuId: fixtures.sourceSkuId2 },
    ],
  };

  await prisma.sourceSnapshot.create({
    data: {
      id: fixtures.sourceSnapshotId1,
      productSourceId: fixtures.productSourceId,
      sourceHash: "shash_01",
      contentHash: "chash_01",
      priceHash: "phash_01",
      inventoryHash: "ihash_01",
      variantHash: "vhash_01",
      canonicalPayload: canonicalPayload1 as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });

  await prisma.sourceSnapshot.create({
    data: {
      id: fixtures.sourceSnapshotId2,
      productSourceId: fixtures.productSourceId,
      sourceHash: "shash_02",
      contentHash: "chash_02",
      priceHash: "phash_02",
      inventoryHash: "ihash_02",
      variantHash: "vhash_02",
      canonicalPayload: canonicalPayload1 as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });

  await prisma.sourceSnapshot.create({
    data: {
      id: fixtures.sourceSnapshotId3,
      productSourceId: fixtures.productSourceId,
      sourceHash: "shash_03",
      contentHash: "chash_03",
      priceHash: "phash_03",
      inventoryHash: "ihash_03",
      variantHash: "vhash_03",
      canonicalPayload: canonicalPayload1 as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });

  // 5. MarketplaceListing
  const listing = await prisma.marketplaceListing.create({
    data: {
      id: fixtures.marketplaceListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
    },
  });
  assert.equal(listing.id, fixtures.marketplaceListingId);

  // 6. MarketplaceListingVariants
  await prisma.marketplaceListingVariant.createMany({
    data: [
      {
        id: `${NS}mlv_01`,
        listingId: fixtures.marketplaceListingId,
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: `${NS}dest_01`,
        remoteVariantId: `${NS}rvar_01`,
        lastKnownDestinationPrice: 100000,
        lastKnownDestinationStock: 10,
      },
      {
        id: `${NS}mlv_02`,
        listingId: fixtures.marketplaceListingId,
        sourceSkuId: fixtures.sourceSkuId2,
        destinationSku: `${NS}dest_02`,
        remoteVariantId: `${NS}rvar_02`,
        lastKnownDestinationPrice: 150000,
        lastKnownDestinationStock: 10,
      },
    ],
  });

  // Read back and verify relationships
  const loadedProductSource = await prisma.productSource.findUnique({
    where: { id: fixtures.productSourceId },
    include: {
      product: true,
      variants: true,
      snapshots: true,
    },
  });
  assert.ok(loadedProductSource);
  assert.equal(loadedProductSource.product.id, fixtures.productId);
  assert.equal(loadedProductSource.variants.length, 2);
  assert.equal(loadedProductSource.snapshots.length, 3);

  const loadedListing = await prisma.marketplaceListing.findUnique({
    where: { id: fixtures.marketplaceListingId },
    include: {
      product: true,
      variants: true,
    },
  });
  assert.ok(loadedListing);
  assert.equal(loadedListing.product.id, fixtures.productId);
  assert.equal(loadedListing.variants.length, 2);
});

// ----------------------------------------------------------------------
// DB-03 — REAL reserveSyncJob CREATE
// ----------------------------------------------------------------------
test("DB-03: Real reserveSyncJob() creates durable SyncJob, IdempotencyRecord, and SyncEvent", async () => {
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    baseOperationKey: generateSyncBaseOperationKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_PRICE",
    }),
    idempotencyKey: generateSyncOperationIdempotencyKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_PRICE",
      sourceSnapshotId: fixtures.sourceSnapshotId1,
    }),
    eligibility: "ELIGIBLE",
    reason: "Price changed",
  };

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId: fixtures.remoteListingId,
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        targetPriceIdr: 125000,
      },
    ],
  };

  const outcome = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: fixtures.productSourceId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplaceListingId: fixtures.marketplaceListingId,
  });

  assert.equal(outcome.status, "CREATED");
  if (outcome.status !== "CREATED") throw new Error("Expected CREATED");

  assert.ok(outcome.syncJob);
  assert.equal(outcome.syncJob.operationType, "UPDATE_PRICE");
  assert.equal(outcome.syncJob.jobType, "PRICE_UPDATE");
  assert.equal(outcome.syncJob.payloadVersion, 1);
  assert.equal(outcome.syncJob.status, "PENDING");
  assert.equal(outcome.syncJob.idempotencyKey, op.idempotencyKey);
  assert.equal(outcome.syncJob.sourceSnapshotId, fixtures.sourceSnapshotId1);
  assert.equal(outcome.syncJob.productSourceId, fixtures.productSourceId);
  assert.equal(outcome.syncJob.marketplaceListingId, fixtures.marketplaceListingId);

  // Directly verify database records
  const dbJob = await prisma.syncJob.findUnique({ where: { id: outcome.syncJob.id } });
  assert.ok(dbJob);
  assert.equal(dbJob.operationType, "UPDATE_PRICE");

  const dbIdemp = await prisma.idempotencyRecord.findUnique({ where: { key: op.idempotencyKey } });
  assert.ok(dbIdemp);
  assert.equal(dbIdemp.syncJobId, outcome.syncJob.id);
  assert.equal(dbIdemp.status, "STARTED");

  const dbEvents = await prisma.syncEvent.findMany({ where: { syncJobId: outcome.syncJob.id } });
  assert.equal(dbEvents.length, 1);
  assert.equal(dbEvents[0]?.eventType, "SYNC_PLANNED");
});

// ----------------------------------------------------------------------
// DB-04 — RECONNECT DURABILITY
// ----------------------------------------------------------------------
test("DB-04: Persisted executionPayload survives client disconnect and reconnect", async () => {
  // Disconnect current client
  await prisma.$disconnect();

  // Create and connect a brand new client instance
  const freshClient = new PrismaClient({ datasourceUrl: databaseUrl });
  await freshClient.$connect();

  const idempKey = generateSyncOperationIdempotencyKey({
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: fixtures.sourceSnapshotId1,
  });

  const job = await freshClient.syncJob.findFirst({
    where: { idempotencyKey: idempKey },
  });
  assert.ok(job);

  const validatedPayload = validateDurableExecutionPayload(job.executionPayload);
  assert.equal(validatedPayload.operationType, "UPDATE_PRICE");
  assert.equal(validatedPayload.marketplace, fixtures.marketplace);
  assert.equal(validatedPayload.sellerAccountKey, fixtures.sellerAccountKey);
  assert.equal(validatedPayload.sourceProductId, fixtures.sourceProductId);
  assert.equal((validatedPayload as UpdatePriceExecutionPayload).variants[0]?.targetPriceIdr, 125000);

  // Restore primary client
  prisma = freshClient;
  repo = new SyncRuntimeRepository(prisma);
});

// ----------------------------------------------------------------------
// DB-05 — SEQUENTIAL IDEMPOTENCY
// ----------------------------------------------------------------------
test("DB-05: Sequential duplicate reservation returns EXISTING_RESERVATION without duplicate records", async () => {
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_STOCK",
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    baseOperationKey: generateSyncBaseOperationKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_STOCK",
    }),
    idempotencyKey: generateSyncOperationIdempotencyKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_STOCK",
      sourceSnapshotId: fixtures.sourceSnapshotId1,
    }),
    eligibility: "ELIGIBLE",
    reason: "Stock updated",
  };

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId: fixtures.remoteListingId,
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        inventory: { resolution: "RESOLVED", targetQuantity: 15 },
      },
    ],
  };

  const first = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: fixtures.productSourceId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplaceListingId: fixtures.marketplaceListingId,
  });
  assert.equal(first.status, "CREATED");

  const second = await repo.reserveSyncJob({
    operation: op,
    payload,
    productSourceId: fixtures.productSourceId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplaceListingId: fixtures.marketplaceListingId,
  });
  assert.equal(second.status, "EXISTING_RESERVATION");

  assert.ok(first.syncJob);
  assert.ok(second.syncJob);
  assert.equal(first.syncJob.id, second.syncJob.id);

  // Verify exact database counts for this key
  const idempCount = await prisma.idempotencyRecord.count({ where: { key: op.idempotencyKey } });
  assert.equal(idempCount, 1);

  const jobCount = await prisma.syncJob.count({ where: { idempotencyKey: op.idempotencyKey } });
  assert.equal(jobCount, 1);

  const eventCount = await prisma.syncEvent.count({ where: { syncJobId: first.syncJob.id } });
  assert.equal(eventCount, 1);
});

// ----------------------------------------------------------------------
// DB-06 — REAL CONCURRENT RESERVATION RACE & P2002 RECOVERY
// ----------------------------------------------------------------------
test("DB-06: Concurrent reservation race results in exactly one SyncJob and proves real P2002 collision recovery", async () => {
  let observedCollisionEvent: Prisma.LogEvent | null = null;
  let collisionAttempt = 0;
  let collisionIdempotencyKey = "";
  let lastOutcomeA: Awaited<ReturnType<typeof repo.reserveSyncJob>> | null = null;
  let lastOutcomeB: Awaited<ReturnType<typeof repo.reserveSyncJob>> | null = null;

  // Run a bounded set of deterministic concurrent attempts (up to 10)
  for (let attempt = 1; attempt <= 10; attempt++) {
    const raceSnapshotId = `${NS}snap_race_${attempt}`;

    // Ensure dedicated snapshot exists for this race attempt
    await prisma.sourceSnapshot.upsert({
      where: { id: raceSnapshotId },
      create: {
        id: raceSnapshotId,
        productSourceId: fixtures.productSourceId,
        sourceHash: `shash_race_${attempt}`,
        contentHash: `chash_race_${attempt}`,
        priceHash: `phash_race_${attempt}`,
        inventoryHash: `ihash_race_${attempt}`,
        variantHash: `vhash_race_${attempt}`,
        canonicalPayload: {
          variants: [
            { sourceSkuId: fixtures.sourceSkuId1 },
            { sourceSkuId: fixtures.sourceSkuId2 },
          ],
        } as unknown as Prisma.InputJsonValue,
        sourceFetchedAt: new Date(),
      },
      update: {},
    });

    const clientA = new PrismaClient({
      datasourceUrl: databaseUrl,
      log: [{ emit: "event", level: "error" }],
    });
    const clientB = new PrismaClient({
      datasourceUrl: databaseUrl,
      log: [{ emit: "event", level: "error" }],
    });

    const capturedErrors: Prisma.LogEvent[] = [];
    clientA.$on("error", (e: Prisma.LogEvent) => capturedErrors.push(e));
    clientB.$on("error", (e: Prisma.LogEvent) => capturedErrors.push(e));

    await Promise.all([clientA.$connect(), clientB.$connect()]);

    const repoA = new SyncRuntimeRepository(clientA);
    const repoB = new SyncRuntimeRepository(clientB);

    const op: SyncPlannedOperation = {
      operationType: "UPDATE_PRICE",
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      baseOperationKey: generateSyncBaseOperationKey({
        marketplace: fixtures.marketplace,
        sellerAccountKey: fixtures.sellerAccountKey,
        source: fixtures.source,
        sourceProductId: fixtures.sourceProductId,
        operationType: "UPDATE_PRICE",
      }),
      idempotencyKey: generateSyncOperationIdempotencyKey({
        marketplace: fixtures.marketplace,
        sellerAccountKey: fixtures.sellerAccountKey,
        source: fixtures.source,
        sourceProductId: fixtures.sourceProductId,
        operationType: "UPDATE_PRICE",
        sourceSnapshotId: raceSnapshotId,
      }),
      eligibility: "ELIGIBLE",
      reason: `Race attempt ${attempt}`,
    };

    const payload: UpdatePriceExecutionPayload = {
      schemaVersion: 1,
      operationType: "UPDATE_PRICE",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: raceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          targetPriceIdr: 130000 + attempt * 1000,
        },
      ],
    };

    const params = {
      operation: op,
      payload,
      productSourceId: fixtures.productSourceId,
      sourceSnapshotId: raceSnapshotId,
      marketplaceListingId: fixtures.marketplaceListingId,
    };

    // Launch two independent repository operations simultaneously
    const results = await Promise.allSettled([
      repoA.reserveSyncJob(params),
      repoB.reserveSyncJob(params),
    ]);

    await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);

    assert.equal(results[0]?.status, "fulfilled", "Caller A should fulfill");
    assert.equal(results[1]?.status, "fulfilled", "Caller B should fulfill");

    const outcomeA = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof repoA.reserveSyncJob>>>).value;
    const outcomeB = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof repoB.reserveSyncJob>>>).value;
    lastOutcomeA = outcomeA;
    lastOutcomeB = outcomeB;

    const statuses = [outcomeA.status, outcomeB.status].sort();
    assert.deepEqual(statuses, ["CREATED", "EXISTING_RESERVATION"]);

    assert.ok(outcomeA.syncJob);
    assert.ok(outcomeB.syncJob);
    assert.equal(outcomeA.syncJob.id, outcomeB.syncJob.id);

    // Verify PostgreSQL database state: exactly 1 IdempotencyRecord, 1 SyncJob, 1 SyncEvent
    const idempCount = await prisma.idempotencyRecord.count({ where: { key: op.idempotencyKey } });
    assert.equal(idempCount, 1);

    const jobCount = await prisma.syncJob.count({ where: { idempotencyKey: op.idempotencyKey } });
    assert.equal(jobCount, 1);

    const eventCount = await prisma.syncEvent.count({ where: { syncJobId: outcomeA.syncJob.id } });
    assert.equal(eventCount, 1);

    // Check if real P2002 error collision was captured during this attempt
    const p2002Event = capturedErrors.find((e) =>
      e.message.includes("Unique constraint failed") || e.message.includes("key")
    );
    if (p2002Event) {
      observedCollisionEvent = p2002Event;
      collisionAttempt = attempt;
      collisionIdempotencyKey = op.idempotencyKey;
      break;
    }
  }

  assert.ok(lastOutcomeA);
  assert.ok(lastOutcomeB);
  assert.ok(
    observedCollisionEvent,
    "Expected at least one concurrent race attempt to observe and log a real PostgreSQL P2002 unique constraint collision"
  );
  assert.ok(collisionAttempt >= 1);
  assert.ok(collisionIdempotencyKey.length > 0);
  assert.ok(observedCollisionEvent.message.includes("Unique constraint failed"));
});

// ----------------------------------------------------------------------
// DB-07 — OBSERVE REAL P2002 METADATA
// ----------------------------------------------------------------------
test("DB-07: Observe actual PostgreSQL/Prisma P2002 metadata and verify isIdempotencyKeyUniqueConflict", async () => {
  const uniqueKey = `${NS}direct_p2002_key`;

  // First insert succeeds
  await prisma.idempotencyRecord.create({
    data: {
      key: uniqueKey,
      operationType: "UPDATE_PRICE",
      status: "STARTED",
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      productSourceId: fixtures.productSourceId,
    },
  });

  let observedError: unknown = null;
  try {
    // Second insert with identical key must fail with P2002
    await prisma.idempotencyRecord.create({
      data: {
        key: uniqueKey,
        operationType: "UPDATE_PRICE",
        status: "STARTED",
        marketplace: fixtures.marketplace,
        sellerAccountKey: fixtures.sellerAccountKey,
        productSourceId: fixtures.productSourceId,
      },
    });
    assert.fail("Expected second insert to fail with P2002");
  } catch (err) {
    observedError = err;
  }

  assert.ok(observedError);
  const prismaErr = observedError as { code?: string; meta?: { target?: unknown } };
  assert.equal(prismaErr.code, "P2002");
  assert.ok(prismaErr.meta);
  assert.ok(prismaErr.meta.target);

  // Verify the helper correctly recognizes the actual observed P2002 error
  const isConflict = isIdempotencyKeyUniqueConflict(observedError);
  assert.equal(isConflict, true, "isIdempotencyKeyUniqueConflict must recognize the real Prisma P2002 error");
});

// ----------------------------------------------------------------------
// DB-08 — REAL TRANSACTION ROLLBACK AFTER WRITE
// ----------------------------------------------------------------------
test("DB-08: PostgreSQL transaction rollback proof - subsequent failure rolls back earlier successful insert", async () => {
  const rollbackKey = `${NS}tx_rollback_key`;
  let observedError: unknown = null;

  try {
    await prisma.$transaction(async (tx) => {
      // Step 1: Successful write inside transaction
      await tx.idempotencyRecord.create({
        data: {
          key: rollbackKey,
          operationType: "UPDATE_PRICE",
          status: "STARTED",
          marketplace: fixtures.marketplace,
          sellerAccountKey: fixtures.sellerAccountKey,
          productSourceId: fixtures.productSourceId,
        },
      });

      // Step 2: Intentional FK constraint violation inside same transaction
      await tx.sourceSnapshot.create({
        data: {
          id: `${NS}rollback_bad_snap`,
          productSourceId: `${NS}nonexistent_ps_fk`,
          sourceHash: "bad",
          contentHash: "bad",
          priceHash: "bad",
          inventoryHash: "bad",
          variantHash: "bad",
          canonicalPayload: {} as unknown as Prisma.InputJsonValue,
          sourceFetchedAt: new Date(),
        },
      });
    });
    assert.fail("Expected transaction to reject due to FK violation");
  } catch (err) {
    observedError = err;
  }

  assert.ok(observedError);
  const prismaErr = observedError as { code?: string };
  assert.equal(prismaErr.code, "P2003", "Expected FK violation error code P2003");

  // Step 3: Verify the first insert was completely rolled back by PostgreSQL
  const idempRecord = await prisma.idempotencyRecord.findUnique({ where: { key: rollbackKey } });
  assert.equal(idempRecord, null, "First insert must not exist in database after transaction rollback");

  const idempCount = await prisma.idempotencyRecord.count({ where: { key: rollbackKey } });
  assert.equal(idempCount, 0, "idempotency_records count for rollbackKey must be 0");
});

// ----------------------------------------------------------------------
// DB-09 — REAL replaceReviewPayload TRANSACTION
// ----------------------------------------------------------------------
test("DB-09: replaceReviewPayload() transactionally updates payload, increments version, and appends AuditLog", async () => {
  const op: SyncPlannedOperation = {
    operationType: "CREATE_LISTING",
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    baseOperationKey: generateSyncBaseOperationKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "CREATE_LISTING",
    }),
    idempotencyKey: generateSyncOperationIdempotencyKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "CREATE_LISTING",
    }),
    eligibility: "REQUIRES_REVIEW",
    reason: "New product review",
  };

  const initialPayload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Initial Draft Title",
    preparedDescription: "Initial Description",
    images: [{ url: "https://img.jakmall.com/test.jpg" }],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: `${NS}dest_01`,
        attributes: { color: "Black" },
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
      {
        sourceSkuId: fixtures.sourceSkuId2,
        destinationSku: `${NS}dest_02`,
        attributes: { color: "White" },
        targetPriceIdr: 110000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: initialPayload,
    productSourceId: fixtures.productSourceId,
    sourceSnapshotId: fixtures.sourceSnapshotId1,
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const replacementPayload: CreateListingExecutionPayload = {
    ...initialPayload,
    preparedTitle: "Approved Reviewed Title",
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: `${NS}dest_01`,
        attributes: { color: "Black" },
        targetPriceIdr: 150000,
        inventory: { resolution: "RESOLVED", targetQuantity: 8 },
      },
      {
        sourceSkuId: fixtures.sourceSkuId2,
        destinationSku: `${NS}dest_02`,
        attributes: { color: "White" },
        targetPriceIdr: 160000,
        inventory: { resolution: "RESOLVED", targetQuantity: 8 },
      },
    ],
  };

  const replaced = await repo.replaceReviewPayload({
    syncJobId: created.syncJob.id,
    newPayload: replacementPayload,
    reviewedBy: `${NS}operator_alice`,
    notes: "Human review price adjustments",
  });

  assert.equal(replaced.syncJob.payloadVersion, 2);

  // Directly verify database state
  const updatedJob = await prisma.syncJob.findUnique({ where: { id: created.syncJob.id } });
  assert.ok(updatedJob);
  assert.equal(updatedJob.payloadVersion, 2);

  const payloadInDb = updatedJob.executionPayload as unknown as CreateListingExecutionPayload;
  assert.equal(payloadInDb.preparedTitle, "Approved Reviewed Title");
  assert.equal(payloadInDb.variants[0]?.targetPriceIdr, 150000);

  const auditLogs = await prisma.auditLog.findMany({
    where: { entityId: created.syncJob.id, action: "REPLACE_REVIEW_PAYLOAD" },
  });
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0]?.actorId, `${NS}operator_alice`);
});

// ----------------------------------------------------------------------
// DB-10 — REAL resolveReviewExecutionTarget
// ----------------------------------------------------------------------
test("DB-10: resolveReviewExecutionTarget() atomically links listing, injects remoteListingId, increments version, and creates AuditLog", async () => {
  const op: SyncPlannedOperation = {
    operationType: "UPDATE_PRICE",
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    baseOperationKey: generateSyncBaseOperationKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_PRICE",
    }),
    idempotencyKey: generateSyncOperationIdempotencyKey({
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      operationType: "UPDATE_PRICE",
      sourceSnapshotId: fixtures.sourceSnapshotId3,
    }),
    eligibility: "BLOCKED",
    reason: "Unresolved listing",
  };

  const initialPayload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId3,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    // remoteListingId is undefined in BLOCKED state
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        targetPriceIdr: 100000,
      },
    ],
  };

  const created = await repo.reserveSyncJob({
    operation: op,
    payload: initialPayload,
    productSourceId: fixtures.productSourceId,
    sourceSnapshotId: fixtures.sourceSnapshotId3,
  });
  if (created.status !== "CREATED") throw new Error("Expected CREATED");

  const resolved = await repo.resolveReviewExecutionTarget({
    syncJobId: created.syncJob.id,
    marketplaceListingId: fixtures.marketplaceListingId,
    reviewedBy: `${NS}operator_bob`,
    notes: "Linked to published listing",
  });

  assert.equal(resolved.syncJob.payloadVersion, 2);
  assert.equal(resolved.syncJob.marketplaceListingId, fixtures.marketplaceListingId);

  // Directly verify database state
  const updatedJob = await prisma.syncJob.findUnique({ where: { id: created.syncJob.id } });
  assert.ok(updatedJob);
  assert.equal(updatedJob.marketplaceListingId, fixtures.marketplaceListingId);
  assert.equal(updatedJob.payloadVersion, 2);

  const payloadInDb = updatedJob.executionPayload as unknown as UpdatePriceExecutionPayload;
  assert.equal(payloadInDb.remoteListingId, fixtures.remoteListingId);

  const auditLogs = await prisma.auditLog.findMany({
    where: { entityId: created.syncJob.id, action: "RESOLVE_REVIEW_EXECUTION_TARGET" },
  });
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0]?.actorId, `${NS}operator_bob`);
});

// ----------------------------------------------------------------------
// DB-11 — FK CONSTRAINT PROOF
// ----------------------------------------------------------------------
test("DB-11: PostgreSQL foreign key constraint rejects invalid relational row insert", async () => {
  let observedError: unknown = null;
  try {
    await prisma.sourceSnapshot.create({
      data: {
        id: `${NS}invalid_fk_snapshot`,
        productSourceId: `${NS}nonexistent_ps_id`,
        sourceHash: "shash_bad",
        contentHash: "chash_bad",
        priceHash: "phash_bad",
        inventoryHash: "ihash_bad",
        variantHash: "vhash_bad",
        canonicalPayload: { variants: [] } as unknown as Prisma.InputJsonValue,
        sourceFetchedAt: new Date(),
      },
    });
    assert.fail("Expected FK violation");
  } catch (err) {
    observedError = err;
  }

  assert.ok(observedError);
  const prismaErr = observedError as { code?: string };
  assert.equal(prismaErr.code, "P2003", "Prisma FK constraint violation code must be P2003");

  const count = await prisma.sourceSnapshot.count({ where: { id: `${NS}invalid_fk_snapshot` } });
  assert.equal(count, 0);
});

// ----------------------------------------------------------------------
// DB-12 — CLEANUP VERIFICATION
// ----------------------------------------------------------------------
test("DB-12: Test cleanup removes all test namespace records", async () => {
  // Verify that test namespace AuditLogs exist prior to cleanup
  const preCleanupAuditLogs = await prisma.auditLog.count({
    where: {
      OR: [
        { entityId: { startsWith: NS } },
        { actorId: { startsWith: NS } },
      ],
    },
  });
  assert.ok(preCleanupAuditLogs > 0, "Expected at least 1 AuditLog before final cleanup");

  await cleanupTestNamespace(prisma);

  const [
    productCount,
    productSourceCount,
    sourceVariantCount,
    sourceSnapshotCount,
    listingCount,
    listingVariantCount,
    syncJobCount,
    syncEventCount,
    idempCount,
    auditLogCount,
  ] = await Promise.all([
    prisma.product.count({ where: { id: { startsWith: NS } } }),
    prisma.productSource.count({ where: { id: { startsWith: NS } } }),
    prisma.sourceVariant.count({ where: { productSourceId: { startsWith: NS } } }),
    prisma.sourceSnapshot.count({ where: { productSourceId: { startsWith: NS } } }),
    prisma.marketplaceListing.count({ where: { id: { startsWith: NS } } }),
    prisma.marketplaceListingVariant.count({ where: { listingId: { startsWith: NS } } }),
    prisma.syncJob.count({ where: { productSourceId: { startsWith: NS } } }),
    prisma.syncEvent.count({ where: { productSourceId: { startsWith: NS } } }),
    prisma.idempotencyRecord.count({ where: { key: { contains: NS } } }),
    prisma.auditLog.count({
      where: {
        OR: [
          { entityId: { startsWith: NS } },
          { actorId: { startsWith: NS } },
        ],
      },
    }),
  ]);

  assert.equal(productCount, 0, "productCount should be 0");
  assert.equal(productSourceCount, 0, "productSourceCount should be 0");
  assert.equal(sourceVariantCount, 0, "sourceVariantCount should be 0");
  assert.equal(sourceSnapshotCount, 0, "sourceSnapshotCount should be 0");
  assert.equal(listingCount, 0, "listingCount should be 0");
  assert.equal(listingVariantCount, 0, "listingVariantCount should be 0");
  assert.equal(syncJobCount, 0, "syncJobCount should be 0");
  assert.equal(syncEventCount, 0, "syncEventCount should be 0");
  assert.equal(idempCount, 0, "idempCount should be 0");
  assert.equal(auditLogCount, 0, "auditLogCount should be 0");
});
