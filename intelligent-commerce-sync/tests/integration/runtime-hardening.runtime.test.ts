import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  SyncExecutionQueue,
  generateQueueJobId,
} from "../../src/queue/sync-queue.js";
import {
  getRedisUrl,
  parseRedisConnectionOptions,
} from "../../src/queue/connection.js";
import {
  RuntimeConfigurationError,
  type RuntimeConfig,
  type RuntimeClock,
} from "../../src/runtime/types.js";
import type { UpdatePriceExecutionPayload } from "../../src/execution/types.js";
import {
  parseRuntimeConfig,
  resolveRuntimeConfig,
  validateRuntimeConfig,
  validateBatchSize,
  DEFAULT_STALE_PROCESSING_MS,
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
} from "../../src/runtime/config.js";
import { RuntimeHealthService } from "../../src/runtime/health.js";
import { StaleProcessingRecoveryService } from "../../src/runtime/recovery.js";
import { DurableDispatchScheduler } from "../../src/runtime/scheduler.js";
import { RuntimeMaintenanceService } from "../../src/runtime/maintenance.js";
import { generateSyncOperationIdempotencyKey } from "../../src/sync/idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is required for runtime integration tests. " +
    "Example: DATABASE_URL='postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public'"
  );
}

const redisUrl = getRedisUrl();
const NS = "phase4c4_test_";

const fixtures = {
  productId: `${NS}prod_01`,
  productSourceId: `${NS}ps_01`,
  sourceProductId: `${NS}src_prod_01`,
  sourceSkuId1: `${NS}sku_01`,
  sourceSnapshotId1: `${NS}snap_01`,
  marketplaceListingId: `${NS}listing_01`,
  remoteListingId: `${NS}remote_01`,
  sellerAccountKey: `${NS}seller_main`,
  marketplace: "shopee",
  source: "jakmall",
  idempotencyRecordId: `${NS}idemp_rec_01`,
};

interface WorkerCloseable {
  close: () => Promise<void>;
}

const activeQueues: SyncExecutionQueue[] = [];
const activeWorkers: WorkerCloseable[] = [];
let prisma: PrismaClient;

function createIsolatedQueue(testSuffix: string): { queueName: string; queue: SyncExecutionQueue } {
  const queueName = `${NS}q_${testSuffix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const connection = parseRedisConnectionOptions(redisUrl);
  const queue = new SyncExecutionQueue(prisma, {
    queueName,
    connection,
  });
  activeQueues.push(queue);
  return { queueName, queue };
}

function registerWorker<W extends WorkerCloseable>(worker: W): W {
  activeWorkers.push(worker);
  return worker;
}

async function cleanupRedisTestQueues(): Promise<void> {
  // 1. Close all active workers first
  while (activeWorkers.length > 0) {
    const worker = activeWorkers.pop();
    if (worker) {
      await worker.close().catch(() => {});
    }
  }

  // 2. Obliterate and close all active queues
  while (activeQueues.length > 0) {
    const q = activeQueues.pop();
    if (q) {
      try {
        await q.rawQueue.obliterate({ force: true });
      } catch {
        // Queue may already be closed or empty
      }
      try {
        await q.close();
      } catch {
        // Queue may already be closed
      }
    }
  }

  // 3. Scan and delete any remaining keys matching bull:phase4c4_test_* or phase4c4_test_*
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "bull:phase4c4_test_*", "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");

    cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "phase4c4_test_*", "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } finally {
    await redis.quit().catch(() => {});
  }
}

async function cleanupPostgresNamespace(client: PrismaClient): Promise<void> {
  await client.auditLog.deleteMany({
    where: {
      entityType: "SyncJob",
      entityId: { startsWith: NS },
    },
  });

  await client.syncEvent.deleteMany({
    where: {
      OR: [
        { productSourceId: { startsWith: NS } },
        { marketplaceListingId: { startsWith: NS } },
        { sourceSnapshotId: { startsWith: NS } },
        { syncJob: { id: { startsWith: NS } } },
      ],
    },
  });

  await client.idempotencyRecord.deleteMany({
    where: {
      OR: [
        { id: { startsWith: NS } },
        { key: { contains: NS } },
        { productSourceId: { startsWith: NS } },
        { sellerAccountKey: { startsWith: NS } },
        { syncJobId: { startsWith: NS } },
      ],
    },
  });

  await client.syncJob.deleteMany({
    where: {
      OR: [
        { id: { startsWith: NS } },
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

async function createDatabaseFixtures(client: PrismaClient): Promise<void> {
  await client.product.create({
    data: { id: fixtures.productId },
  });

  await client.productSource.create({
    data: {
      id: fixtures.productSourceId,
      productId: fixtures.productId,
      source: fixtures.source,
      sourceProductId: fixtures.sourceProductId,
      sourceUrl: "https://www.jakmall.com/p/test-01",
    },
  });

  await client.sourceVariant.create({
    data: {
      id: `${NS}sv_01`,
      productSourceId: fixtures.productSourceId,
      sourceSkuId: fixtures.sourceSkuId1,
      attributes: { color: "Black" },
    },
  });

  await client.sourceSnapshot.create({
    data: {
      id: fixtures.sourceSnapshotId1,
      productSourceId: fixtures.productSourceId,
      sourceHash: "shash_01",
      contentHash: "chash_01",
      priceHash: "phash_01",
      inventoryHash: "ihash_01",
      variantHash: "vhash_01",
      canonicalPayload: {
        variants: [{ sourceSkuId: fixtures.sourceSkuId1 }],
      } as unknown as Prisma.InputJsonValue,
      sourceFetchedAt: new Date(),
    },
  });

  await client.marketplaceListing.create({
    data: {
      id: fixtures.marketplaceListingId,
      productId: fixtures.productId,
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      remoteListingId: fixtures.remoteListingId,
      status: "PUBLISHED",
    },
  });

  await client.marketplaceListingVariant.create({
    data: {
      id: `${NS}mlv_01`,
      listingId: fixtures.marketplaceListingId,
      sourceSkuId: fixtures.sourceSkuId1,
      destinationSku: `${NS}dest_01`,
      remoteVariantId: `${NS}rvar_01`,
    },
  });
}

async function createTestSyncJob(
  client: PrismaClient,
  idSuffix: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "NEEDS_REVIEW" | "BLOCKED" | "CANCELLED" = "PENDING",
  attemptCount = 0
) {
  const syncJobId = `${NS}job_${idSuffix}`;
  const idempKey = generateSyncOperationIdempotencyKey({
    marketplace: fixtures.marketplace,
    sellerAccountKey: fixtures.sellerAccountKey,
    source: fixtures.source,
    sourceProductId: fixtures.sourceProductId,
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: fixtures.sourceSnapshotId1,
  }) + `_${idSuffix}`;

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
        targetPriceIdr: 150000,
      },
    ],
  };

  return client.syncJob.create({
    data: {
      id: syncJobId,
      productSourceId: fixtures.productSourceId,
      marketplaceListingId: fixtures.marketplaceListingId,
      sourceSnapshotId: fixtures.sourceSnapshotId1,
      operationType: "UPDATE_PRICE",
      jobType: "PRICE_UPDATE",
      payloadVersion: 1,
      status,
      idempotencyKey: idempKey,
      executionPayload: payload as unknown as Prisma.InputJsonValue,
      attemptCount,
    },
  });
}

before(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  await cleanupRedisTestQueues();
  await cleanupPostgresNamespace(prisma);
  await createDatabaseFixtures(prisma);
});

after(async () => {
  await cleanupRedisTestQueues();
  if (prisma) {
    await cleanupPostgresNamespace(prisma);
    await prisma.$disconnect();
  }
});

// ============================================================================
// RT-01: Runtime Configuration Validation
// ============================================================================
test("RT-01: Runtime configuration defaults and strict boundary validation", () => {
  const { queue } = createIsolatedQueue("rt01");

  // Default parsing
  const defaultConfig = parseRuntimeConfig({});
  assert.equal(defaultConfig.staleProcessingMs, DEFAULT_STALE_PROCESSING_MS);
  assert.equal(defaultConfig.maintenanceIntervalMs, DEFAULT_MAINTENANCE_INTERVAL_MS);
  assert.equal(defaultConfig.batchSize, DEFAULT_BATCH_SIZE);

  // Valid env parsing
  const customConfig = parseRuntimeConfig({
    SYNC_RUNTIME_STALE_PROCESSING_MS: "120000",
    SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS: "15000",
    SYNC_RUNTIME_BATCH_SIZE: "25",
  });
  assert.equal(customConfig.staleProcessingMs, 120000);
  assert.equal(customConfig.maintenanceIntervalMs, 15000);
  assert.equal(customConfig.batchSize, 25);

  // Stale threshold below minimum (< 60000)
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_STALE_PROCESSING_MS: "59999" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Stale threshold negative
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_STALE_PROCESSING_MS: "-100" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Stale threshold non-integer
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_STALE_PROCESSING_MS: "60000.5" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Maintenance interval below minimum (< 1000)
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS: "999" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Batch size below minimum (< 1)
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_BATCH_SIZE: "0" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Batch size above maximum (> 500)
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_BATCH_SIZE: "501" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Blank string "" and whitespace-only "   " must fail closed
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_STALE_PROCESSING_MS: "" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_STALE_PROCESSING_MS: "   " }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS: "" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS: " \t " }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_BATCH_SIZE: "" }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => parseRuntimeConfig({ SYNC_RUNTIME_BATCH_SIZE: "   " }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Undefined env vars cleanly fall back to production defaults
  const undefinedConfig = parseRuntimeConfig({
    SYNC_RUNTIME_STALE_PROCESSING_MS: undefined,
    SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS: undefined,
    SYNC_RUNTIME_BATCH_SIZE: undefined,
  });
  assert.equal(undefinedConfig.staleProcessingMs, DEFAULT_STALE_PROCESSING_MS);
  assert.equal(undefinedConfig.maintenanceIntervalMs, DEFAULT_MAINTENANCE_INTERVAL_MS);
  assert.equal(undefinedConfig.batchSize, DEFAULT_BATCH_SIZE);

  // Test validateRuntimeConfig direct object validation
  assert.throws(
    () => validateRuntimeConfig({ staleProcessingMs: 1000 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => validateRuntimeConfig({ maintenanceIntervalMs: 500 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => validateRuntimeConfig({ batchSize: 0 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => validateRuntimeConfig({ batchSize: 501 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => validateRuntimeConfig(null),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Test service constructor validation rejection on injected invalid configs
  assert.throws(
    () => new StaleProcessingRecoveryService(prisma, queue, { config: { staleProcessingMs: 1000, maintenanceIntervalMs: 30000, batchSize: 50 } }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => new DurableDispatchScheduler(prisma, queue, { config: { staleProcessingMs: 60000, maintenanceIntervalMs: 30000, batchSize: 0 } }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => new RuntimeHealthService(prisma, queue, { config: { staleProcessingMs: 60000, maintenanceIntervalMs: 500, batchSize: 50 } }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.throws(
    () => new RuntimeMaintenanceService(prisma, queue, { config: { staleProcessingMs: -5, maintenanceIntervalMs: 30000, batchSize: 50 } }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  // Test per-call batchSize validation
  assert.throws(() => validateBatchSize(0, 50), (err: unknown) => err instanceof RuntimeConfigurationError);
  assert.throws(() => validateBatchSize(-1, 50), (err: unknown) => err instanceof RuntimeConfigurationError);
  assert.throws(() => validateBatchSize(1.5, 50), (err: unknown) => err instanceof RuntimeConfigurationError);
  assert.throws(() => validateBatchSize(501, 50), (err: unknown) => err instanceof RuntimeConfigurationError);

  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  assert.rejects(
    () => recovery.recoverStaleJobs({ batchSize: 0 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => recovery.recoverStaleJobs({ batchSize: -5 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => recovery.recoverStaleJobs({ batchSize: 1.5 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => recovery.recoverStaleJobs({ batchSize: 501 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );

  const scheduler = new DurableDispatchScheduler(prisma, queue);
  assert.rejects(
    () => scheduler.dispatchPendingJobs({ batchSize: 0 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => scheduler.dispatchPendingJobs({ batchSize: -1 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => scheduler.dispatchPendingJobs({ batchSize: 1.5 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
  assert.rejects(
    () => scheduler.dispatchPendingJobs({ batchSize: 501 }),
    (err: unknown) => err instanceof RuntimeConfigurationError
  );
});

// ============================================================================
// RT-02: Aggregated Health Status & Subcases
// ============================================================================
test("RT-02: Aggregated runtime health classification coverage", async () => {
  const { queue } = createIsolatedQueue("rt02");
  const healthService = new RuntimeHealthService(prisma, queue, {
    redisUrl,
  });

  // Subcase A: Healthy infrastructure + staleProcessing = 0 -> HEALTHY
  const healthySnapshot = await healthService.getHealthSnapshot();
  assert.equal(healthySnapshot.status, "HEALTHY");
  assert.equal(healthySnapshot.database.healthy, true);
  assert.equal(healthySnapshot.redis.healthy, true);
  assert.equal(healthySnapshot.queue.healthy, true);
  assert.equal(healthySnapshot.syncJobs?.staleProcessing, 0);

  // Subcase B: Healthy infrastructure + staleProcessing > 0 -> DEGRADED
  const staleJob = await createTestSyncJob(prisma, "rt02_stale", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${staleJob.id}`;

  const degradedSnapshot = await healthService.getHealthSnapshot();
  assert.equal(degradedSnapshot.status, "DEGRADED");
  assert.equal(degradedSnapshot.database.healthy, true);
  assert.equal(degradedSnapshot.redis.healthy, true);
  assert.equal(degradedSnapshot.queue.healthy, true);
  assert.ok((degradedSnapshot.syncJobs?.staleProcessing ?? 0) >= 1);

  // Cleanup the stale job
  await prisma.syncJob.delete({ where: { id: staleJob.id } });

  // Subcase C: Database probe failure -> UNHEALTHY
  const dbFailService = new RuntimeHealthService(prisma, queue, {
    probes: { checkDatabase: async () => false },
  });
  const dbFailSnapshot = await dbFailService.getHealthSnapshot();
  assert.equal(dbFailSnapshot.status, "UNHEALTHY");
  assert.equal(dbFailSnapshot.database.healthy, false);

  // Subcase D: Redis probe failure -> UNHEALTHY
  const redisFailService = new RuntimeHealthService(prisma, queue, {
    probes: { checkRedis: async () => false },
  });
  const redisFailSnapshot = await redisFailService.getHealthSnapshot();
  assert.equal(redisFailSnapshot.status, "UNHEALTHY");
  assert.equal(redisFailSnapshot.redis.healthy, false);

  // Subcase E: Queue inspection failure -> UNHEALTHY
  const queueFailService = new RuntimeHealthService(prisma, queue, {
    probes: { checkQueue: async () => ({ healthy: false }) },
  });
  const queueFailSnapshot = await queueFailService.getHealthSnapshot();
  assert.equal(queueFailSnapshot.status, "UNHEALTHY");
  assert.equal(queueFailSnapshot.queue.healthy, false);

  // Subcase F: Base DB probe succeeds, but SyncJob metrics inspection fails -> UNHEALTHY, zero raw error leaked
  const metricsFailService = new RuntimeHealthService(prisma, queue, {
    probes: {
      checkDatabase: async () => true,
      checkRedis: async () => true,
      checkQueue: async () => ({ healthy: true }),
      checkSyncJobsMetrics: async () => null,
    },
  });
  const metricsFailSnapshot = await metricsFailService.getHealthSnapshot();
  assert.equal(metricsFailSnapshot.status, "UNHEALTHY");
  assert.equal(metricsFailSnapshot.database.healthy, true);
  assert.equal(metricsFailSnapshot.redis.healthy, true);
  assert.equal(metricsFailSnapshot.queue.healthy, true);
  assert.equal(metricsFailSnapshot.syncJobs, undefined);
  const snapshotStr = JSON.stringify(metricsFailSnapshot);
  assert.ok(!snapshotStr.includes("error"));
});

// ============================================================================
// RT-03: Zero Credentials / Secrets in Health Snapshot
// ============================================================================
test("RT-03: Health snapshot contains zero connection strings, credentials, or raw URLs", async () => {
  const { queue } = createIsolatedQueue("rt03");
  const healthService = new RuntimeHealthService(prisma, queue, {
    redisUrl,
  });

  const snapshot = await healthService.getHealthSnapshot();
  const snapshotString = JSON.stringify(snapshot);

  assert.equal(snapshotString.includes("postgres"), false);
  assert.equal(snapshotString.includes("password"), false);
  assert.equal(snapshotString.includes("redis://"), false);
  assert.equal(snapshotString.includes(":5432"), false);
  assert.equal(snapshotString.includes(":6379"), false);
});

// ============================================================================
// RT-04: Dispatch PENDING Job with Missing Queue Job
// ============================================================================
test("RT-04: Scheduler dispatches PENDING job with missing queue job into BullMQ", async () => {
  const { queue } = createIsolatedQueue("rt04");
  const job = await createTestSyncJob(prisma, "rt04", "PENDING");

  const scheduler = new DurableDispatchScheduler(prisma, queue);
  const res = await scheduler.dispatchPendingJobs();

  assert.equal(res.dispatchedCount, 1);
  const item = res.items.find((i) => i.syncJobId === job.id);
  assert.equal(item?.outcome, "DISPATCHED");

  const expectedQueueJobId = generateQueueJobId(job.idempotencyKey);
  const bullJob = await queue.getJob(expectedQueueJobId);
  assert.ok(bullJob);
  assert.equal(bullJob.id, expectedQueueJobId);

  // Subcase: Hostile error thrown during dispatch is sanitized
  const hostileJob = await createTestSyncJob(prisma, "rt04_hostile", "PENDING");
  const origEnqueue = queue.enqueueSyncJob.bind(queue);
  queue.enqueueSyncJob = async () => {
    throw new Error(
      "postgresql://user:super_secret_password@localhost:5432/db " +
      "redis://default:redis_secret@localhost:6379 " +
      "Authorization: Bearer fake_secret_token access_token=fake_secret"
    );
  };

  try {
    const hostileRes = await scheduler.dispatchPendingJobs();
    const hostileItem = hostileRes.items.find((i) => i.syncJobId === hostileJob.id);
    assert.equal(hostileItem?.outcome, "ERROR");
    assert.ok(hostileItem?.error);
    assert.ok(!hostileItem.error.includes("super_secret_password"));
    assert.ok(!hostileItem.error.includes("redis_secret"));
    assert.ok(!hostileItem.error.includes("fake_secret_token"));
    assert.ok(!hostileItem.error.includes("fake_secret"));
    assert.ok(hostileItem.error.includes("[REDACTED]"));
  } finally {
    queue.enqueueSyncJob = origEnqueue;
    await prisma.syncJob.deleteMany({
      where: { id: { in: [job.id, hostileJob.id] } },
    });
  }
});

// ============================================================================
// RT-05: Repeated Dispatch Cycles are Idempotent
// ============================================================================
test("RT-05: Repeated scheduler dispatch cycles are idempotent (ALREADY_QUEUED)", async () => {
  const { queue } = createIsolatedQueue("rt05");
  const job = await createTestSyncJob(prisma, "rt05", "PENDING");

  const scheduler = new DurableDispatchScheduler(prisma, queue);

  const res1 = await scheduler.dispatchPendingJobs();
  const item1 = res1.items.find((i) => i.syncJobId === job.id);
  assert.equal(item1?.outcome, "DISPATCHED");

  const res2 = await scheduler.dispatchPendingJobs();
  const item2 = res2.items.find((i) => i.syncJobId === job.id);
  assert.equal(item2?.outcome, "ALREADY_QUEUED");
  assert.equal(res2.dispatchedCount, 0);
  assert.equal(res2.alreadyQueuedCount, 1);

  await prisma.syncJob.delete({ where: { id: job.id } });
});

// ============================================================================
// RT-06: Two Scheduler Instances Racing Same PENDING Job
// ============================================================================
test("RT-06: Two scheduler instances racing same PENDING job result in one BullMQ job", async () => {
  const { queue } = createIsolatedQueue("rt06");
  const job = await createTestSyncJob(prisma, "rt06", "PENDING");

  const scheduler1 = new DurableDispatchScheduler(prisma, queue);
  const scheduler2 = new DurableDispatchScheduler(prisma, queue);

  const [res1, res2] = await Promise.all([
    scheduler1.dispatchPendingJobs(),
    scheduler2.dispatchPendingJobs(),
  ]);

  const outcomes = [
    res1.items.find((i) => i.syncJobId === job.id)?.outcome,
    res2.items.find((i) => i.syncJobId === job.id)?.outcome,
  ];

  assert.ok(outcomes.includes("DISPATCHED"));
  assert.ok(outcomes.includes("ALREADY_QUEUED") || outcomes.includes("DISPATCHED"));

  const expectedQueueJobId = generateQueueJobId(job.idempotencyKey);
  const bullJob = await queue.getJob(expectedQueueJobId);
  assert.ok(bullJob);
});

// ============================================================================
// RT-07: PENDING Job with In-Flight Queue States (Waiting, Delayed, Active, Prioritized, Conflict)
// ============================================================================
test("RT-07: Scheduler skips jobs already WAITING, DELAYED, ACTIVE, or PRIORITIZED and fails closed on conflicts", async () => {
  const { queue } = createIsolatedQueue("rt07");
  const scheduler = new DurableDispatchScheduler(prisma, queue);

  // Subcase 1: waiting -> ALREADY_QUEUED
  const jobWait = await createTestSyncJob(prisma, "rt07_wait", "PENDING");
  await queue.enqueueSyncJob(jobWait.id);
  const resWait = await scheduler.dispatchPendingJobs();
  assert.equal(resWait.items.find((i) => i.syncJobId === jobWait.id)?.outcome, "ALREADY_QUEUED");

  // Subcase 2: delayed -> ALREADY_QUEUED
  const jobDelayed = await createTestSyncJob(prisma, "rt07_del", "PENDING");
  await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobDelayed.id },
    { jobId: generateQueueJobId(jobDelayed.idempotencyKey), delay: 60000 }
  );
  const resDel = await scheduler.dispatchPendingJobs();
  assert.equal(resDel.items.find((i) => i.syncJobId === jobDelayed.id)?.outcome, "ALREADY_QUEUED");

  // Subcase 3: active -> ALREADY_QUEUED (via controlled state probe on bullJob)
  const jobActive = await createTestSyncJob(prisma, "rt07_act", "PENDING");
  const bullJobActive = await queue.enqueueSyncJob(jobActive.id);
  bullJobActive.getState = async () => "active";
  const origGetJob = queue.getJob.bind(queue);
  queue.getJob = async (id: string) => {
    if (id === bullJobActive.id) return bullJobActive;
    return origGetJob(id);
  };
  const resAct = await scheduler.dispatchPendingJobs();
  assert.equal(resAct.items.find((i) => i.syncJobId === jobActive.id)?.outcome, "ALREADY_QUEUED");
  queue.getJob = origGetJob;

  // Subcase 4: prioritized -> ALREADY_QUEUED (via controlled state probe on bullJob)
  const jobPrio = await createTestSyncJob(prisma, "rt07_prio", "PENDING");
  const bullJobPrio = await queue.enqueueSyncJob(jobPrio.id);
  bullJobPrio.getState = async () => "prioritized";
  queue.getJob = async (id: string) => {
    if (id === bullJobPrio.id) return bullJobPrio;
    return origGetJob(id);
  };
  const resPrio = await scheduler.dispatchPendingJobs();
  assert.equal(resPrio.items.find((i) => i.syncJobId === jobPrio.id)?.outcome, "ALREADY_QUEUED");
  queue.getJob = origGetJob;

  // Subcase 5: waiting-children -> CONFLICT_NEEDS_REVIEW
  const jobChild = await createTestSyncJob(prisma, "rt07_child", "PENDING");
  const bullJobChild = await queue.enqueueSyncJob(jobChild.id);
  bullJobChild.getState = async () => "waiting-children";
  queue.getJob = async (id: string) => {
    if (id === bullJobChild.id) return bullJobChild;
    return origGetJob(id);
  };
  const resChild = await scheduler.dispatchPendingJobs();
  assert.equal(resChild.items.find((i) => i.syncJobId === jobChild.id)?.outcome, "CONFLICT_NEEDS_REVIEW");
  const childJobDb = await prisma.syncJob.findUnique({ where: { id: jobChild.id } });
  assert.equal(childJobDb?.status, "NEEDS_REVIEW");
  queue.getJob = origGetJob;

  // Subcase 6: unknown -> CONFLICT_NEEDS_REVIEW
  const jobUnknown = await createTestSyncJob(prisma, "rt07_unk", "PENDING");
  const bullJobUnknown = await queue.enqueueSyncJob(jobUnknown.id);
  (bullJobUnknown as { getState: () => Promise<string> }).getState = async () => "unknown_status";
  queue.getJob = async (id: string) => {
    if (id === bullJobUnknown.id) return bullJobUnknown;
    return origGetJob(id);
  };
  const resUnk = await scheduler.dispatchPendingJobs();
  assert.equal(resUnk.items.find((i) => i.syncJobId === jobUnknown.id)?.outcome, "CONFLICT_NEEDS_REVIEW");
  const unkJobDb = await prisma.syncJob.findUnique({ where: { id: jobUnknown.id } });
  assert.equal(unkJobDb?.status, "NEEDS_REVIEW");
  queue.getJob = origGetJob;
});

// ============================================================================
// RT-08: PENDING Job with FAILED BullMQ Job & Concurrent Retry
// ============================================================================
test("RT-08: Scheduler safely retries FAILED BullMQ job and handles concurrent retry race", async () => {
  const { queue } = createIsolatedQueue("rt08");
  const job = await createTestSyncJob(prisma, "rt08", "PENDING");
  const bullJob = await queue.enqueueSyncJob(job.id, { attempts: 1 });

  // Transition BullMQ job to failed using a worker
  const worker1 = registerWorker(
    new Worker(
      queue.rawQueue.name,
      async () => {
        throw new Error("Simulated failure");
      },
      { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
    )
  );
  await new Promise<void>((resolve) => worker1.once("failed", () => resolve()));
  await worker1.close();

  const failedState = await bullJob.getState();
  assert.equal(failedState, "failed");

  const scheduler = new DurableDispatchScheduler(prisma, queue);
  const res = await scheduler.dispatchPendingJobs();
  const item = res.items.find((i) => i.syncJobId === job.id);
  assert.equal(item?.outcome, "RETRIED");

  const retriedState = await bullJob.getState();
  // Subcase 2: Concurrent retry race between two schedulers on isolated queue
  const { queue: queue2 } = createIsolatedQueue("rt08_b");
  const job2 = await createTestSyncJob(prisma, "rt08_b", "PENDING");
  const bullJob2 = await queue2.enqueueSyncJob(job2.id, { attempts: 1 });

  const worker2 = registerWorker(
    new Worker(
      queue2.rawQueue.name,
      async () => {
        throw new Error("Simulated second failure");
      },
      { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
    )
  );
  await new Promise<void>((resolve) => worker2.once("failed", () => resolve()));
  await worker2.close();

  const failedState2 = await bullJob2.getState();
  assert.equal(failedState2, "failed");

  const scheduler1 = new DurableDispatchScheduler(prisma, queue2);
  const scheduler2 = new DurableDispatchScheduler(prisma, queue2);

  const [res1, res2] = await Promise.all([
    scheduler1.dispatchPendingJobs(),
    scheduler2.dispatchPendingJobs(),
  ]);

  const outcomes = [
    res1.items.find((i) => i.syncJobId === job2.id)?.outcome,
    res2.items.find((i) => i.syncJobId === job2.id)?.outcome,
  ];

  assert.ok(outcomes.includes("RETRIED"));
  assert.ok(outcomes.includes("ALREADY_QUEUED") || outcomes.includes("RETRIED"));

  const finalState2 = await bullJob2.getState();
  assert.equal(finalState2, "waiting");

  // Subcase 3: retry throws + re-read waiting-children -> CONFLICT_NEEDS_REVIEW -> DB NEEDS_REVIEW
  const { queue: queue3 } = createIsolatedQueue("rt08_c");
  const job3 = await createTestSyncJob(prisma, "rt08_c", "PENDING");
  const bullJob3 = await queue3.enqueueSyncJob(job3.id);
  bullJob3.getState = async () => "failed";
  bullJob3.retry = async () => {
    bullJob3.getState = async () => "waiting-children";
    throw new Error("Simulated concurrent retry conflict");
  };
  const origGetJob3 = queue3.getJob.bind(queue3);
  queue3.getJob = async (id: string) => {
    if (id === bullJob3.id) return bullJob3;
    return origGetJob3(id);
  };
  const scheduler3 = new DurableDispatchScheduler(prisma, queue3);
  const res3 = await scheduler3.dispatchPendingJobs();
  const item3 = res3.items.find((i) => i.syncJobId === job3.id);
  assert.equal(item3?.outcome, "CONFLICT_NEEDS_REVIEW");
  const job3Db = await prisma.syncJob.findUnique({ where: { id: job3.id } });
  assert.equal(job3Db?.status, "NEEDS_REVIEW");
  queue3.getJob = origGetJob3;

  // Subcase 4: retry throws + re-read unknown -> CONFLICT_NEEDS_REVIEW -> DB NEEDS_REVIEW
  const { queue: queue4 } = createIsolatedQueue("rt08_d");
  const job4 = await createTestSyncJob(prisma, "rt08_d", "PENDING");
  const bullJob4 = await queue4.enqueueSyncJob(job4.id);
  bullJob4.getState = async () => "failed";
  bullJob4.retry = async () => {
    (bullJob4 as { getState: () => Promise<string> }).getState = async () => "unrecognized_state";
    throw new Error("Simulated concurrent retry conflict with unknown state");
  };
  const origGetJob4 = queue4.getJob.bind(queue4);
  queue4.getJob = async (id: string) => {
    if (id === bullJob4.id) return bullJob4;
    return origGetJob4(id);
  };
  const scheduler4 = new DurableDispatchScheduler(prisma, queue4);
  const res4 = await scheduler4.dispatchPendingJobs();
  const item4 = res4.items.find((i) => i.syncJobId === job4.id);
  assert.equal(item4?.outcome, "CONFLICT_NEEDS_REVIEW");
  const job4Db = await prisma.syncJob.findUnique({ where: { id: job4.id } });
  assert.equal(job4Db?.status, "NEEDS_REVIEW");
  queue4.getJob = origGetJob4;
});

// ============================================================================
// RT-09: PENDING Job with COMPLETED BullMQ Job (Conflict Detection)
// ============================================================================
test("RT-09: Scheduler transitions PENDING job with COMPLETED BullMQ job to NEEDS_REVIEW", async () => {
  const { queue } = createIsolatedQueue("rt09");
  const job = await createTestSyncJob(prisma, "rt09", "PENDING");
  const bullJob = await queue.enqueueSyncJob(job.id);

  // Complete the BullMQ job using a worker
  const worker = registerWorker(
    new Worker(
      queue.rawQueue.name,
      async () => {
        return "done";
      },
      { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
    )
  );
  await new Promise<void>((resolve) => worker.once("completed", () => resolve()));
  await worker.close();

  const completedState = await bullJob.getState();
  assert.equal(completedState, "completed");

  const scheduler = new DurableDispatchScheduler(prisma, queue);
  const res = await scheduler.dispatchPendingJobs();
  const item = res.items.find((i) => i.syncJobId === job.id);

  assert.equal(item?.outcome, "CONFLICT_NEEDS_REVIEW");

  // SyncJob transitioned to NEEDS_REVIEW
  const conflictJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
  assert.equal(conflictJob?.status, "NEEDS_REVIEW");
  assert.equal(conflictJob?.lastErrorCode, "QUEUE_STATE_CONFLICT");

  // AuditLog created
  const auditLog = await prisma.auditLog.findFirst({
    where: {
      entityId: job.id,
      action: "QUEUE_STATE_CONFLICT_NEEDS_REVIEW",
    },
  });
  assert.ok(auditLog);
  assert.equal(auditLog.actorType, "SYSTEM");
  assert.equal(auditLog.actorId, "phase4c4-runtime-maintenance");
});

// ============================================================================
// RT-10: Fresh PROCESSING Job Ignored by Recovery
// ============================================================================
test("RT-10: Fresh PROCESSING job is never treated as stale by recovery", async () => {
  const { queue } = createIsolatedQueue("rt10");
  const job = await createTestSyncJob(prisma, "rt10", "PROCESSING");

  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  const res = await recovery.recoverStaleJobs();

  assert.equal(res.candidatesExamined, 0);
  assert.equal(res.recoveredCount, 0);

  const stillProcessing = await prisma.syncJob.findUnique({ where: { id: job.id } });
  assert.equal(stillProcessing?.status, "PROCESSING");
});

// ============================================================================
// RT-11: Stale PROCESSING with ACTIVE BullMQ Job (Skipped)
// ============================================================================
test("RT-11: Stale PROCESSING job with active BullMQ job is skipped (SKIPPED_ACTIVE)", async () => {
  const { queue } = createIsolatedQueue("rt11");
  const job = await createTestSyncJob(prisma, "rt11", "PROCESSING");

  // Backdate DB updatedAt older than 5-minute cutoff
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${job.id}`;

  const bullJobId = generateQueueJobId(job.idempotencyKey);
  const bullJob = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: job.id },
    { jobId: bullJobId }
  );

  let unblockProcessor: (() => void) | undefined;
  const workerEnteredPromise = new Promise<void>((resolveEntered) => {
    const processorBlockedPromise = new Promise<void>((resolveDone) => {
      unblockProcessor = resolveDone;
    });

    registerWorker(
      new Worker(
        queue.rawQueue.name,
        async () => {
          resolveEntered();
          await processorBlockedPromise;
          return { done: true };
        },
        { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
      )
    );
  });

  // Wait until worker enters processor and job transitions to active
  await workerEnteredPromise;

  try {
    const realState = await bullJob.getState();
    assert.equal(realState, "active");

    const recovery = new StaleProcessingRecoveryService(prisma, queue);
    const res = await recovery.recoverStaleJobs();
    const item = res.items.find((i) => i.syncJobId === job.id);

    assert.equal(item?.outcome, "SKIPPED_ACTIVE");

    const stillProcessing = await prisma.syncJob.findUnique({ where: { id: job.id } });
    assert.equal(stillProcessing?.status, "PROCESSING");

    // Zero RECOVER_STALE_SYNC_JOB AuditLog
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityType: "SyncJob",
        entityId: job.id,
        action: "RECOVER_STALE_SYNC_JOB",
      },
    });
    assert.equal(auditLogs.length, 0);

    // Zero recovery SYNC_FAILED event
    const events = await prisma.syncEvent.findMany({
      where: {
        syncJobId: job.id,
        eventType: "SYNC_FAILED",
      },
    });
    const recoveryEvents = events.filter((e) => {
      const payload = e.payload as Record<string, unknown> | null;
      return payload?.errorCode === "STALE_PROCESSING_RECOVERED";
    });
    assert.equal(recoveryEvents.length, 0);
  } finally {
    unblockProcessor?.();
    await cleanupRedisTestQueues();
    await prisma.syncJob.delete({ where: { id: job.id } });
  }
});

// ============================================================================
// RT-12: Stale PROCESSING with Missing BullMQ Job & Complete Crash Window
// ============================================================================
test("RT-12: Stale PROCESSING job with missing queue job recovers to PENDING, preserves attemptCount, and scheduler dispatches", async () => {
  const { queue } = createIsolatedQueue("rt12");
  // Set attemptCount = 2 initially to prove attemptCount is preserved across recovery and scheduling
  const job = await createTestSyncJob(prisma, "rt12", "PROCESSING", 2);

  // Backdate DB updatedAt older than cutoff
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${job.id}`;

  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  const res = await recovery.recoverStaleJobs();
  const item = res.items.find((i) => i.syncJobId === job.id);

  assert.equal(item?.outcome, "RECOVERED");

  // DB transitions PROCESSING -> FAILED -> PENDING
  const recoveredJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
  assert.equal(recoveredJob?.status, "PENDING");
  assert.equal(recoveredJob?.attemptCount, 2); // attemptCount is UNCHANGED
  assert.equal(recoveredJob?.lastErrorCode, "STALE_PROCESSING_RECOVERED");
  assert.deepEqual(recoveredJob?.executionPayload, job.executionPayload); // payload unchanged

  // SYNC_FAILED event created with recovery metadata
  const event = await prisma.syncEvent.findFirst({
    where: {
      syncJobId: job.id,
      eventType: "SYNC_FAILED",
    },
  });
  assert.ok(event);
  const eventPayload = event.payload as Record<string, unknown>;
  assert.equal(eventPayload.errorCode, "STALE_PROCESSING_RECOVERED");
  assert.equal(eventPayload.recovery, true);

  // SYSTEM AuditLog created
  const auditLog = await prisma.auditLog.findFirst({
    where: {
      entityId: job.id,
      action: "RECOVER_STALE_SYNC_JOB",
    },
  });
  assert.ok(auditLog);
  assert.equal(auditLog.actorType, "SYSTEM");
  assert.equal(auditLog.actorId, "phase4c4-runtime-maintenance");

  // Test hostile error sanitization in recovery item result
  const hostileJob = await createTestSyncJob(prisma, "rt12_hostile", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${hostileJob.id}`;
  const origTx = prisma.$transaction.bind(prisma);
  prisma.$transaction = (async () => {
    throw new Error(
      "postgresql://user:super_secret_password@localhost:5432/db " +
      "redis://default:redis_secret@localhost:6379 " +
      "Authorization: Bearer fake_secret_token access_token=fake_secret"
    );
  }) as unknown as typeof prisma.$transaction;

  try {
    const hostileRes = await recovery.recoverStaleJobs();
    const hostileItem = hostileRes.items.find((i) => i.syncJobId === hostileJob.id);
    assert.equal(hostileItem?.outcome, "ERROR");
    assert.ok(hostileItem?.error);
    assert.ok(!hostileItem.error.includes("super_secret_password"));
    assert.ok(!hostileItem.error.includes("redis_secret"));
    assert.ok(!hostileItem.error.includes("fake_secret_token"));
    assert.ok(!hostileItem.error.includes("fake_secret"));
    assert.ok(hostileItem.error.includes("[REDACTED]"));
  } finally {
    prisma.$transaction = origTx;
    await prisma.syncJob.delete({ where: { id: hostileJob.id } });
  }

  // Crash-Window continuation: Run DurableDispatchScheduler on recovered job
  const scheduler = new DurableDispatchScheduler(prisma, queue);
  const dispatchRes = await scheduler.dispatchPendingJobs();
  const dispatchedItem = dispatchRes.items.find((i) => i.syncJobId === job.id);
  assert.equal(dispatchedItem?.outcome, "DISPATCHED");

  // BullMQ job ID equals generateQueueJobId(original idempotencyKey)
  const expectedQueueJobId = generateQueueJobId(job.idempotencyKey);
  assert.equal(dispatchedItem?.queueJobId, expectedQueueJobId);

  const bullJob = await queue.getJob(expectedQueueJobId);
  assert.ok(bullJob);
  assert.equal(bullJob.id, expectedQueueJobId);
  // Queue payload remains strictly minimal: { schemaVersion: 1, syncJobId }
  assert.deepEqual(bullJob.data, {
    schemaVersion: 1,
    syncJobId: job.id,
  });

  // Check attemptCount remains unchanged (2) until a worker actually claims the job
  const jobAfterDispatch = await prisma.syncJob.findUnique({ where: { id: job.id } });
  assert.equal(jobAfterDispatch?.status, "PENDING");
  assert.equal(jobAfterDispatch?.attemptCount, 2);
});

// ============================================================================
// RT-13: Stale PROCESSING Recovery Queue-State Coverage (Waiting, Delayed, Prioritized, Failed)
// ============================================================================
test("RT-13: Stale PROCESSING job with WAITING, DELAYED, PRIORITIZED, or FAILED queue jobs recovers to PENDING", async () => {
  const { queue } = createIsolatedQueue("rt13");
  const recovery = new StaleProcessingRecoveryService(prisma, queue);

  // Subcase 1: waiting queue state
  const jobWait = await createTestSyncJob(prisma, "rt13_wait", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobWait.id}`;
  const bullWait = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobWait.id },
    { jobId: generateQueueJobId(jobWait.idempotencyKey) }
  );
  assert.equal(await bullWait.getState(), "waiting");
  const resWait = await recovery.recoverStaleJobs();
  assert.equal(resWait.items.find((i) => i.syncJobId === jobWait.id)?.outcome, "RECOVERED");
  const waitRecovered = await prisma.syncJob.findUnique({ where: { id: jobWait.id } });
  assert.equal(waitRecovered?.status, "PENDING");

  // Subcase 2: delayed queue state
  const jobDel = await createTestSyncJob(prisma, "rt13_del", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobDel.id}`;
  const bullDel = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobDel.id },
    { jobId: generateQueueJobId(jobDel.idempotencyKey), delay: 60000 }
  );
  assert.equal(await bullDel.getState(), "delayed");
  const resDel = await recovery.recoverStaleJobs();
  assert.equal(resDel.items.find((i) => i.syncJobId === jobDel.id)?.outcome, "RECOVERED");
  const delRecovered = await prisma.syncJob.findUnique({ where: { id: jobDel.id } });
  assert.equal(delRecovered?.status, "PENDING");

  // Subcase 3: prioritized queue state (via controlled state probe)
  const jobPrio = await createTestSyncJob(prisma, "rt13_prio", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobPrio.id}`;
  const bullPrio = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobPrio.id },
    { jobId: generateQueueJobId(jobPrio.idempotencyKey) }
  );
  bullPrio.getState = async () => "prioritized";
  const origGetJob = queue.getJob.bind(queue);
  queue.getJob = async (id: string) => {
    if (id === bullPrio.id) return bullPrio;
    return origGetJob(id);
  };
  const resPrio = await recovery.recoverStaleJobs();
  assert.equal(resPrio.items.find((i) => i.syncJobId === jobPrio.id)?.outcome, "RECOVERED");
  const prioRecovered = await prisma.syncJob.findUnique({ where: { id: jobPrio.id } });
  assert.equal(prioRecovered?.status, "PENDING");
  queue.getJob = origGetJob;

  // Subcase 4: failed queue state
  const { queue: queueFail } = createIsolatedQueue("rt13_fail");
  const recoveryFail = new StaleProcessingRecoveryService(prisma, queueFail);
  const jobFail = await createTestSyncJob(prisma, "rt13_fail", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobFail.id}`;
  const bullFail = await queueFail.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobFail.id },
    { jobId: generateQueueJobId(jobFail.idempotencyKey), attempts: 1 }
  );
  const workerFail = registerWorker(
    new Worker(
      queueFail.rawQueue.name,
      async () => {
        throw new Error("Worker failed");
      },
      { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
    )
  );
  await new Promise<void>((resolve) => workerFail.once("failed", () => resolve()));
  await workerFail.close();
  assert.equal(await bullFail.getState(), "failed");

  const resFail = await recoveryFail.recoverStaleJobs();
  assert.equal(resFail.items.find((i) => i.syncJobId === jobFail.id)?.outcome, "RECOVERED");
  const failRecovered = await prisma.syncJob.findUnique({ where: { id: jobFail.id } });
  assert.equal(failRecovered?.status, "PENDING");
});

// ============================================================================
// RT-14: Stale PROCESSING Recovery Conflict Paths (Completed, Waiting-Children, Unknown)
// ============================================================================
test("RT-14: Stale PROCESSING job with COMPLETED, WAITING-CHILDREN, or UNKNOWN BullMQ jobs transitions to NEEDS_REVIEW", async () => {
  const { queue } = createIsolatedQueue("rt14");
  const recovery = new StaleProcessingRecoveryService(prisma, queue);

  // Subcase 1: completed BullMQ job
  const jobComp = await createTestSyncJob(prisma, "rt14_comp", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobComp.id}`;
  await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobComp.id },
    { jobId: generateQueueJobId(jobComp.idempotencyKey) }
  );
  const worker = registerWorker(
    new Worker(
      queue.rawQueue.name,
      async () => "done",
      { connection: parseRedisConnectionOptions(redisUrl), concurrency: 1 }
    )
  );
  await new Promise<void>((resolve) => worker.once("completed", () => resolve()));
  await worker.close();

  const resComp = await recovery.recoverStaleJobs();
  assert.equal(resComp.items.find((i) => i.syncJobId === jobComp.id)?.outcome, "NEEDS_REVIEW");
  const conflictJobComp = await prisma.syncJob.findUnique({ where: { id: jobComp.id } });
  assert.equal(conflictJobComp?.status, "NEEDS_REVIEW");
  assert.equal(conflictJobComp?.lastErrorCode, "QUEUE_STATE_CONFLICT");

  // Subcase 2: waiting-children BullMQ job (via controlled state probe)
  const jobChild = await createTestSyncJob(prisma, "rt14_child", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobChild.id}`;
  const bullChild = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobChild.id },
    { jobId: generateQueueJobId(jobChild.idempotencyKey) }
  );
  bullChild.getState = async () => "waiting-children";
  const origGetJob = queue.getJob.bind(queue);
  queue.getJob = async (id: string) => {
    if (id === bullChild.id) return bullChild;
    return origGetJob(id);
  };
  const resChild = await recovery.recoverStaleJobs();
  assert.equal(resChild.items.find((i) => i.syncJobId === jobChild.id)?.outcome, "NEEDS_REVIEW");
  const conflictJobChild = await prisma.syncJob.findUnique({ where: { id: jobChild.id } });
  assert.equal(conflictJobChild?.status, "NEEDS_REVIEW");
  queue.getJob = origGetJob;

  // Subcase 3: unknown BullMQ job (via controlled state probe)
  const jobUnk = await createTestSyncJob(prisma, "rt14_unk", "PROCESSING");
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${jobUnk.id}`;
  const bullUnk = await queue.rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: jobUnk.id },
    { jobId: generateQueueJobId(jobUnk.idempotencyKey) }
  );
  (bullUnk as { getState: () => Promise<string> }).getState = async () => "unknown_status";
  queue.getJob = async (id: string) => {
    if (id === bullUnk.id) return bullUnk;
    return origGetJob(id);
  };
  const resUnk = await recovery.recoverStaleJobs();
  assert.equal(resUnk.items.find((i) => i.syncJobId === jobUnk.id)?.outcome, "NEEDS_REVIEW");
  const conflictJobUnk = await prisma.syncJob.findUnique({ where: { id: jobUnk.id } });
  assert.equal(conflictJobUnk?.status, "NEEDS_REVIEW");
  queue.getJob = origGetJob;
});

// ============================================================================
// RT-15: Concurrent Recovery Race on Same Stale PROCESSING Job
// ============================================================================
test("RT-15: Two recovery instances racing same stale job result in exactly one recovery and one skip", async () => {
  const { queue } = createIsolatedQueue("rt15");
  const job = await createTestSyncJob(prisma, "rt15", "PROCESSING");

  // Backdate DB updatedAt
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${job.id}`;

  const recovery1 = new StaleProcessingRecoveryService(prisma, queue);
  const recovery2 = new StaleProcessingRecoveryService(prisma, queue);

  const [res1, res2] = await Promise.all([
    recovery1.recoverStaleJobs(),
    recovery2.recoverStaleJobs(),
  ]);

  const outcomes = [
    res1.items.find((i) => i.syncJobId === job.id)?.outcome,
    res2.items.find((i) => i.syncJobId === job.id)?.outcome,
  ];

  assert.ok(outcomes.includes("RECOVERED"));
  assert.ok(outcomes.includes("CONCURRENT_SKIP"));

  // Exactly one AuditLog row created
  const auditLogs = await prisma.auditLog.findMany({
    where: {
      entityId: job.id,
      action: "RECOVER_STALE_SYNC_JOB",
    },
  });
  assert.equal(auditLogs.length, 1);

  // Exactly one SYNC_FAILED event created
  const events = await prisma.syncEvent.findMany({
    where: {
      syncJobId: job.id,
      eventType: "SYNC_FAILED",
    },
  });
  assert.equal(events.length, 1);
});

// ============================================================================
// RT-16: Non-PROCESSING States Never Stale Recovered
// ============================================================================
test("RT-16: Stale recovery never touches COMPLETED, CANCELLED, BLOCKED, or NEEDS_REVIEW jobs", async () => {
  const { queue } = createIsolatedQueue("rt16");
  const jobComp = await createTestSyncJob(prisma, "rt16_comp", "COMPLETED");
  const jobCanc = await createTestSyncJob(prisma, "rt16_canc", "CANCELLED");
  const jobBlock = await createTestSyncJob(prisma, "rt16_block", "BLOCKED");
  const jobReview = await createTestSyncJob(prisma, "rt16_review", "NEEDS_REVIEW");

  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id IN (${jobComp.id}, ${jobCanc.id}, ${jobBlock.id}, ${jobReview.id})`;

  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  const res = await recovery.recoverStaleJobs();

  assert.equal(res.candidatesExamined, 0);
  assert.equal(res.recoveredCount, 0);

  const checkComp = await prisma.syncJob.findUnique({ where: { id: jobComp.id } });
  const checkCanc = await prisma.syncJob.findUnique({ where: { id: jobCanc.id } });
  const checkBlock = await prisma.syncJob.findUnique({ where: { id: jobBlock.id } });
  const checkReview = await prisma.syncJob.findUnique({ where: { id: jobReview.id } });

  assert.equal(checkComp?.status, "COMPLETED");
  assert.equal(checkCanc?.status, "CANCELLED");
  assert.equal(checkBlock?.status, "BLOCKED");
  assert.equal(checkReview?.status, "NEEDS_REVIEW");
});

// ============================================================================
// RT-17: Byte/Semantic Equality of executionPayload Across Recovery
// ============================================================================
test("RT-17: Recovery preserves executionPayload byte-for-byte without mutation", async () => {
  const { queue } = createIsolatedQueue("rt17");
  const job = await createTestSyncJob(prisma, "rt17", "PROCESSING");

  const originalPayloadString = JSON.stringify(job.executionPayload);

  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${job.id}`;

  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  await recovery.recoverStaleJobs();

  const recoveredJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
  assert.ok(recoveredJob);
  const afterPayloadString = JSON.stringify(recoveredJob.executionPayload);

  assert.equal(afterPayloadString, originalPayloadString);
});

// ============================================================================
// RT-18: Zero-Mutation of Related Entities (Including IdempotencyRecord)
// ============================================================================
test("RT-18: Recovery zero-mutates Product, ProductSource, SourceVariant, SourceSnapshot, MarketplaceListing, MarketplaceListingVariant, and IdempotencyRecord", async () => {
  const { queue } = createIsolatedQueue("rt18");
  const job = await createTestSyncJob(prisma, "rt18", "PROCESSING");

  // Create an IdempotencyRecord tied to this sync job
  const idempRecord = await prisma.idempotencyRecord.create({
    data: {
      id: fixtures.idempotencyRecordId,
      key: `${NS}idemp_key_rt18`,
      operationType: "UPDATE_PRICE",
      status: "STARTED",
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      productSourceId: fixtures.productSourceId,
      syncJobId: job.id,
    },
  });

  // Capture before-snapshots of all 7 related entities
  const beforeProd = await prisma.product.findUnique({ where: { id: fixtures.productId } });
  const beforePs = await prisma.productSource.findUnique({ where: { id: fixtures.productSourceId } });
  const beforeSv = await prisma.sourceVariant.findUnique({ where: { id: `${NS}sv_01` } });
  const beforeSnap = await prisma.sourceSnapshot.findUnique({ where: { id: fixtures.sourceSnapshotId1 } });
  const beforeMl = await prisma.marketplaceListing.findUnique({ where: { id: fixtures.marketplaceListingId } });
  const beforeMlv = await prisma.marketplaceListingVariant.findUnique({ where: { id: `${NS}mlv_01` } });
  const beforeIdemp = await prisma.idempotencyRecord.findUnique({ where: { id: fixtures.idempotencyRecordId } });

  // Backdate syncJob to stale
  await prisma.$executeRaw`UPDATE sync_jobs SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${job.id}`;

  // Run recovery
  const recovery = new StaleProcessingRecoveryService(prisma, queue);
  const res = await recovery.recoverStaleJobs();
  assert.equal(res.recoveredCount >= 1, true);

  // Reload all 7 related entities
  const afterProd = await prisma.product.findUnique({ where: { id: fixtures.productId } });
  const afterPs = await prisma.productSource.findUnique({ where: { id: fixtures.productSourceId } });
  const afterSv = await prisma.sourceVariant.findUnique({ where: { id: `${NS}sv_01` } });
  const afterSnap = await prisma.sourceSnapshot.findUnique({ where: { id: fixtures.sourceSnapshotId1 } });
  const afterMl = await prisma.marketplaceListing.findUnique({ where: { id: fixtures.marketplaceListingId } });
  const afterMlv = await prisma.marketplaceListingVariant.findUnique({ where: { id: `${NS}mlv_01` } });
  const afterIdemp = await prisma.idempotencyRecord.findUnique({ where: { id: fixtures.idempotencyRecordId } });

  // Assert 100% deep equality on every entity
  assert.deepEqual(afterProd, beforeProd);
  assert.deepEqual(afterPs, beforePs);
  assert.deepEqual(afterSv, beforeSv);
  assert.deepEqual(afterSnap, beforeSnap);
  assert.deepEqual(afterMl, beforeMl);
  assert.deepEqual(afterMlv, beforeMlv);
  assert.deepEqual(afterIdemp, beforeIdemp);

  // Cleanup idempotency record
  await prisma.idempotencyRecord.delete({ where: { id: idempRecord.id } });
});

// ============================================================================
// RT-19: Periodic Maintenance Loop - Actual Loop, Overlap, Error & Graceful Teardown
// ============================================================================
test("RT-19: Periodic maintenance loop handles overlap, cycle rejections, and graceful stop", async () => {
  const { queue } = createIsolatedQueue("rt19");

  const loopState: {
    scheduledHandler?: () => void;
    scheduledInterval?: number;
    timerCleared?: boolean;
    resolveCycle?: () => void;
    resolveBlockedCycle?: () => void;
  } = {};

  const timerScheduler = {
    setInterval: (handler: () => void, ms: number) => {
      loopState.scheduledHandler = handler;
      loopState.scheduledInterval = ms;
      loopState.timerCleared = false;
      return setTimeout(() => {}, 100000);
    },
    clearInterval: (handle: NodeJS.Timeout | number) => {
      clearTimeout(handle);
      loopState.timerCleared = true;
    },
  };

  let cycleEnterCount = 0;
  let cycleReject = false;
  let cyclePromise: Promise<void> | null = null;

  const maintenance = new RuntimeMaintenanceService(prisma, queue, {
    config: resolveRuntimeConfig({ maintenanceIntervalMs: 1000 }),
    timerScheduler,
    cycleRunner: async () => {
      cycleEnterCount++;
      if (cycleReject) {
        throw new Error(
          "postgresql://user:super_secret_password@localhost:5432/db " +
          "redis://default:redis_secret@localhost:6379 " +
          "Authorization: Bearer fake_secret_token access_token=fake_secret"
        );
      }
      if (cyclePromise) {
        await cyclePromise;
      }
    },
  });

  // A. Start maintenance. First periodic cycle enters and remains blocked.
  assert.equal(maintenance.start(), true);
  assert.equal(maintenance.start(), false); // Idempotent start
  assert.equal(maintenance.isRunning, true);
  assert.equal(loopState.scheduledInterval, 1000);
  assert.ok(loopState.scheduledHandler);

  cyclePromise = new Promise<void>((resolve) => {
    loopState.resolveCycle = resolve;
  });

  // Trigger tick 1
  loopState.scheduledHandler?.();
  // Allow tick to enter async cycleRunner
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(maintenance.isExecutingCycle, true);
  assert.equal(cycleEnterCount, 1);

  // B. Another tick occurs while first cycle remains in flight.
  const prevSkipped = maintenance.skippedTicks;
  loopState.scheduledHandler?.();
  assert.equal(maintenance.skippedTicks, prevSkipped + 1);
  assert.equal(cycleEnterCount, 1); // Second executeCycle was NOT entered!

  // Release cycle 1
  loopState.resolveCycle?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(maintenance.isExecutingCycle, false);

  // C. A periodic cycle rejects.
  cycleReject = true;
  cyclePromise = null;
  // Trigger tick which throws hostile error
  await maintenance.runCycleTick();

  // Zero unhandled rejection, isCycleRunning resets in finally
  assert.equal(maintenance.isExecutingCycle, false);
  assert.ok(maintenance.lastError !== null);
  // Last error contains sanitized text only
  assert.ok(!maintenance.lastError.includes("super_secret_password"));
  assert.ok(!maintenance.lastError.includes("redis_secret"));
  assert.ok(!maintenance.lastError.includes("fake_secret_token"));
  assert.ok(!maintenance.lastError.includes("fake_secret"));
  assert.ok(maintenance.lastError.includes("[REDACTED]"));

  // Subsequent cycle can execute
  cycleReject = false;
  let subsequentRan = false;
  cyclePromise = (async () => {
    subsequentRan = true;
  })();
  await maintenance.runCycleTick();
  assert.equal(subsequentRan, true);
  assert.equal(maintenance.isExecutingCycle, false);

  // D. Call stop() while one cycle is still in flight.
  cyclePromise = new Promise<void>((resolve) => {
    loopState.resolveBlockedCycle = resolve;
  });

  // Trigger tick into in-flight cycle
  loopState.scheduledHandler?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(maintenance.isExecutingCycle, true);

  let stopResolved = false;
  const stopPromise = maintenance.stop().then(() => {
    stopResolved = true;
  });

  // Check that stop has NOT resolved yet while cycle is in flight
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(stopResolved, false);
  assert.equal(maintenance.isExecutingCycle, true);

  // BEFORE releasing the cycle: prove start() is blocked and isRunning is false
  assert.equal(maintenance.start(), false);
  assert.equal(maintenance.isRunning, false);

  // Now release the cycle
  loopState.resolveBlockedCycle?.();
  await stopPromise;

  assert.equal(stopResolved, true);
  assert.equal(maintenance.isRunning, false);
  assert.equal(maintenance.isExecutingCycle, false);
  assert.equal(loopState.timerCleared, true);

  // After stop() has fully resolved, prove restart is allowed
  cyclePromise = null;
  assert.equal(maintenance.start(), true);
  assert.equal(maintenance.isRunning, true);

  // Final stop to prove clean state again
  await maintenance.stop();
  assert.equal(maintenance.isRunning, false);
  assert.equal(maintenance.isExecutingCycle, false);
  assert.equal(loopState.timerCleared, true);
});

// ============================================================================
// RT-20: Clean Resource Teardown and Post-Test Cleanup Proof
// ============================================================================
test("RT-20: Clean integration teardown removes active queue and test records", async () => {
  const { queue } = createIsolatedQueue("rt20");
  const testJob = await createTestSyncJob(prisma, "rt20", "PENDING");
  await queue.enqueueSyncJob(testJob.id);

  // Verify job exists in queue
  const queueJobId = generateQueueJobId(testJob.idempotencyKey);
  const bullJob = await queue.getJob(queueJobId);
  assert.ok(bullJob);

  // Run full cleanup of test queues and workers
  await cleanupRedisTestQueues();

  // Verify there are ZERO Redis keys in bull:phase4c4_test_* namespace
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const remainingBullKeys: string[] = [];
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "bull:phase4c4_test_*", "COUNT", 100);
      cursor = nextCursor;
      remainingBullKeys.push(...keys);
    } while (cursor !== "0");
  } finally {
    await redis.quit().catch(() => {});
  }

  assert.equal(
    remainingBullKeys.length,
    0,
    `Expected 0 remaining Redis keys for pattern bull:phase4c4_test_*, found: ${remainingBullKeys.join(", ")}`
  );

  // Create sentinel AuditLog with runtime actorId and non-test entityId
  const sentinelAuditLog = await prisma.auditLog.create({
    data: {
      actorType: "SYSTEM",
      actorId: "phase4c4-runtime-maintenance",
      action: "RECOVER_STALE_SYNC_JOB",
      entityType: "SyncJob",
      entityId: "non_test_runtime_sentinel",
      metadata: { test: "sentinel_preservation_proof" },
    },
  });

  try {
    // Verify PostgreSQL namespace records cleanup
    await cleanupPostgresNamespace(prisma);

    // Prove sentinel remains after namespace cleanup
    const survivingSentinel = await prisma.auditLog.findUnique({
      where: { id: sentinelAuditLog.id },
    });
    assert.ok(survivingSentinel, "Sentinel AuditLog must survive cleanupPostgresNamespace()");
    assert.equal(survivingSentinel.entityId, "non_test_runtime_sentinel");
    assert.equal(survivingSentinel.actorId, "phase4c4-runtime-maintenance");

    const remainingJobs = await prisma.syncJob.count({
      where: { id: { startsWith: NS } },
    });
    assert.equal(remainingJobs, 0);
  } finally {
    // Clean the sentinel explicitly at the end of the test
    await prisma.auditLog.delete({
      where: { id: sentinelAuditLog.id },
    });
  }
});
