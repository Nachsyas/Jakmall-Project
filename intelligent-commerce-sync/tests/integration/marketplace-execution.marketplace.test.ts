import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PrismaClient, type Prisma, type SyncJob } from "@prisma/client";
import { QueueEvents } from "bullmq";
import { SyncExecutionQueue } from "../../src/queue/sync-queue.js";
import { SyncExecutionWorker } from "../../src/queue/sync-worker.js";
import { parseRedisConnectionOptions, createRedisConnection } from "../../src/queue/connection.js";
import { MarketplaceSyncJobExecutor } from "../../src/execution/marketplace/marketplace-sync-job-executor.js";
import {
  MarketplaceGatewayRegistry,
  type MarketplaceExecutionGateway,
} from "../../src/execution/marketplace/gateway.js";
import {
  type CreateListingCommand,
  type CreateListingMutationResult,
  type MarketplaceMutationResult,
  type NormalizedRemoteListingState,
  type UpdatePriceCommand,
  type UpdateStockCommand,
  extractResolvedTargetQuantity,
  MarketplaceTargetIntegrityError,
  MarketplaceExecutionError,
  MarketplaceVerifyMismatchError,
} from "../../src/execution/marketplace/types.js";
import type {
  CreateListingExecutionPayload,
  UpdatePriceExecutionPayload,
  UpdateStockExecutionPayload,
} from "../../src/execution/types.js";

const databaseUrl =
  process.env["DATABASE_URL"] ||
  "postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public";
const redisUrl = process.env["REDIS_URL"] || "redis://localhost:6379";

const NS = "phase4c3_me_";

const fixtures = {
  productId: `${NS}prod_main`,
  productSourceId: `${NS}ps_main`,
  sourceSnapshotId: `${NS}snap_main`,
  marketplaceListingId: `${NS}list_main`,
  remoteListingId: `${NS}remote_main_99`,
  source: "jakmall",
  sourceProductId: `${NS}sp_main_01`,
  marketplace: "shopee",
  sellerAccountKey: `${NS}seller_main`,
  sourceSkuId1: `${NS}sku_01`,
  sourceSkuId2: `${NS}sku_02`,
  destSku1: `${NS}dsku_01`,
  destSku2: `${NS}dsku_02`,
};

let globalGatewayListingSeq = 0;

// --------------------------------------------------------------------------
// TEST-ONLY DETERMINISTIC SIMULATED MARKETPLACE GATEWAY
// --------------------------------------------------------------------------
class TestSimulatedMarketplaceGateway implements MarketplaceExecutionGateway {
  readonly marketplaceName: string;
  readonly createdListings = new Map<string, NormalizedRemoteListingState>();
  readonly idempotencyMap = new Map<string, string>(); // idempotencyKey -> remoteListingId

  createCalls: CreateListingCommand[] = [];
  updatePriceCalls: UpdatePriceCommand[] = [];
  updateStockCalls: UpdateStockCommand[] = [];
  readListingCalls: string[] = [];

  logicalCreateCount = 0;
  readOverride?: ((remoteListingId: string) => NormalizedRemoteListingState | null) | undefined;
  createOverride?: ((command: CreateListingCommand) => Promise<CreateListingMutationResult>) | undefined;
  throwOnMutation?: Error | undefined;
  returnUnsuccessfulMutation = false;

  constructor(marketplaceName = "shopee") {
    this.marketplaceName = marketplaceName;
  }

  async createListing(command: CreateListingCommand): Promise<CreateListingMutationResult> {
    this.createCalls.push(command);

    if (this.throwOnMutation) {
      throw this.throwOnMutation;
    }

    if (this.createOverride) {
      return this.createOverride(command);
    }

    const idempKey = `${command.marketplace}:${command.sellerAccountKey}:${command.idempotencyKey}`;
    const existingRemoteId = this.idempotencyMap.get(idempKey);

    if (existingRemoteId) {
      return {
        remoteListingId: existingRemoteId,
        variantMappings: command.variants.map((v, i) => ({
          sourceSkuId: v.sourceSkuId,
          remoteVariantId: `${existingRemoteId}_var_${i + 1}`,
        })),
      };
    }

    this.logicalCreateCount++;
    globalGatewayListingSeq++;
    // Deterministic unique ID without Date.now()
    const remoteListingId = `${NS}rem_${globalGatewayListingSeq}`;
    this.idempotencyMap.set(idempKey, remoteListingId);

    const remoteListingState: NormalizedRemoteListingState = {
      remoteListingId,
      title: command.preparedTitle,
      variants: command.variants.map((v, i) => ({
        destinationSku: v.destinationSku,
        remoteVariantId: `${remoteListingId}_var_${i + 1}`,
        priceIdr: v.targetPriceIdr,
        stock: v.targetQuantity,
      })),
    };

    this.createdListings.set(remoteListingId, remoteListingState);

    return {
      remoteListingId,
      variantMappings: command.variants.map((v, i) => ({
        sourceSkuId: v.sourceSkuId,
        remoteVariantId: `${remoteListingId}_var_${i + 1}`,
      })),
    };
  }

  async updatePrice(command: UpdatePriceCommand): Promise<MarketplaceMutationResult> {
    this.updatePriceCalls.push(command);

    if (this.throwOnMutation) {
      throw this.throwOnMutation;
    }

    if (this.returnUnsuccessfulMutation) {
      return { success: false };
    }

    const state = this.createdListings.get(command.remoteListingId);
    if (state) {
      for (const variant of command.variants) {
        const target = state.variants.find((v) => v.destinationSku === variant.destinationSku);
        if (target) {
          target.priceIdr = variant.targetPriceIdr;
        }
      }
    }

    return { success: true };
  }

  async updateStock(command: UpdateStockCommand): Promise<MarketplaceMutationResult> {
    this.updateStockCalls.push(command);

    if (this.throwOnMutation) {
      throw this.throwOnMutation;
    }

    if (this.returnUnsuccessfulMutation) {
      return { success: false };
    }

    const state = this.createdListings.get(command.remoteListingId);
    if (state) {
      for (const variant of command.variants) {
        const target = state.variants.find((v) => v.destinationSku === variant.destinationSku);
        if (target) {
          target.stock = variant.targetQuantity;
        }
      }
    }

    return { success: true };
  }

  async readListingState(remoteListingId: string): Promise<NormalizedRemoteListingState | null> {
    this.readListingCalls.push(remoteListingId);

    if (this.readOverride) {
      return this.readOverride(remoteListingId);
    }

    const state = this.createdListings.get(remoteListingId);
    if (!state) {
      return null;
    }

    // Return deep clone of remote state
    return {
      remoteListingId: state.remoteListingId,
      title: state.title,
      variants: state.variants.map((v) => ({ ...v })),
    };
  }
}

// --------------------------------------------------------------------------
// TEST INFRASTRUCTURE & LIFECYCLE HOOKS
// --------------------------------------------------------------------------
function createIsolatedQueue(testSuffix: string): { queueName: string; queue: SyncExecutionQueue } {
  const queueName = `${NS}q_${testSuffix}_${Date.now()}`;
  const connection = parseRedisConnectionOptions(redisUrl);
  const queue = new SyncExecutionQueue(prisma, {
    queueName,
    connection,
  });
  return { queueName, queue };
}

function createIsolatedEvents(queueName: string): QueueEvents {
  const connection = parseRedisConnectionOptions(redisUrl);
  return new QueueEvents(queueName, { connection });
}

function createIsolatedWorker(
  queueName: string,
  executor: MarketplaceSyncJobExecutor
): SyncExecutionWorker {
  return new SyncExecutionWorker(prisma, executor, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
    concurrency: 1,
    autorun: true,
  });
}

async function cleanupPostgresNamespace(client: PrismaClient): Promise<void> {
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
      OR: [
        { listingId: { startsWith: NS } },
        { sourceSkuId: { startsWith: NS } },
      ],
    },
  });

  await client.marketplaceListing.deleteMany({
    where: {
      OR: [
        { id: { startsWith: NS } },
        { productId: { startsWith: NS } },
        { sellerAccountKey: { startsWith: NS } },
        { remoteListingId: { startsWith: NS } },
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

async function seedBaseFixtures(client: PrismaClient): Promise<void> {
  await client.product.create({
    data: { id: fixtures.productId },
  });

  await client.productSource.create({
    data: {
      id: fixtures.productSourceId,
      productId: fixtures.productId,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceUrl: "https://www.jakmall.com/p/test-marketplace-exec",
    },
  });

  await client.sourceVariant.createMany({
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

  await client.sourceSnapshot.create({
    data: {
      id: fixtures.sourceSnapshotId,
      productSourceId: fixtures.productSourceId,
      sourceHash: "shash_01",
      contentHash: "chash_01",
      priceHash: "phash_01",
      inventoryHash: "ihash_01",
      variantHash: "vhash_01",
      canonicalPayload: {
        variants: [
          { sourceSkuId: fixtures.sourceSkuId1 },
          { sourceSkuId: fixtures.sourceSkuId2 },
        ],
      } as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });
}

let prisma: PrismaClient;

before(async () => {
  globalGatewayListingSeq = 0;
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  await cleanupPostgresNamespace(prisma);
  await seedBaseFixtures(prisma);
});

after(async () => {
  if (prisma) {
    await cleanupPostgresNamespace(prisma);
    await prisma.$disconnect();
  }
});

// Helper to create test SyncJobs
async function createSyncJobFixture(
  client: PrismaClient,
  testId: string,
  operationType: "CREATE_LISTING" | "UPDATE_PRICE" | "UPDATE_STOCK",
  payload: CreateListingExecutionPayload | UpdatePriceExecutionPayload | UpdateStockExecutionPayload,
  marketplaceListingId?: string
): Promise<SyncJob> {
  const syncJobId = `${NS}job_${testId}_${Date.now()}`;
  const idempotencyKey = `${payload.marketplace}:${payload.sellerAccountKey}:${payload.source}:${payload.sourceProductId}:${operationType}:${payload.sourceSnapshotId}`;

  return client.syncJob.create({
    data: {
      id: syncJobId,
      productSourceId: fixtures.productSourceId,
      marketplaceListingId: marketplaceListingId ?? null,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      operationType,
      jobType: operationType === "CREATE_LISTING" ? "FULL_SYNC" : operationType === "UPDATE_PRICE" ? "PRICE_UPDATE" : "STOCK_UPDATE",
      executionPayload: payload as unknown as Prisma.InputJsonValue,
      payloadVersion: 1,
      status: "PENDING",
      idempotencyKey,
    },
  });
}

// --------------------------------------------------------------------------
// ME-01: FAIL-CLOSED WITHOUT GATEWAY
// --------------------------------------------------------------------------
test("ME-01: Fail-closed without gateway: throws safe error and leaves DB unmutated", async () => {
  const { queueName, queue } = createIsolatedQueue("me01");
  const queueEvents = createIsolatedEvents(queueName);
  let worker: SyncExecutionWorker | undefined;

  try {
    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: "unknown_marketplace",
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Test Title ME01",
      preparedDescription: "Test Description ME01",
      targetCategoryId: "cat_100",
      images: [{ url: "https://img.jakmall.com/1.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { color: "Black" },
          targetPriceIdr: 150000,
          inventory: { resolution: "RESOLVED", targetQuantity: 10 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me01", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

    const emptyRegistry = new MarketplaceGatewayRegistry();
    const executor = new MarketplaceSyncJobExecutor(prisma, emptyRegistry);
    worker = createIsolatedWorker(queueName, executor);

    await assert.rejects(async () => job.waitUntilFinished(queueEvents));

    const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
    assert.ok(failedJob);
    assert.equal(failedJob.status, "FAILED");
    assert.equal(failedJob.lastErrorCode, "MARKETPLACE_LIVE_PROTOCOL_UNAVAILABLE");

    const listings = await prisma.marketplaceListing.findMany({
      where: { productId: fixtures.productId, marketplace: "unknown_marketplace" },
    });
    assert.equal(listings.length, 0, "No listing should be created when gateway is unavailable");
  } finally {
    await queueEvents.close();
    if (worker) await worker.close();
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-02: CREATE COMMAND MAPPING
// --------------------------------------------------------------------------
test("ME-02: CREATE command mapping contains exact durable values and zero secrets", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Premium Wireless Earbuds",
    preparedDescription: "Crystal clear audio with ANC",
    targetCategoryId: "cat_audio_99",
    targetCategoryName: "Audio & Headphones",
    brand: "JakMall Audio",
    totalWeightGrams: 250,
    images: [
      { url: "https://img.jakmall.com/front.jpg", position: 1 },
      { url: "https://img.jakmall.com/back.jpg", position: 2 },
    ],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: fixtures.destSku1,
        attributes: { color: "Black" },
        targetPriceIdr: 299000,
        inventory: { resolution: "RESOLVED", targetQuantity: 42 },
      },
      {
        sourceSkuId: fixtures.sourceSkuId2,
        destinationSku: fixtures.destSku2,
        attributes: { color: "White" },
        targetPriceIdr: 319000,
        inventory: { resolution: "RESOLVED", targetQuantity: 15 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me02", "CREATE_LISTING", payload);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await executor.execute(syncJob, payload);

  assert.equal(testGateway.createCalls.length, 1);
  const command = testGateway.createCalls[0]!;

  assert.equal(command.schemaVersion, 1);
  assert.equal(command.operationType, "CREATE_LISTING");
  assert.equal(command.marketplace, fixtures.marketplace);
  assert.equal(command.sellerAccountKey, fixtures.sellerAccountKey);
  assert.equal(command.idempotencyKey, syncJob.idempotencyKey);
  assert.equal(command.sourceProductId, fixtures.sourceProductId);
  assert.equal(command.preparedTitle, "Premium Wireless Earbuds");
  assert.equal(command.preparedDescription, "Crystal clear audio with ANC");
  assert.equal(command.targetCategoryId, "cat_audio_99");
  assert.equal(command.targetCategoryName, "Audio & Headphones");
  assert.equal(command.brand, "JakMall Audio");
  assert.equal(command.totalWeightGrams, 250);
  assert.deepEqual(command.images, [
    "https://img.jakmall.com/front.jpg",
    "https://img.jakmall.com/back.jpg",
  ]);
  assert.equal(command.variants.length, 2);
  assert.deepEqual(command.variants[0], {
    sourceSkuId: fixtures.sourceSkuId1,
    destinationSku: fixtures.destSku1,
    attributes: { color: "Black" },
    targetPriceIdr: 299000,
    targetQuantity: 42,
  });
  assert.deepEqual(command.variants[1], {
    sourceSkuId: fixtures.sourceSkuId2,
    destinationSku: fixtures.destSku2,
    attributes: { color: "White" },
    targetPriceIdr: 319000,
    targetQuantity: 15,
  });
});

// --------------------------------------------------------------------------
// ME-03: CREATE SUCCESS + READ AFTER WRITE
// --------------------------------------------------------------------------
test("ME-03: Full CREATE lifecycle: BullMQ -> Worker -> Executor -> Gateway -> DB verification -> COMPLETED", async () => {
  const { queueName, queue } = createIsolatedQueue("me03");
  const queueEvents = createIsolatedEvents(queueName);
  let worker: SyncExecutionWorker | undefined;

  try {
    const testGateway = new TestSimulatedMarketplaceGateway("shopee");
    const registry = new MarketplaceGatewayRegistry();
    registry.registerGateway(testGateway);

    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Ergonomic Mechanical Keyboard",
      preparedDescription: "RGB Backlit with Hot-Swap",
      targetCategoryId: "cat_kb_01",
      images: [{ url: "https://img.jakmall.com/kb.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { switch: "Red" },
          targetPriceIdr: 750000,
          inventory: { resolution: "RESOLVED", targetQuantity: 25 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me03", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

    const executor = new MarketplaceSyncJobExecutor(prisma, registry);
    worker = createIsolatedWorker(queueName, executor);

    await job.waitUntilFinished(queueEvents);

    // 1. SyncJob completed
    const completedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
    assert.ok(completedJob);
    assert.equal(completedJob.status, "COMPLETED");
    assert.equal(completedJob.attemptCount, 1);
    assert.ok(completedJob.marketplaceListingId);

    // 2. MarketplaceListing verified
    const listing = await prisma.marketplaceListing.findUnique({
      where: { id: completedJob.marketplaceListingId! },
      include: { variants: true },
    });
    assert.ok(listing);
    assert.equal(listing.status, "VERIFIED");
    assert.ok(listing.lastVerifiedAt);
    assert.ok(listing.remoteListingId);

    // 3. MarketplaceListingVariant verified
    assert.equal(listing.variants.length, 1);
    const variant = listing.variants[0]!;
    assert.equal(variant.sourceSkuId, fixtures.sourceSkuId1);
    assert.equal(variant.destinationSku, fixtures.destSku1);
    assert.equal(variant.lastKnownDestinationPrice, 750000);
    assert.equal(variant.lastKnownDestinationStock, 25);

    // 4. SYNC_COMPLETED event exists, no VERIFY_MISMATCH
    const events = await prisma.syncEvent.findMany({ where: { syncJobId: syncJob.id } });
    assert.ok(events.some((e) => e.eventType === "SYNC_COMPLETED"));
    assert.ok(!events.some((e) => e.eventType === "VERIFY_MISMATCH"));
  } finally {
    await queueEvents.close();
    if (worker) await worker.close();
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-04: CREATE RETRY IDEMPOTENCY & RECONCILIATION HARDENING
// --------------------------------------------------------------------------
test("ME-04: CREATE retry idempotency and transactional listing/variant reconciliation", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Idempotency Test Item",
    preparedDescription: "Testing repeated CREATE idempotency",
    targetCategoryId: "cat_test_idemp",
    images: [{ url: "https://img.jakmall.com/idemp.jpg" }],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: fixtures.destSku1,
        attributes: { model: "A" },
        targetPriceIdr: 100000,
        inventory: { resolution: "RESOLVED", targetQuantity: 5 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me04", "CREATE_LISTING", payload);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  // Subcase 4.1: First execution
  await executor.execute(syncJob, payload);
  assert.equal(testGateway.createCalls.length, 1);
  assert.equal(testGateway.logicalCreateCount, 1);

  const firstJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  const firstListingId = firstJob?.marketplaceListingId;
  assert.ok(firstListingId);

  // Subcase 4.2: Second execution (simulating retry of same logical CREATE)
  await executor.execute(syncJob, payload);
  assert.equal(testGateway.createCalls.length, 2, "Gateway invoked twice");
  assert.equal(testGateway.logicalCreateCount, 1, "Logical remote creations remained exactly 1");

  const secondJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.equal(secondJob?.marketplaceListingId, firstListingId, "Reused existing local MarketplaceListing");

  const idempKey = `${payload.marketplace}:${payload.sellerAccountKey}:${syncJob.idempotencyKey}`;
  const remoteListingId = testGateway.idempotencyMap.get(idempKey);
  assert.ok(remoteListingId);

  const matchingListings = await prisma.marketplaceListing.findMany({
    where: {
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId,
    },
  });
  assert.equal(matchingListings.length, 1, "Exactly one local MarketplaceListing persists for this remote listing");

  // Subcase 4.3: Existing listing with null remoteListingId is safely reconciled
  const prodIdNullRem = `${NS}prod_me04_null_rem`;
  await prisma.product.create({ data: { id: prodIdNullRem } });
  const psIdNullRem = `${NS}ps_me04_null_rem`;
  const spIdNullRem = `${NS}sp_me04_null_rem`;
  await prisma.productSource.create({
    data: {
      id: psIdNullRem,
      productId: prodIdNullRem,
      source: fixtures.source,
      sourceProductId: spIdNullRem,
      sourceUrl: "https://www.jakmall.com/p/null-rem",
    },
  });
  const snapIdNullRem = `${NS}snap_me04_null_rem`;
  await prisma.sourceSnapshot.create({
    data: {
      id: snapIdNullRem,
      productSourceId: psIdNullRem,
      sourceHash: "shash_null_rem",
      contentHash: "chash_null_rem",
      priceHash: "phash_null_rem",
      inventoryHash: "ihash_null_rem",
      variantHash: "vhash_null_rem",
      canonicalPayload: {} as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });

  const nullRemoteListingId = `${NS}list_me04_null_rem`;
  await prisma.marketplaceListing.create({
    data: {
      id: nullRemoteListingId,
      productId: prodIdNullRem,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PENDING_PUBLISH",
    },
  });

  const payloadNullRemote: CreateListingExecutionPayload = {
    ...payload,
    sourceProductId: spIdNullRem,
    sourceSnapshotId: snapIdNullRem,
  };

  const syncJobNullRemote = await prisma.syncJob.create({
    data: {
      id: `${NS}job_me04_null_rem_${Date.now()}`,
      productSourceId: psIdNullRem,
      marketplaceListingId: nullRemoteListingId,
      sourceSnapshotId: snapIdNullRem,
      operationType: "CREATE_LISTING",
      jobType: "FULL_SYNC",
      executionPayload: payloadNullRemote as unknown as Prisma.InputJsonValue,
      payloadVersion: 1,
      status: "PENDING",
      idempotencyKey: `${payload.marketplace}:${payload.sellerAccountKey}:${payload.source}:${spIdNullRem}:CREATE_LISTING:${snapIdNullRem}`,
    },
  });

  await executor.execute(syncJobNullRemote, payloadNullRemote);
  const reconciledListing = await prisma.marketplaceListing.findUnique({
    where: { id: nullRemoteListingId },
  });
  assert.ok(reconciledListing?.remoteListingId, "null remoteListingId was safely reconciled to gateway remoteListingId");

  // Subcase 4.4: Preflight: Dangling marketplaceListingId -> fails closed, gateway.createCalls unchanged
  const callsBeforeDangling = testGateway.createCalls.length;
  const danglingListingId = `${NS}list_nonexistent_dangling_me04`;
  const syncJobValidForDangling = await createSyncJobFixture(
    prisma,
    "me04_dangling",
    "CREATE_LISTING",
    payload
  );
  const syncJobDangling = { ...syncJobValidForDangling, marketplaceListingId: danglingListingId };
  await assert.rejects(
    async () => executor.execute(syncJobDangling, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("was not found in database")
  );
  assert.equal(
    testGateway.createCalls.length,
    callsBeforeDangling,
    "Preflight rejected dangling listing before gateway mutation"
  );

  // Subcase 4.5: Preflight: Wrong product -> fails closed, gateway.createCalls unchanged
  const callsBeforeWrongProd = testGateway.createCalls.length;
  const otherProdId = `${NS}prod_me04_other`;
  await prisma.product.create({ data: { id: otherProdId } });
  const wrongProdListingId = `${NS}list_me04_wrong_prod`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongProdListingId,
      productId: otherProdId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PENDING_PUBLISH",
    },
  });
  const syncJobWrongProd = await createSyncJobFixture(
    prisma,
    "me04_wrong_prod",
    "CREATE_LISTING",
    payload,
    wrongProdListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobWrongProd, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("does not match authoritative ProductSource productId")
  );
  assert.equal(
    testGateway.createCalls.length,
    callsBeforeWrongProd,
    "Preflight rejected wrong product before gateway mutation"
  );

  // Subcase 4.6: Preflight: Wrong marketplace -> fails closed, gateway.createCalls unchanged
  const callsBeforeWrongMkt = testGateway.createCalls.length;
  const wrongMktListingId = `${NS}list_me04_wrong_mkt`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongMktListingId,
      productId: fixtures.productId,
      marketplace: "tokopedia",
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PENDING_PUBLISH",
    },
  });
  const syncJobWrongMkt = await createSyncJobFixture(
    prisma,
    "me04_wrong_mkt",
    "CREATE_LISTING",
    payload,
    wrongMktListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobWrongMkt, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("marketplace 'tokopedia' does not match payload marketplace")
  );
  assert.equal(
    testGateway.createCalls.length,
    callsBeforeWrongMkt,
    "Preflight rejected wrong marketplace before gateway mutation"
  );

  // Subcase 4.7: Preflight: Wrong sellerAccountKey -> fails closed, gateway.createCalls unchanged
  const callsBeforeWrongSeller = testGateway.createCalls.length;
  const wrongSellerListingId = `${NS}list_me04_wrong_seller`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongSellerListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: "other_seller_key_xxx",
      remoteListingId: null,
      status: "PENDING_PUBLISH",
    },
  });
  const syncJobWrongSeller = await createSyncJobFixture(
    prisma,
    "me04_wrong_seller",
    "CREATE_LISTING",
    payload,
    wrongSellerListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobWrongSeller, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("sellerAccountKey 'other_seller_key_xxx' does not match payload sellerAccountKey")
  );
  assert.equal(
    testGateway.createCalls.length,
    callsBeforeWrongSeller,
    "Preflight rejected wrong seller before gateway mutation"
  );

  // Subcase 4.8: Preflight: Conflicting destinationSku in existing variant mapping -> fails closed, gateway.createCalls unchanged
  const callsBeforeConflictSku = testGateway.createCalls.length;
  const conflictVariantListingId = `${NS}list_me04_conflict_var`;
  await prisma.marketplaceListing.create({
    data: {
      id: conflictVariantListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PENDING_PUBLISH",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: "conflicting_destination_sku_xxx",
          },
        ],
      },
    },
  });
  const syncJobConflictVar = await createSyncJobFixture(
    prisma,
    "me04_conflict_var",
    "CREATE_LISTING",
    payload,
    conflictVariantListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobConflictVar, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("conflicts with durable destinationSku")
  );
  assert.equal(
    testGateway.createCalls.length,
    callsBeforeConflictSku,
    "Preflight rejected conflicting destinationSku before gateway mutation"
  );

  // Subcase 4.9: Post-mutation: Conflicting remoteListingId -> fail closed
  const conflictingRemoteListingId = `${NS}list_me04_conflicting_rem`;
  await prisma.marketplaceListing.create({
    data: {
      id: conflictingRemoteListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: "other_conflicting_remote_id_999",
      status: "PUBLISHED",
    },
  });
  const syncJobConflictingRemote = await createSyncJobFixture(
    prisma,
    "me04_conflict_rem",
    "CREATE_LISTING",
    payload,
    conflictingRemoteListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobConflictingRemote, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("conflicts with gateway-returned remoteListingId")
  );

  // Subcase 4.10: Post-mutation: Conflicting remoteVariantId in existing variant mapping -> fail closed
  const conflictRemVarListingId = `${NS}list_me04_conflict_rem_var`;
  const assignedRemoteIdForVarTest = `${NS}rem_me04_rem_var_test`;
  await prisma.marketplaceListing.create({
    data: {
      id: conflictRemVarListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: assignedRemoteIdForVarTest,
      status: "PUBLISHED",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: fixtures.destSku1,
            remoteVariantId: "existing_remote_var_different",
          },
        ],
      },
    },
  });
  testGateway.createOverride = async () => ({
    remoteListingId: assignedRemoteIdForVarTest,
    variantMappings: [
      { sourceSkuId: fixtures.sourceSkuId1, remoteVariantId: "gateway_returned_different_var" },
    ],
  });
  const syncJobConflictRemVar = await createSyncJobFixture(
    prisma,
    "me04_conflict_rem_var",
    "CREATE_LISTING",
    payload,
    conflictRemVarListingId
  );
  await assert.rejects(
    async () => executor.execute(syncJobConflictRemVar, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("conflicts with gateway remoteVariantId")
  );
  testGateway.createOverride = undefined;

  // Subcase 4.11: Post-mutation: Null-remote job listing + another listing already bound to returned remote ID -> fail closed
  const existingBoundRemoteId = `${NS}rem_already_bound_me04`;
  const existingBoundListingId = `${NS}list_me04_already_bound`;
  await prisma.marketplaceListing.create({
    data: {
      id: existingBoundListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: existingBoundRemoteId,
      status: "PUBLISHED",
    },
  });

  const nullRemoteJobListingId = `${NS}list_me04_null_to_conflict`;
  await prisma.marketplaceListing.create({
    data: {
      id: nullRemoteJobListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PENDING_PUBLISH",
    },
  });

  testGateway.createOverride = async () => ({
    remoteListingId: existingBoundRemoteId,
  });

  const syncJobDuplicateBinding = await createSyncJobFixture(
    prisma,
    "me04_dup_bind",
    "CREATE_LISTING",
    payload,
    nullRemoteJobListingId
  );

  await assert.rejects(
    async () => executor.execute(syncJobDuplicateBinding, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("already owns this remote binding")
  );

  // Verify PostgreSQL state: nullRemoteJobListingId remains null, no duplicate binding created
  const listingAfterDupAttempt = await prisma.marketplaceListing.findUnique({
    where: { id: nullRemoteJobListingId },
  });
  assert.equal(listingAfterDupAttempt?.remoteListingId, null, "Target listing remoteListingId was not mutated");
  const allBindingsForRemote = await prisma.marketplaceListing.findMany({
    where: {
      marketplace: payload.marketplace,
      sellerAccountKey: payload.sellerAccountKey,
      remoteListingId: existingBoundRemoteId,
    },
  });
  assert.equal(allBindingsForRemote.length, 1, "Exactly one listing owns this remote binding in DB (zero duplicates introduced)");

  // Subcase 4.12: Post-mutation: Multiple existing local rows for the same marketplace + seller + remoteListingId -> rejected as ambiguous
  const ambiguousRemoteId = `${NS}rem_ambiguous_me04`;
  const ambigListing1 = `${NS}list_me04_ambig_1`;
  const ambigListing2 = `${NS}list_me04_ambig_2`;
  await prisma.marketplaceListing.create({
    data: {
      id: ambigListing1,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: ambiguousRemoteId,
      status: "PUBLISHED",
    },
  });
  await prisma.marketplaceListing.create({
    data: {
      id: ambigListing2,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: ambiguousRemoteId,
      status: "PUBLISHED",
    },
  });

  testGateway.createOverride = async () => ({
    remoteListingId: ambiguousRemoteId,
  });

  // SyncJob without marketplaceListingId, resolving by returned remoteListingId
  const syncJobAmbig = await createSyncJobFixture(
    prisma,
    "me04_ambig",
    "CREATE_LISTING",
    payload
  );

  await assert.rejects(
    async () => executor.execute(syncJobAmbig, payload),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("Ambiguous local remote identity: multiple MarketplaceListings exist")
  );

  // Verify PostgreSQL state: no new third listing was created
  const allAmbigListings = await prisma.marketplaceListing.findMany({
    where: {
      marketplace: payload.marketplace,
      sellerAccountKey: payload.sellerAccountKey,
      remoteListingId: ambiguousRemoteId,
    },
  });
  assert.equal(allAmbigListings.length, 2, "No new duplicate local binding or extra row introduced by executor");

  testGateway.createOverride = undefined;

  // Subcase 4.13: Gateway variantMappings validation (duplicate SKU, unknown SKU, blank remoteVariantId)
  testGateway.createOverride = async (cmd) => ({
    remoteListingId: `${NS}rem_override_dup`,
    variantMappings: [
      { sourceSkuId: fixtures.sourceSkuId1, remoteVariantId: "rv1" },
      { sourceSkuId: fixtures.sourceSkuId1, remoteVariantId: "rv2" }, // Duplicate
    ],
  });
  const syncJobDupGateway = await createSyncJobFixture(prisma, "me04_dup_gw", "CREATE_LISTING", payload);
  await assert.rejects(
    async () => executor.execute(syncJobDupGateway, payload),
    /Gateway variantMapping contains duplicate sourceSkuId/
  );

  testGateway.createOverride = async (cmd) => ({
    remoteListingId: `${NS}rem_override_unknown`,
    variantMappings: [
      { sourceSkuId: "completely_unknown_sku", remoteVariantId: "rv1" },
    ],
  });
  const syncJobUnknownGateway = await createSyncJobFixture(prisma, "me04_unk_gw", "CREATE_LISTING", payload);
  await assert.rejects(
    async () => executor.execute(syncJobUnknownGateway, payload),
    /Gateway variantMapping contains unknown sourceSkuId/
  );

  testGateway.createOverride = async (cmd) => ({
    remoteListingId: `${NS}rem_override_blank_var`,
    variantMappings: [
      { sourceSkuId: fixtures.sourceSkuId1, remoteVariantId: "   " },
    ],
  });
  const syncJobBlankVarGateway = await createSyncJobFixture(prisma, "me04_blank_gw", "CREATE_LISTING", payload);
  await assert.rejects(
    async () => executor.execute(syncJobBlankVarGateway, payload),
    /contains blank remoteVariantId/
  );

  testGateway.createOverride = undefined;
});

// --------------------------------------------------------------------------
// ME-05: CREATE VERIFICATION MISMATCH
// --------------------------------------------------------------------------
test("ME-05: CREATE verification mismatch transitions listing NEEDS_REVIEW, job FAILED, and emits VERIFY_MISMATCH", async () => {
  const { queueName, queue } = createIsolatedQueue("me05");
  const queueEvents = createIsolatedEvents(queueName);
  let worker: SyncExecutionWorker | undefined;

  try {
    const testGateway = new TestSimulatedMarketplaceGateway("shopee");
    const registry = new MarketplaceGatewayRegistry();
    registry.registerGateway(testGateway);

    // Subcase 5.1: Reader override returns wrong price
    testGateway.readOverride = (remoteListingId: string) => ({
      remoteListingId,
      title: "Mismatch Item",
      variants: [
        {
          destinationSku: fixtures.destSku1,
          priceIdr: 999999, // Mismatched price
          stock: 5,
        },
      ],
    });

    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Mismatch Item",
      preparedDescription: "Testing mismatch",
      targetCategoryId: "cat_mismatch",
      images: [{ url: "https://img.jakmall.com/mis.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { test: "1" },
          targetPriceIdr: 50000,
          inventory: { resolution: "RESOLVED", targetQuantity: 5 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me05", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

    const executor = new MarketplaceSyncJobExecutor(prisma, registry);
    worker = createIsolatedWorker(queueName, executor);

    await assert.rejects(async () => job.waitUntilFinished(queueEvents));

    const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
    assert.ok(failedJob);
    assert.equal(failedJob.status, "FAILED");
    assert.equal(failedJob.lastErrorCode, "MARKETPLACE_VERIFY_MISMATCH");

    const listing = await prisma.marketplaceListing.findUnique({
      where: { id: failedJob.marketplaceListingId! },
    });
    assert.ok(listing);
    assert.equal(listing.status, "NEEDS_REVIEW");
    assert.ok(listing.lastVerifiedAt);

    const mismatchEvent = await prisma.syncEvent.findFirst({
      where: { syncJobId: syncJob.id, eventType: "VERIFY_MISMATCH" },
    });
    assert.ok(mismatchEvent);
    const eventPayload = mismatchEvent.payload as { mismatches?: Array<{ field: string; expected: number; actual: number }> };
    assert.ok(eventPayload?.mismatches?.some((m) => m.field === "priceIdr" && m.expected === 50000 && m.actual === 999999));

    // Subcase 5.2: Reader override returns wrong remoteListingId -> triggers VERIFY_MISMATCH with field 'remoteListingId'
    testGateway.readOverride = () => ({
      remoteListingId: "completely_wrong_remote_id_999",
      title: "Mismatch Item",
      variants: [
        {
          destinationSku: fixtures.destSku1,
          priceIdr: 50000,
          stock: 5,
        },
      ],
    });

    const syncJobWrongRemId = await createSyncJobFixture(prisma, "me05_rem_mismatch", "CREATE_LISTING", payload);
    await assert.rejects(
      async () => executor.execute(syncJobWrongRemId, payload),
      (err: unknown) => {
        return (
          err instanceof MarketplaceVerifyMismatchError &&
          err.mismatches.some((m) => m.field === "remoteListingId")
        );
      }
    );

    const wrongRemEvent = await prisma.syncEvent.findFirst({
      where: { syncJobId: syncJobWrongRemId.id, eventType: "VERIFY_MISMATCH" },
    });
    assert.ok(wrongRemEvent);
    const wrongRemPayload = wrongRemEvent.payload as { mismatches?: Array<{ field: string; expected: string; actual: string }> };
    assert.ok(wrongRemPayload?.mismatches?.some((m) => m.field === "remoteListingId"));
  } finally {
    await queueEvents.close();
    if (worker) await worker.close();
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-06: CREATE VERIFY NOT FOUND
// --------------------------------------------------------------------------
test("ME-06: CREATE verify not found: remote returns null -> job FAILED with MARKETPLACE_VERIFY_NOT_FOUND", async () => {
  const { queueName, queue } = createIsolatedQueue("me06");
  const queueEvents = createIsolatedEvents(queueName);
  let worker: SyncExecutionWorker | undefined;

  try {
    const testGateway = new TestSimulatedMarketplaceGateway("shopee");
    testGateway.readOverride = () => null; // Returns null on read

    const registry = new MarketplaceGatewayRegistry();
    registry.registerGateway(testGateway);

    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Ghost Listing",
      preparedDescription: "Item disappears after create",
      targetCategoryId: "cat_ghost",
      images: [{ url: "https://img.jakmall.com/ghost.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { ghost: "true" },
          targetPriceIdr: 80000,
          inventory: { resolution: "RESOLVED", targetQuantity: 10 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me06", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

    const executor = new MarketplaceSyncJobExecutor(prisma, registry);
    worker = createIsolatedWorker(queueName, executor);

    await assert.rejects(async () => job.waitUntilFinished(queueEvents));

    const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
    assert.ok(failedJob);
    assert.equal(failedJob.status, "FAILED");
    assert.equal(failedJob.lastErrorCode, "MARKETPLACE_VERIFY_NOT_FOUND");
  } finally {
    await queueEvents.close();
    if (worker) await worker.close();
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-07: UPDATE PRICE SUCCESS & MUTATION RESULT HANDLING
// --------------------------------------------------------------------------
test("ME-07: UPDATE_PRICE success: updates lastKnownDestinationPrice and preserves unaffected stock, fails closed on false success", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const listingId = `${NS}list_me07`;
  const remoteListingId = `${NS}rem_me07`;

  await prisma.marketplaceListing.create({
    data: {
      id: listingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: fixtures.destSku1,
            lastKnownDestinationPrice: 100000,
            lastKnownDestinationStock: 50,
          },
          {
            sourceSkuId: fixtures.sourceSkuId2,
            destinationSku: fixtures.destSku2,
            lastKnownDestinationPrice: 200000,
            lastKnownDestinationStock: 75,
          },
        ],
      },
    },
  });

  // Seed remote gateway state
  testGateway.createdListings.set(remoteListingId, {
    remoteListingId,
    variants: [
      { destinationSku: fixtures.destSku1, priceIdr: 100000, stock: 50 },
      { destinationSku: fixtures.destSku2, priceIdr: 200000, stock: 75 },
    ],
  });

  // Payload updates price of variant 1 only
  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId,
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        targetPriceIdr: 125000,
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me07", "UPDATE_PRICE", payload, listingId);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await executor.execute(syncJob, payload);

  const listing = await prisma.marketplaceListing.findUnique({
    where: { id: listingId },
    include: { variants: true },
  });
  assert.ok(listing);
  assert.equal(listing.status, "VERIFIED");
  assert.ok(listing.lastVerifiedAt);

  const var1 = listing.variants.find((v) => v.sourceSkuId === fixtures.sourceSkuId1)!;
  const var2 = listing.variants.find((v) => v.sourceSkuId === fixtures.sourceSkuId2)!;

  assert.equal(var1.lastKnownDestinationPrice, 125000, "Variant 1 price updated");
  assert.equal(var1.lastKnownDestinationStock, 50, "Variant 1 stock preserved");

  assert.equal(var2.lastKnownDestinationPrice, 200000, "Variant 2 price untouched");
  assert.equal(var2.lastKnownDestinationStock, 75, "Variant 2 stock untouched");

  // Subcase 7.2: Gateway returns success: false -> fail-closed with MARKETPLACE_MUTATION_FAILED
  testGateway.returnUnsuccessfulMutation = true;
  const syncJobFailedMutation = await createSyncJobFixture(prisma, "me07_failed_mut", "UPDATE_PRICE", payload, listingId);
  await assert.rejects(
    async () => executor.execute(syncJobFailedMutation, payload),
    (err: unknown) =>
      err instanceof MarketplaceExecutionError &&
      err.code === "MARKETPLACE_MUTATION_FAILED"
  );
  testGateway.returnUnsuccessfulMutation = false;
});

// --------------------------------------------------------------------------
// ME-08: UPDATE STOCK SUCCESS INCLUDING ZERO & FAIL-CLOSED UNRESOLVED INVENTORY
// --------------------------------------------------------------------------
test("ME-08: UPDATE_STOCK success: preserves exact 0 target stock, fails closed on unresolved inventory or false success", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const listingId = `${NS}list_me08`;
  const remoteListingId = `${NS}rem_me08`;

  await prisma.marketplaceListing.create({
    data: {
      id: listingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: fixtures.destSku1,
            lastKnownDestinationPrice: 50000,
            lastKnownDestinationStock: 10,
          },
        ],
      },
    },
  });

  testGateway.createdListings.set(remoteListingId, {
    remoteListingId,
    variants: [{ destinationSku: fixtures.destSku1, priceIdr: 50000, stock: 10 }],
  });

  // Legitimate RESOLVED targetQuantity 0
  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId,
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        inventory: { resolution: "RESOLVED", targetQuantity: 0 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me08", "UPDATE_STOCK", payload, listingId);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await executor.execute(syncJob, payload);

  const updatedVariant = await prisma.marketplaceListingVariant.findFirst({
    where: { listingId, sourceSkuId: fixtures.sourceSkuId1 },
  });
  assert.ok(updatedVariant);
  assert.equal(updatedVariant.lastKnownDestinationStock, 0, "Target quantity 0 preserved exactly");

  const remoteState = testGateway.createdListings.get(remoteListingId);
  assert.equal(remoteState?.variants[0]?.stock, 0, "Remote stock updated to exact 0");

  // Subcase 8.2: Fail-closed inventory extractor check - unresolved inventory must NEVER become 0
  assert.equal(extractResolvedTargetQuantity({ resolution: "RESOLVED", targetQuantity: 0 }), 0);
  assert.equal(extractResolvedTargetQuantity({ resolution: "RESOLVED", targetQuantity: 15 }), 15);
  assert.throws(
    () => extractResolvedTargetQuantity({ resolution: "NEEDS_REVIEW" }, "test_sku"),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("Unresolved inventory cannot be converted to target quantity")
  );
  assert.throws(
    () => extractResolvedTargetQuantity({ resolution: "BLOCKED" }, "test_sku"),
    (err: unknown) =>
      err instanceof MarketplaceTargetIntegrityError &&
      err.message.includes("Unresolved inventory cannot be converted to target quantity")
  );

  // Subcase 8.3: Gateway returns success: false -> fail-closed with MARKETPLACE_MUTATION_FAILED
  testGateway.returnUnsuccessfulMutation = true;
  const syncJobFailedStockMutation = await createSyncJobFixture(prisma, "me08_failed_stock", "UPDATE_STOCK", payload, listingId);
  await assert.rejects(
    async () => executor.execute(syncJobFailedStockMutation, payload),
    (err: unknown) =>
      err instanceof MarketplaceExecutionError &&
      err.code === "MARKETPLACE_MUTATION_FAILED"
  );
  testGateway.returnUnsuccessfulMutation = false;
});

// --------------------------------------------------------------------------
// ME-09: UPDATE TARGET & RUNTIME SOURCE IDENTITY FAIL-CLOSED
// --------------------------------------------------------------------------
test("ME-09: UPDATE target and runtime source identity fail-closed checks reject inconsistent relationships before mutation", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  const validPayload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId: fixtures.remoteListingId,
    variants: [{ sourceSkuId: fixtures.sourceSkuId1, targetPriceIdr: 50000 }],
  };

  // 1. Missing SyncJob.marketplaceListingId
  const jobMissingListingId = await createSyncJobFixture(prisma, "me09_1", "UPDATE_PRICE", validPayload, undefined);
  await assert.rejects(
    async () => executor.execute(jobMissingListingId, validPayload),
    /missing required marketplaceListingId/
  );

  // 2. Listing not found in DB at runtime
  const tempListingId = `${NS}list_temp_09`;
  await prisma.marketplaceListing.create({
    data: {
      id: tempListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
    },
  });
  const jobNonexistentListing = await createSyncJobFixture(prisma, "me09_2", "UPDATE_PRICE", validPayload, tempListingId);
  await prisma.syncJob.update({
    where: { id: jobNonexistentListing.id },
    data: { marketplaceListingId: null },
  });
  await prisma.marketplaceListing.delete({ where: { id: tempListingId } });
  const jobWithDanglingListing = { ...jobNonexistentListing, marketplaceListingId: tempListingId };
  await assert.rejects(
    async () => executor.execute(jobWithDanglingListing, validPayload),
    /MarketplaceListing '.*' not found/
  );

  // 3. Missing remoteListingId on listing
  const missingRemoteListingId = `${NS}list_me09_no_rem`;
  await prisma.marketplaceListing.create({
    data: {
      id: missingRemoteListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: null,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });
  const jobNoRemote = await createSyncJobFixture(prisma, "me09_3", "UPDATE_PRICE", validPayload, missingRemoteListingId);
  await assert.rejects(
    async () => executor.execute(jobNoRemote, validPayload),
    /has no remoteListingId/
  );

  // 4. Payload remoteListingId mismatch
  const mismatchListingId = `${NS}list_me09_mis`;
  await prisma.marketplaceListing.create({
    data: {
      id: mismatchListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: "actual_remote_999",
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });
  const jobMismatchRemote = await createSyncJobFixture(prisma, "me09_4", "UPDATE_PRICE", validPayload, mismatchListingId);
  await assert.rejects(
    async () => executor.execute(jobMismatchRemote, validPayload),
    /remoteListingId '.*' does not match payload remoteListingId/
  );

  // 5. Wrong marketplace
  const wrongMktListingId = `${NS}list_me09_mkt`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongMktListingId,
      productId: fixtures.productId,
      marketplace: "tokopedia",
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });
  const jobWrongMkt = await createSyncJobFixture(prisma, "me09_5", "UPDATE_PRICE", validPayload, wrongMktListingId);
  await assert.rejects(
    async () => executor.execute(jobWrongMkt, validPayload),
    /marketplace '.*' does not match payload marketplace/
  );

  // 6. Wrong seller account key
  const wrongSellerListingId = `${NS}list_me09_seller`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongSellerListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: "other_seller_key",
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });
  const jobWrongSeller = await createSyncJobFixture(prisma, "me09_6", "UPDATE_PRICE", validPayload, wrongSellerListingId);
  await assert.rejects(
    async () => executor.execute(jobWrongSeller, validPayload),
    /sellerAccountKey '.*' does not match payload sellerAccountKey/
  );

  // 7. Wrong Product
  const otherProductId = `${NS}prod_other_09`;
  await prisma.product.create({ data: { id: otherProductId } });
  const wrongProdListingId = `${NS}list_me09_prod`;
  await prisma.marketplaceListing.create({
    data: {
      id: wrongProdListingId,
      productId: otherProductId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });
  const jobWrongProd = await createSyncJobFixture(prisma, "me09_7", "UPDATE_PRICE", validPayload, wrongProdListingId);
  await assert.rejects(
    async () => executor.execute(jobWrongProd, validPayload),
    /productId '.*' does not match ProductSource productId/
  );

  // 8. Missing sourceSkuId variant mapping
  const missingVarListingId = `${NS}list_me09_var`;
  await prisma.marketplaceListing.create({
    data: {
      id: missingVarListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: "completely_different_sku", destinationSku: "other_dest" }],
      },
    },
  });
  const jobMissingVar = await createSyncJobFixture(prisma, "me09_8", "UPDATE_PRICE", validPayload, missingVarListingId);
  await assert.rejects(
    async () => executor.execute(jobMissingVar, validPayload),
    /has no persisted variant mapping for sourceSkuId/
  );

  // 9-14: Setup valid MarketplaceListing so marketplaceListingId foreign key constraint is satisfied
  const validListingId = `${NS}list_me09_valid`;
  await prisma.marketplaceListing.create({
    data: {
      id: validListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1 }],
      },
    },
  });

  // 9. ProductSource.source !== payload.source
  const wrongSourcePayload = { ...validPayload, source: "wrong_source_val" };
  const jobWrongSource = await createSyncJobFixture(prisma, "me09_9", "UPDATE_PRICE", wrongSourcePayload, validListingId);
  await assert.rejects(
    async () => executor.execute(jobWrongSource, wrongSourcePayload),
    /ProductSource source '.*' does not match payload source/
  );

  // 10. ProductSource.sourceProductId !== payload.sourceProductId
  const wrongSpPayload = { ...validPayload, sourceProductId: "wrong_sp_val" };
  const jobWrongSp = await createSyncJobFixture(prisma, "me09_10", "UPDATE_PRICE", wrongSpPayload, validListingId);
  await assert.rejects(
    async () => executor.execute(jobWrongSp, wrongSpPayload),
    /ProductSource sourceProductId '.*' does not match payload sourceProductId/
  );

  // 11. SyncJob.sourceSnapshotId is missing/blank
  const jobMissingSnapshot = await createSyncJobFixture(prisma, "me09_11", "UPDATE_PRICE", validPayload, validListingId);
  await prisma.syncJob.update({
    where: { id: jobMissingSnapshot.id },
    data: { sourceSnapshotId: null },
  });
  const jobNoSnapshotField = { ...jobMissingSnapshot, sourceSnapshotId: null };
  await assert.rejects(
    async () => executor.execute(jobNoSnapshotField, validPayload),
    /missing required sourceSnapshotId/
  );

  // 12. SyncJob.sourceSnapshotId !== payload.sourceSnapshotId
  const jobMismatchedSnapshot = await createSyncJobFixture(prisma, "me09_12", "UPDATE_PRICE", validPayload, validListingId);
  const mismatchedSnapPayload = { ...validPayload, sourceSnapshotId: "completely_different_snapshot_id" };
  await assert.rejects(
    async () => executor.execute(jobMismatchedSnapshot, mismatchedSnapPayload),
    /SyncJob sourceSnapshotId '.*' does not match payload sourceSnapshotId/
  );

  // 13. SourceSnapshot does not exist in DB
  const nonExistentSnapId = `${NS}snap_non_existent`;
  const nonExistentSnapPayload = { ...validPayload, sourceSnapshotId: nonExistentSnapId };
  const jobNonExistentSnap = await createSyncJobFixture(prisma, "me09_13", "UPDATE_PRICE", validPayload, validListingId);
  await assert.rejects(
    async () => executor.execute({ ...jobNonExistentSnap, sourceSnapshotId: nonExistentSnapId }, nonExistentSnapPayload),
    /SourceSnapshot '.*' not found in database/
  );

  // 14. SourceSnapshot.productSourceId !== authoritative ProductSource.id
  const otherPsId = `${NS}ps_other_for_snap`;
  await prisma.productSource.create({
    data: {
      id: otherPsId,
      productId: fixtures.productId,
      source: "jakmall",
      sourceProductId: `${NS}sp_other_snap`,
      sourceUrl: "https://www.jakmall.com/p/other",
    },
  });
  const wrongPsSnapId = `${NS}snap_wrong_ps`;
  await prisma.sourceSnapshot.create({
    data: {
      id: wrongPsSnapId,
      productSourceId: otherPsId,
      sourceHash: "shash_other",
      contentHash: "chash_other",
      priceHash: "phash_other",
      inventoryHash: "ihash_other",
      variantHash: "vhash_other",
      canonicalPayload: {} as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });
  const wrongPsSnapPayload = { ...validPayload, sourceSnapshotId: wrongPsSnapId };
  const jobWrongPsSnap = await createSyncJobFixture(prisma, "me09_14", "UPDATE_PRICE", wrongPsSnapPayload, validListingId);
  await prisma.syncJob.update({
    where: { id: jobWrongPsSnap.id },
    data: { sourceSnapshotId: wrongPsSnapId },
  });
  await assert.rejects(
    async () => executor.execute({ ...jobWrongPsSnap, sourceSnapshotId: wrongPsSnapId }, wrongPsSnapPayload),
    /SourceSnapshot productSourceId '.*' does not match authoritative ProductSource id/
  );

  // Assert 0 mutations called across all fail-closed checks
  assert.equal(testGateway.updatePriceCalls.length, 0);
  assert.equal(testGateway.updateStockCalls.length, 0);
});

// --------------------------------------------------------------------------
// ME-10: UPDATE PRICE VERIFICATION MISMATCH
// --------------------------------------------------------------------------
test("ME-10: UPDATE_PRICE verification mismatch emits VERIFY_MISMATCH and does not update lastKnownDestinationPrice", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const listingId = `${NS}list_me10`;
  const remoteListingId = `${NS}rem_me10`;

  await prisma.marketplaceListing.create({
    data: {
      id: listingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: fixtures.destSku1,
            lastKnownDestinationPrice: 100000,
          },
        ],
      },
    },
  });

  // Gateway read override simulates remote returning old/stale price
  testGateway.readOverride = (id) => ({
    remoteListingId: id,
    variants: [{ destinationSku: fixtures.destSku1, priceIdr: 100000, stock: 10 }],
  });

  const payload: UpdatePriceExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId,
    variants: [{ sourceSkuId: fixtures.sourceSkuId1, targetPriceIdr: 150000 }],
  };

  const syncJob = await createSyncJobFixture(prisma, "me10", "UPDATE_PRICE", payload, listingId);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await assert.rejects(
    async () => executor.execute(syncJob, payload),
    /Read-after-write verification failed for UPDATE_PRICE/
  );

  const variant = await prisma.marketplaceListingVariant.findFirst({
    where: { listingId, sourceSkuId: fixtures.sourceSkuId1 },
  });
  assert.equal(variant?.lastKnownDestinationPrice, 100000, "Price must NOT be overwritten on mismatch");

  const listing = await prisma.marketplaceListing.findUnique({ where: { id: listingId } });
  assert.equal(listing?.status, "NEEDS_REVIEW");

  const mismatchEvent = await prisma.syncEvent.findFirst({
    where: { syncJobId: syncJob.id, eventType: "VERIFY_MISMATCH" },
  });
  assert.ok(mismatchEvent);
});

// --------------------------------------------------------------------------
// ME-11: UPDATE STOCK VERIFICATION MISMATCH
// --------------------------------------------------------------------------
test("ME-11: UPDATE_STOCK verification mismatch emits VERIFY_MISMATCH and does not update lastKnownDestinationStock", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const listingId = `${NS}list_me11`;
  const remoteListingId = `${NS}rem_me11`;

  await prisma.marketplaceListing.create({
    data: {
      id: listingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId,
      status: "PUBLISHED",
      variants: {
        create: [
          {
            sourceSkuId: fixtures.sourceSkuId1,
            destinationSku: fixtures.destSku1,
            lastKnownDestinationStock: 50,
          },
        ],
      },
    },
  });

  testGateway.readOverride = (id) => ({
    remoteListingId: id,
    variants: [{ destinationSku: fixtures.destSku1, priceIdr: 50000, stock: 50 }],
  });

  const payload: UpdateStockExecutionPayload = {
    schemaVersion: 1,
    operationType: "UPDATE_STOCK",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    remoteListingId,
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        inventory: { resolution: "RESOLVED", targetQuantity: 0 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me11", "UPDATE_STOCK", payload, listingId);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await assert.rejects(
    async () => executor.execute(syncJob, payload),
    /Read-after-write verification failed for UPDATE_STOCK/
  );

  const variant = await prisma.marketplaceListingVariant.findFirst({
    where: { listingId, sourceSkuId: fixtures.sourceSkuId1 },
  });
  assert.equal(variant?.lastKnownDestinationStock, 50, "Stock must NOT be overwritten on mismatch");

  const listing = await prisma.marketplaceListing.findUnique({ where: { id: listingId } });
  assert.equal(listing?.status, "NEEDS_REVIEW");
});

// --------------------------------------------------------------------------
// ME-12: UPDATE IS IDEMPOTENT ABSOLUTE INTENT
// --------------------------------------------------------------------------
test("ME-12: UPDATE is idempotent absolute intent (repeated execution sets absolute target value, never additive)", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const remoteListingId = `${NS}rem_me12`;

  testGateway.createdListings.set(remoteListingId, {
    remoteListingId,
    variants: [{ destinationSku: fixtures.destSku1, priceIdr: 100000, stock: 20 }],
  });

  const priceCommand: UpdatePriceCommand = {
    schemaVersion: 1,
    operationType: "UPDATE_PRICE",
    marketplace: "shopee",
    sellerAccountKey: fixtures.sellerAccountKey,
    idempotencyKey: "test_idemp_key_12",
    remoteListingId,
    variants: [{ sourceSkuId: fixtures.sourceSkuId1, destinationSku: fixtures.destSku1, targetPriceIdr: 150000 }],
  };

  // Run updatePrice 3 times
  await testGateway.updatePrice(priceCommand);
  await testGateway.updatePrice(priceCommand);
  await testGateway.updatePrice(priceCommand);

  const finalState = testGateway.createdListings.get(remoteListingId);
  assert.equal(finalState?.variants[0]?.priceIdr, 150000, "Price is absolute target, not additive");
});

// --------------------------------------------------------------------------
// ME-13: QUEUE PAYLOAD REMAINS MINIMAL
// --------------------------------------------------------------------------
test("ME-13: Queue payload in BullMQ remains strictly minimal { schemaVersion: 1, syncJobId }", async () => {
  const { queueName, queue } = createIsolatedQueue("me13");

  try {
    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Minimal Queue Test",
      preparedDescription: "Very long description that should not be in Redis...",
      targetCategoryId: "cat_min",
      images: [{ url: "https://img.jakmall.com/large.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { size: "XL" },
          targetPriceIdr: 99000,
          inventory: { resolution: "RESOLVED", targetQuantity: 10 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me13", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id);

    assert.deepEqual(job.data, {
      schemaVersion: 1,
      syncJobId: syncJob.id,
    });

    const jobDataRecord = job.data as unknown as Record<string, unknown>;
    assert.equal(jobDataRecord["preparedTitle"], undefined);
    assert.equal(jobDataRecord["variants"], undefined);
  } finally {
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-14: NO CREDENTIAL LEAKAGE IN COMMANDS OR VERIFY_MISMATCH EVENTS
// --------------------------------------------------------------------------
test("ME-14: No credential leakage in normalized commands or VERIFY_MISMATCH events", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const forbiddenTokens = [
    "partnerKey",
    "accessToken",
    "refreshToken",
    "password",
    "authorization",
    "cookie",
    "session",
    "credentials",
    "privateKey",
    "clientSecret",
  ];

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Clean Command Item",
    preparedDescription: "Clean Description",
    targetCategoryId: "cat_clean",
    images: [{ url: "https://img.jakmall.com/clean.jpg" }],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: fixtures.destSku1,
        attributes: { clean: "yes" },
        targetPriceIdr: 10000,
        inventory: { resolution: "RESOLVED", targetQuantity: 1 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me14", "CREATE_LISTING", payload);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);

  await executor.execute(syncJob, payload);

  // 1. Inspect command JSON
  const command = testGateway.createCalls[0]!;
  const commandStr = JSON.stringify(command);

  for (const token of forbiddenTokens) {
    assert.equal(commandStr.toLowerCase().includes(token.toLowerCase()), false, `Command contains forbidden token: ${token}`);
  }

  // 2. Trigger VERIFY_MISMATCH and inspect persisted event payload
  testGateway.readOverride = (id) => ({
    remoteListingId: id,
    title: "Mismatch Title",
    variants: [{ destinationSku: fixtures.destSku1, priceIdr: 99999, stock: 1 }],
  });

  const mismatchPayload: CreateListingExecutionPayload = {
    ...payload,
    preparedTitle: "Expected Title",
  };
  const mismatchSyncJob = await createSyncJobFixture(prisma, "me14_mismatch", "CREATE_LISTING", mismatchPayload);
  await assert.rejects(async () => executor.execute(mismatchSyncJob, mismatchPayload));

  const mismatchEvent = await prisma.syncEvent.findFirst({
    where: { syncJobId: mismatchSyncJob.id, eventType: "VERIFY_MISMATCH" },
  });
  assert.ok(mismatchEvent, "VERIFY_MISMATCH event must be persisted");
  const eventPayloadStr = JSON.stringify(mismatchEvent.payload);
  for (const token of forbiddenTokens) {
    assert.equal(
      eventPayloadStr.toLowerCase().includes(token.toLowerCase()),
      false,
      `VERIFY_MISMATCH event payload contains forbidden token: ${token}`
    );
  }
});

// --------------------------------------------------------------------------
// ME-15: GATEWAY ERROR SANITIZATION
// --------------------------------------------------------------------------
test("ME-15: Gateway error containing fake credentials is fully sanitized in worker failure handling", async () => {
  const { queueName, queue } = createIsolatedQueue("me15");
  const queueEvents = createIsolatedEvents(queueName);
  let worker: SyncExecutionWorker | undefined;

  try {
    const testGateway = new TestSimulatedMarketplaceGateway("shopee");
    const dummySecret = "secret_access_token_xyz_9988";
    testGateway.throwOnMutation = new Error(`Shopee gateway network error Bearer ${dummySecret} failed.`);

    const registry = new MarketplaceGatewayRegistry();
    registry.registerGateway(testGateway);

    const payload: CreateListingExecutionPayload = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceSnapshotId: fixtures.sourceSnapshotId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      preparedTitle: "Secret Test Item",
      preparedDescription: "Desc",
      targetCategoryId: "cat_sec",
      images: [{ url: "https://img.jakmall.com/sec.jpg" }],
      variants: [
        {
          sourceSkuId: fixtures.sourceSkuId1,
          destinationSku: fixtures.destSku1,
          attributes: { a: "1" },
          targetPriceIdr: 50000,
          inventory: { resolution: "RESOLVED", targetQuantity: 2 },
        },
      ],
    };

    const syncJob = await createSyncJobFixture(prisma, "me15", "CREATE_LISTING", payload);
    const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

    const executor = new MarketplaceSyncJobExecutor(prisma, registry);
    worker = createIsolatedWorker(queueName, executor);

    await assert.rejects(async () => job.waitUntilFinished(queueEvents));

    const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
    assert.ok(failedJob);
    assert.equal(failedJob.status, "FAILED");
    assert.ok(!failedJob.lastErrorMessage?.includes(dummySecret), "Secret must be redacted from SyncJob.lastErrorMessage");

    const failedEvent = await prisma.syncEvent.findFirst({
      where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
    });
    assert.ok(failedEvent);
    const eventPayload = failedEvent.payload as { errorMessage?: string };
    assert.ok(!eventPayload?.errorMessage?.includes(dummySecret), "Secret must be redacted from SYNC_FAILED payload");
  } finally {
    await queueEvents.close();
    if (worker) await worker.close();
    await queue.rawQueue.obliterate({ force: true });
    await queue.close();
  }
});

// --------------------------------------------------------------------------
// ME-16: DURABLE PAYLOAD IMMUTABILITY
// --------------------------------------------------------------------------
test("ME-16: Durable executionPayload remains strictly immutable before and after execution", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Immutable Test Item",
    preparedDescription: "Original Description",
    targetCategoryId: "cat_imm",
    images: [{ url: "https://img.jakmall.com/imm.jpg" }],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: fixtures.destSku1,
        attributes: { imm: "1" },
        targetPriceIdr: 77000,
        inventory: { resolution: "RESOLVED", targetQuantity: 11 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me16", "CREATE_LISTING", payload);
  const beforePayload = JSON.parse(JSON.stringify(syncJob.executionPayload));

  const executor = new MarketplaceSyncJobExecutor(prisma, registry);
  await executor.execute(syncJob, payload);

  const afterJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.deepEqual(afterJob?.executionPayload, beforePayload, "executionPayload must remain deeply equal");
});

// --------------------------------------------------------------------------
// ME-17: SOURCE ZERO MUTATION
// --------------------------------------------------------------------------
test("ME-17: Source records (ProductSource, SourceSnapshot, SourceVariant) are zero-mutated by execution", async () => {
  const testGateway = new TestSimulatedMarketplaceGateway("shopee");
  const registry = new MarketplaceGatewayRegistry();
  registry.registerGateway(testGateway);

  const [psBefore, snapBefore, varsBefore] = await Promise.all([
    prisma.productSource.findUnique({ where: { id: fixtures.productSourceId } }),
    prisma.sourceSnapshot.findUnique({ where: { id: fixtures.sourceSnapshotId } }),
    prisma.sourceVariant.findMany({ where: { productSourceId: fixtures.productSourceId } }),
  ]);

  const payload: CreateListingExecutionPayload = {
    schemaVersion: 1,
    operationType: "CREATE_LISTING",
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    sourceSnapshotId: fixtures.sourceSnapshotId,
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    preparedTitle: "Source Immutability Test",
    preparedDescription: "Desc",
    targetCategoryId: "cat_src",
    images: [{ url: "https://img.jakmall.com/src.jpg" }],
    variants: [
      {
        sourceSkuId: fixtures.sourceSkuId1,
        destinationSku: fixtures.destSku1,
        attributes: { src: "test" },
        targetPriceIdr: 88000,
        inventory: { resolution: "RESOLVED", targetQuantity: 8 },
      },
    ],
  };

  const syncJob = await createSyncJobFixture(prisma, "me17", "CREATE_LISTING", payload);
  const executor = new MarketplaceSyncJobExecutor(prisma, registry);
  await executor.execute(syncJob, payload);

  const [psAfter, snapAfter, varsAfter] = await Promise.all([
    prisma.productSource.findUnique({ where: { id: fixtures.productSourceId } }),
    prisma.sourceSnapshot.findUnique({ where: { id: fixtures.sourceSnapshotId } }),
    prisma.sourceVariant.findMany({ where: { productSourceId: fixtures.productSourceId } }),
  ]);

  assert.deepEqual(psAfter, psBefore);
  assert.deepEqual(snapAfter, snapBefore);
  assert.deepEqual(varsAfter, varsBefore);
});

// --------------------------------------------------------------------------
// ME-18: CLEANUP
// --------------------------------------------------------------------------
test("ME-18: Cleanup removes all test queues and integration namespace rows", async () => {
  await cleanupPostgresNamespace(prisma);

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
  ]);

  assert.equal(productCount, 0);
  assert.equal(productSourceCount, 0);
  assert.equal(sourceVariantCount, 0);
  assert.equal(sourceSnapshotCount, 0);
  assert.equal(listingCount, 0);
  assert.equal(listingVariantCount, 0);
  assert.equal(syncJobCount, 0);
  assert.equal(syncEventCount, 0);
  assert.equal(idempCount, 0);

  // Assert 0 Redis keys matching test pattern remain
  const redisClient = createRedisConnection(redisUrl);
  try {
    const keys = await redisClient.keys("bull:phase4c3*");
    assert.equal(keys.length, 0, `Expected 0 Redis keys matching bull:phase4c3*, found: ${JSON.stringify(keys)}`);
  } finally {
    await redisClient.quit();
  }
});
