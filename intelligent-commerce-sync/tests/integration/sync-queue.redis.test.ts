import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import test, { after, before } from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { QueueEvents, Queue } from "bullmq";
import {
  SyncExecutionQueue,
  generateQueueJobId,
} from "../../src/queue/sync-queue.js";
import { SyncExecutionWorker } from "../../src/queue/sync-worker.js";
import {
  type SyncJobExecutor,
  type SyncQueueJobData,
  NonQueueableJobStatusError,
  SyncJobNotFoundError,
  SyncJobExecutionClaimError,
  InvalidQueuePayloadError,
} from "../../src/queue/types.js";
import {
  getRedisUrl,
  createRedisConnection,
  parseRedisConnectionOptions,
  RedisConfigurationError,
} from "../../src/queue/connection.js";
import { checkRedisHealth } from "../../src/queue/health.js";
import {
  type UpdatePriceExecutionPayload,
} from "../../src/execution/types.js";
import {
  generateSyncOperationIdempotencyKey,
} from "../../src/sync/idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL environment variable is required for DB/Queue integration tests. " +
    "Example: DATABASE_URL='postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public'"
  );
}

const redisUrl = getRedisUrl();
const NS = "phase4c2_test_";

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
};

const activeQueues: SyncExecutionQueue[] = [];
const activeRawQueues: Queue<unknown, void, string>[] = [];
const activeWorkers: SyncExecutionWorker[] = [];
const activeEvents: QueueEvents[] = [];

function createIsolatedQueue(testSuffix: string): { queueName: string; queue: SyncExecutionQueue } {
  const queueName = `${NS}q_${testSuffix}_${Date.now()}`;
  const connection = parseRedisConnectionOptions(redisUrl);
  const queue = new SyncExecutionQueue(prisma, {
    queueName,
    connection,
  });
  activeQueues.push(queue);
  return { queueName, queue };
}

function createIsolatedEvents(queueName: string): QueueEvents {
  const connection = parseRedisConnectionOptions(redisUrl);
  const events = new QueueEvents(queueName, { connection });
  activeEvents.push(events);
  return events;
}

function createIsolatedWorker(
  queueName: string,
  executor: SyncJobExecutor,
  options?: {
    concurrency?: number;
    autorun?: boolean;
  }
): SyncExecutionWorker {
  const worker = new SyncExecutionWorker(prisma, executor, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
    concurrency: options?.concurrency ?? 1,
    autorun: options?.autorun ?? true,
  });
  activeWorkers.push(worker);
  return worker;
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

let prisma: PrismaClient;

before(async () => {
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  await cleanupPostgresNamespace(prisma);
  await createDatabaseFixtures(prisma);
});

after(async () => {
  await Promise.allSettled([
    ...activeEvents.map((e) => e.close()),
    ...activeWorkers.map((w) => w.close()),
    ...activeQueues.map((q) => q.close()),
    ...activeRawQueues.map((q) => q.close()),
  ]);
  if (prisma) {
    await cleanupPostgresNamespace(prisma);
    await prisma.$disconnect();
  }
});

// Helper to create a test SyncJob with specific status
async function createTestSyncJob(
  client: PrismaClient,
  idSuffix: string,
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "NEEDS_REVIEW" | "BLOCKED" | "CANCELLED" = "PENDING"
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
        targetPriceIdr: 100000,
      },
    ],
  };

  const job = await client.syncJob.create({
    data: {
      id: syncJobId,
      productSourceId: fixtures.productSourceId,
      marketplaceListingId: fixtures.marketplaceListingId,
      sourceSnapshotId: fixtures.sourceSnapshotId1,
      operationType: "UPDATE_PRICE",
      jobType: "PRICE_UPDATE",
      executionPayload: payload as unknown as Prisma.InputJsonValue,
      payloadVersion: 1,
      status,
      idempotencyKey: idempKey,
    },
  });

  await client.idempotencyRecord.create({
    data: {
      key: idempKey,
      operationType: "UPDATE_PRICE",
      status: "STARTED",
      marketplace: fixtures.marketplace,
      sellerAccountKey: fixtures.sellerAccountKey,
      productSourceId: fixtures.productSourceId,
      syncJobId: job.id,
    },
  });

  return job;
}

// ----------------------------------------------------------------------
// Q-01 — REDIS CONNECTIVITY
// ----------------------------------------------------------------------
test("Q-01: Connect to real Redis, execute PING, and verify PONG response", async () => {
  const isHealthy = await checkRedisHealth(redisUrl);
  assert.equal(isHealthy, true, "checkRedisHealth must return true");

  const redis = createRedisConnection(redisUrl);
  const pong = await redis.ping();
  assert.equal(pong, "PONG");
  await redis.quit();
});

// ----------------------------------------------------------------------
// Q-02 — QUEUE PAYLOAD MINIMALITY
// ----------------------------------------------------------------------
test("Q-02: Queue payload contains ONLY minimal reference data and zero secrets/business payloads", async () => {
  const { queue } = createIsolatedQueue("q02");
  const syncJob = await createTestSyncJob(prisma, "q02");
  const job = await queue.enqueueSyncJob(syncJob.id);

  assert.ok(job);
  assert.equal(job.data.schemaVersion, 1);
  assert.equal(job.data.syncJobId, syncJob.id);

  // Assert exact keys in job.data
  const dataKeys = Object.keys(job.data).sort();
  assert.deepEqual(dataKeys, ["schemaVersion", "syncJobId"]);

  // Ensure no executionPayload or forbidden credentials exist in job.data
  const rawData = job.data as unknown as Record<string, unknown>;
  assert.equal(rawData["executionPayload"], undefined);
  assert.equal(rawData["partnerKey"], undefined);
  assert.equal(rawData["accessToken"], undefined);
  assert.equal(rawData["refreshToken"], undefined);
  assert.equal(rawData["password"], undefined);
});

// ----------------------------------------------------------------------
// Q-03 — DETERMINISTIC JOB ID
// ----------------------------------------------------------------------
test("Q-03: generateQueueJobId produces deterministic lowercase SHA-256 job ID", async () => {
  const key1 = "shopee:seller_01:jakmall:prod_01:UPDATE_PRICE:snap_01";
  const key2 = "shopee:seller_01:jakmall:prod_01:UPDATE_PRICE:snap_02";

  const jobId1a = generateQueueJobId(key1);
  const jobId1b = generateQueueJobId(key1);
  const jobId2 = generateQueueJobId(key2);

  assert.equal(jobId1a, jobId1b, "Same idempotencyKey must produce identical queue jobId");
  assert.notEqual(jobId1a, jobId2, "Different idempotencyKey must produce different queue jobId");
  assert.match(jobId1a, /^[0-9a-f]{64}$/, "jobId must be a 64-character lowercase hex SHA-256 string");
});

// ----------------------------------------------------------------------
// Q-04 — STRENGTHENED DUPLICATE ENQUEUE COUNT PROOF
// ----------------------------------------------------------------------
test("Q-04: Duplicate enqueueSyncJob calls produce exactly one logical BullMQ job with count = 1", async () => {
  const { queue } = createIsolatedQueue("q04");
  const syncJob = await createTestSyncJob(prisma, "q04");

  const job1 = await queue.enqueueSyncJob(syncJob.id);
  const job2 = await queue.enqueueSyncJob(syncJob.id);

  assert.equal(job1.id, job2.id, "Both enqueue calls must reference the identical deterministic BullMQ jobId");

  const expectedJobId = generateQueueJobId(syncJob.idempotencyKey);
  assert.equal(job1.id, expectedJobId);

  // Assert exact counts in the queue
  const counts = await queue.rawQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  const totalJobs = (counts["waiting"] ?? 0) + (counts["active"] ?? 0) + (counts["completed"] ?? 0) + (counts["failed"] ?? 0) + (counts["delayed"] ?? 0);
  assert.equal(totalJobs, 1, `Queue must contain exactly 1 total job, got ${totalJobs}`);

  const jobs = await queue.rawQueue.getJobs(["waiting", "active", "delayed"]);
  assert.equal(jobs.length, 1, `getJobs must return exactly 1 job, got ${jobs.length}`);
  assert.equal(jobs[0]?.id, expectedJobId);
});

// ----------------------------------------------------------------------
// Q-05 — WORKER LOADS FROM POSTGRESQL
// ----------------------------------------------------------------------
test("Q-05: Worker receives minimal queue reference and loads authoritative payload from PostgreSQL", async () => {
  const { queueName, queue } = createIsolatedQueue("q05");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q05");
  const job = await queue.enqueueSyncJob(syncJob.id);

  let loadedFromDb = false;
  let receivedPrice = 0;

  const testExecutor: SyncJobExecutor = {
    async execute(j, payload) {
      loadedFromDb = j.id === syncJob.id && j.productSourceId === fixtures.productSourceId;
      if (payload.operationType === "UPDATE_PRICE") {
        receivedPrice = payload.variants[0]?.targetPriceIdr ?? 0;
      }
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await job.waitUntilFinished(queueEvents);
  await queueEvents.close();
  await worker.close();

  assert.equal(loadedFromDb, true, "Executor must verify job details originated from PostgreSQL");
  assert.equal(receivedPrice, 100000, "Executor must receive exact price from persisted PostgreSQL payload");
});

// ----------------------------------------------------------------------
// Q-06 — SUCCESS LIFECYCLE
// ----------------------------------------------------------------------
test("Q-06: Success lifecycle transitions PENDING -> PROCESSING -> COMPLETED with SYNC_COMPLETED event", async () => {
  const { queueName, queue } = createIsolatedQueue("q06");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q06");
  const job = await queue.enqueueSyncJob(syncJob.id);

  const testExecutor: SyncJobExecutor = {
    async execute(j) {
      assert.equal(j.status, "PROCESSING", "Job status must be PROCESSING during execution");
      assert.equal(j.attemptCount, 1, "attemptCount must be 1 on first execution");
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await job.waitUntilFinished(queueEvents);
  await queueEvents.close();
  await worker.close();

  // Directly verify PostgreSQL database state
  const completedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(completedJob);
  assert.equal(completedJob.status, "COMPLETED");
  assert.equal(completedJob.attemptCount, 1);
  assert.ok(completedJob.completedAt);
  assert.equal(completedJob.lastErrorCode, null);
  assert.equal(completedJob.lastErrorMessage, null);

  const events = await prisma.syncEvent.findMany({ where: { syncJobId: syncJob.id } });
  const completedEvent = events.find((e) => e.eventType === "SYNC_COMPLETED");
  assert.ok(completedEvent, "SYNC_COMPLETED event must exist in database");
});

// ----------------------------------------------------------------------
// Q-07 — STRENGTHENED RETRY TEST WITH CERTIFIED TRANSITIONS
// ----------------------------------------------------------------------
test("Q-07: Worker failure triggers BullMQ backoff retry, updates attemptCount, and succeeds on retry", async () => {
  const { queueName, queue } = createIsolatedQueue("q07");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q07");

  const job = await queue.enqueueSyncJob(syncJob.id, {
    attempts: 3,
    backoff: { type: "fixed", delay: 50 },
  });

  let executionAttempt = 0;
  const testExecutor: SyncJobExecutor = {
    async execute() {
      executionAttempt++;
      if (executionAttempt === 1) {
        throw new Error("Transient execution error on attempt 1");
      }
      // Succeeds on attempt 2
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await job.waitUntilFinished(queueEvents);
  await queueEvents.close();
  await worker.close();

  assert.equal(executionAttempt, 2, "Executor should have been called twice (1 failure, 1 success)");

  const finalJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(finalJob);
  assert.equal(finalJob.status, "COMPLETED");
  assert.equal(finalJob.attemptCount, 2);

  const events = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id },
    orderBy: { createdAt: "asc" },
  });

  const failedEvents = events.filter((e) => e.eventType === "SYNC_FAILED");
  const completedEvents = events.filter((e) => e.eventType === "SYNC_COMPLETED");

  assert.equal(failedEvents.length, 1, "Exactly one SYNC_FAILED event recorded for attempt 1");
  assert.equal(completedEvents.length, 1, "Exactly one SYNC_COMPLETED event recorded for attempt 2");
});

// ----------------------------------------------------------------------
// Q-08 — STRENGTHENED PROVE BULLMQ TERMINAL FAILED STATE
// ----------------------------------------------------------------------
test("Q-08: Exhausted retries mark SyncJob as FAILED with error code, message, and BullMQ failed status", async () => {
  const { queueName, queue } = createIsolatedQueue("q08");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q08");

  const job = await queue.enqueueSyncJob(syncJob.id, {
    attempts: 2,
    backoff: { type: "fixed", delay: 50 },
  });

  let executionCount = 0;
  const testExecutor: SyncJobExecutor = {
    async execute() {
      executionCount++;
      const err = new Error("Terminal unrecoverable error");
      (err as { code?: string }).code = "TERMINAL_ERROR";
      throw err;
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await assert.rejects(
    async () => job.waitUntilFinished(queueEvents),
    /Terminal unrecoverable error/
  );
  await queueEvents.close();
  await worker.close();

  // Assert BullMQ state is explicitly "failed"
  const bullmqState = await job.getState();
  assert.equal(bullmqState, "failed", `Expected BullMQ job state 'failed', got '${bullmqState}'`);

  assert.equal(executionCount, 2, "Expected 2 failed attempts before final failure");

  const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(failedJob);
  assert.equal(failedJob.status, "FAILED");
  assert.equal(failedJob.attemptCount, 2);
  assert.equal(failedJob.lastErrorCode, "TERMINAL_ERROR");
  assert.ok(failedJob.lastErrorMessage?.includes("Terminal unrecoverable error"));

  const failedEvents = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
  });
  assert.equal(failedEvents.length, 2);
});

// ----------------------------------------------------------------------
// Q-09 — NON-QUEUEABLE STATES
// ----------------------------------------------------------------------
test("Q-09: Enqueue fails closed for non-queueable statuses (NEEDS_REVIEW, BLOCKED, COMPLETED, CANCELLED)", async () => {
  const { queue } = createIsolatedQueue("q09");
  const nonQueueableStatuses: Array<"NEEDS_REVIEW" | "BLOCKED" | "COMPLETED" | "CANCELLED"> = [
    "NEEDS_REVIEW",
    "BLOCKED",
    "COMPLETED",
    "CANCELLED",
  ];

  for (const status of nonQueueableStatuses) {
    const job = await createTestSyncJob(prisma, `q09_${status.toLowerCase()}`, status);

    await assert.rejects(
      async () => queue.enqueueSyncJob(job.id),
      NonQueueableJobStatusError,
      `Should reject enqueue for status ${status}`
    );

    const expectedJobId = generateQueueJobId(job.idempotencyKey);
    const queueJob = await queue.getJob(expectedJobId);
    assert.equal(queueJob, undefined, `No queue job should be created in Redis for status ${status}`);
  }
});

// ----------------------------------------------------------------------
// Q-10 — MISSING SYNCJOB
// ----------------------------------------------------------------------
test("Q-10: Enqueueing nonexistent syncJobId rejects with SyncJobNotFoundError", async () => {
  const { queue } = createIsolatedQueue("q10");
  const nonexistentId = `${NS}nonexistent_job_id`;

  await assert.rejects(
    async () => queue.enqueueSyncJob(nonexistentId),
    SyncJobNotFoundError
  );
});

// ----------------------------------------------------------------------
// Q-11 — REDIS PRODUCER RESTART
// ----------------------------------------------------------------------
test("Q-11: Queue persistence across producer restart", async () => {
  const queueName = `${NS}q_q11_${Date.now()}`;
  const syncJob = await createTestSyncJob(prisma, "q11");

  // Producer A creates and enqueues job
  const producerA = new SyncExecutionQueue(prisma, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
  });
  const job = await producerA.enqueueSyncJob(syncJob.id);
  await producerA.close();

  // Producer B connects fresh and retrieves existing job
  const producerB = new SyncExecutionQueue(prisma, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
  });
  activeQueues.push(producerB);

  const retrievedJob = await producerB.getJob(job.id!);
  assert.ok(retrievedJob);
  assert.equal(retrievedJob.id, job.id);
  assert.equal(retrievedJob.data.syncJobId, syncJob.id);
});

// ----------------------------------------------------------------------
// Q-12 — REDIS CONTAINER RESTART
// ----------------------------------------------------------------------
test("Q-12: Redis container restart preserves persisted AOF queue job", async () => {
  const queueName = `${NS}q_q12_${Date.now()}`;
  const queueBefore = new SyncExecutionQueue(prisma, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
  });
  const syncJob = await createTestSyncJob(prisma, "q12");
  const job = await queueBefore.enqueueSyncJob(syncJob.id);
  const expectedJobId = job.id!;

  // Close client connection before restarting container
  await queueBefore.close();

  // Restart Redis container
  execSync("docker compose restart redis", { stdio: "pipe" });

  // Wait for Redis to become healthy
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    healthy = await checkRedisHealth(redisUrl);
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(healthy, true, "Redis must become healthy after restart");

  // Connect fresh queue client after restart
  const postRestartQueue = new SyncExecutionQueue(prisma, {
    queueName,
    connection: parseRedisConnectionOptions(redisUrl),
  });
  activeQueues.push(postRestartQueue);

  const restoredJob = await postRestartQueue.getJob(expectedJobId);
  assert.ok(restoredJob, "Job must survive Redis container restart with AOF enabled");
  assert.equal(restoredJob.id, expectedJobId);
  assert.equal(restoredJob.data.syncJobId, syncJob.id);
});

// ----------------------------------------------------------------------
// Q-13 — DETERMINISTIC WORKER RESTART (AUTORUN: FALSE)
// ----------------------------------------------------------------------
test("Q-13: Worker restart picks up pending queue jobs cleanly without start/close races", async () => {
  const { queueName, queue } = createIsolatedQueue("q13");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q13");
  const job = await queue.enqueueSyncJob(syncJob.id);

  let worker1Executed = false;
  const worker1Executor: SyncJobExecutor = {
    async execute() {
      worker1Executed = true;
    },
  };

  // Worker 1 constructed with autorun: false -> never starts processing
  const worker1 = createIsolatedWorker(queueName, worker1Executor, { autorun: false });
  await worker1.close();
  assert.equal(worker1Executed, false, "Worker 1 with autorun: false must provably never execute");

  // Worker 2 starts fresh and processes the pending job
  let executedByWorker2 = false;
  const worker2Executor: SyncJobExecutor = {
    async execute() {
      executedByWorker2 = true;
    },
  };

  createIsolatedWorker(queueName, worker2Executor);

  await job.waitUntilFinished(queueEvents);
  await queueEvents.close();

  assert.equal(executedByWorker2, true, "Worker 2 must successfully pick up and execute the pending job");
});

// ----------------------------------------------------------------------
// Q-14 — CONCURRENT DUPLICATE DELIVERY CLAIM
// ----------------------------------------------------------------------
test("Q-14: Concurrent duplicate deliveries for same SyncJob execute executor exactly once and increment attemptCount once", async () => {
  const queueName = `${NS}q_q14_${Date.now()}`;
  const connection = parseRedisConnectionOptions(redisUrl);
  const rawQueue = new Queue<SyncQueueJobData, void, string>(queueName, { connection });
  activeRawQueues.push(rawQueue);
  const queueEvents = createIsolatedEvents(queueName);

  const syncJob = await createTestSyncJob(prisma, "q14");

  // Enqueue two distinct BullMQ transport deliveries referencing the exact same syncJobId
  const jobDelivery1 = await rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: syncJob.id },
    { jobId: `${NS}delivery_1_${Date.now()}`, attempts: 1 }
  );
  const jobDelivery2 = await rawQueue.add(
    "execute-sync",
    { schemaVersion: 1, syncJobId: syncJob.id },
    { jobId: `${NS}delivery_2_${Date.now()}`, attempts: 1 }
  );

  let executorCallCount = 0;
  const testExecutor: SyncJobExecutor = {
    async execute() {
      executorCallCount++;
      // Simulate non-zero execution duration to widen race window
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };

  // Start worker with concurrency: 2 to execute deliveries concurrently
  const worker = createIsolatedWorker(queueName, testExecutor, { concurrency: 2 });

  // One will finish successfully, one will fail with SyncJobExecutionClaimError
  const results = await Promise.allSettled([
    jobDelivery1.waitUntilFinished(queueEvents),
    jobDelivery2.waitUntilFinished(queueEvents),
  ]);

  await queueEvents.close();
  await worker.close();

  // Exactly one delivery succeeds and one delivery is rejected
  const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
  const rejectedCount = results.filter((r) => r.status === "rejected").length;
  assert.equal(fulfilledCount, 1, `Expected 1 delivery to succeed, got ${fulfilledCount}`);
  assert.equal(rejectedCount, 1, `Expected 1 delivery to be rejected, got ${rejectedCount}`);

  // Critical assertion: executor was called exactly ONCE
  assert.equal(executorCallCount, 1, `Executor must be called exactly once, got ${executorCallCount}`);

  // Critical assertion: attemptCount in DB is exactly 1
  const updatedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(updatedJob);
  assert.equal(updatedJob.status, "COMPLETED");
  assert.equal(updatedJob.attemptCount, 1, `attemptCount in database must be 1, got ${updatedJob.attemptCount}`);
});

// ----------------------------------------------------------------------
// Q-15 — ERROR SECRET REDACTION
// ----------------------------------------------------------------------
test("Q-15: Executor error containing dummy credentials is fully redacted in SyncJob and SyncEvent", async () => {
  const { queueName, queue } = createIsolatedQueue("q15");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q15");

  const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

  const dummySecretBearer = "secret-bearer-token-12345";
  const dummyAccessToken = "secret-access-token-67890";
  const dummyPassword = "secret-super-password-abc";
  const dummyClientSecret = "secret-client-secret-xyz";
  const dummyPartnerKey = "secret-partner-key-999";
  const dummyUriPassword = "super-secret-uri-password";

  const testExecutor: SyncJobExecutor = {
    async execute() {
      const errorMsg =
        `Failed to call external API: ` +
        `Authorization: Bearer ${dummySecretBearer} ` +
        `access_token=${dummyAccessToken} ` +
        `password=${dummyPassword} ` +
        `client_secret=${dummyClientSecret} ` +
        `partner_key=${dummyPartnerKey} ` +
        `url=https://user:${dummyUriPassword}@api.shopee.com/v2`;
      const err = new Error(errorMsg);
      (err as { code?: string }).code = "CREDENTIAL_LEAK_TEST";
      throw err;
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await assert.rejects(async () => job.waitUntilFinished(queueEvents));
  await queueEvents.close();
  await worker.close();

  const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(failedJob);
  assert.equal(failedJob.status, "FAILED");
  assert.equal(failedJob.lastErrorCode, "CREDENTIAL_LEAK_TEST");

  const lastErrorMessage = failedJob.lastErrorMessage ?? "";
  assert.ok(lastErrorMessage.length > 0);

  // Assert NONE of the secret values exist in the database error message
  assert.equal(lastErrorMessage.includes(dummySecretBearer), false, "Bearer secret must not be in error message");
  assert.equal(lastErrorMessage.includes(dummyAccessToken), false, "access_token must not be in error message");
  assert.equal(lastErrorMessage.includes(dummyPassword), false, "password must not be in error message");
  assert.equal(lastErrorMessage.includes(dummyClientSecret), false, "client_secret must not be in error message");
  assert.equal(lastErrorMessage.includes(dummyPartnerKey), false, "partner_key must not be in error message");
  assert.equal(lastErrorMessage.includes(dummyUriPassword), false, "URI password must not be in error message");

  // Assert [REDACTED] appears in error message
  assert.ok(lastErrorMessage.includes("[REDACTED]"), "Error message must contain '[REDACTED]'");

  // Also verify SyncEvent payload
  const events = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
  });
  assert.equal(events.length, 1);
  const eventPayload = events[0]?.payload as { errorMessage?: string };
  const eventErrorMsg = eventPayload?.errorMessage ?? "";

  assert.equal(eventErrorMsg.includes(dummySecretBearer), false);
  assert.equal(eventErrorMsg.includes(dummyAccessToken), false);
  assert.equal(eventErrorMsg.includes(dummyPassword), false);
  assert.equal(eventErrorMsg.includes(dummyClientSecret), false);
  assert.equal(eventErrorMsg.includes(dummyPartnerKey), false);
  assert.equal(eventErrorMsg.includes(dummyUriPassword), false);
  assert.ok(eventErrorMsg.includes("[REDACTED]"));
});

// ----------------------------------------------------------------------
// Q-16 — STRICT REDIS PAYLOAD REJECTION
// ----------------------------------------------------------------------
test("Q-16: Strict payload validator rejects extra fields, blank syncJobId, and invalid schemaVersion before executor call", async () => {
  const queueName = `${NS}q_q16_${Date.now()}`;
  const connection = parseRedisConnectionOptions(redisUrl);
  const rawQueue = new Queue<unknown, void, string>(queueName, { connection });
  activeRawQueues.push(rawQueue);
  const queueEvents = createIsolatedEvents(queueName);

  const syncJob = await createTestSyncJob(prisma, "q16");

  let executorInvoked = false;
  const testExecutor: SyncJobExecutor = {
    async execute() {
      executorInvoked = true;
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  // 1. Extra forbidden fields (e.g. executionPayload injected into transport)
  const jobExtra = await rawQueue.add("execute-sync", {
    schemaVersion: 1,
    syncJobId: syncJob.id,
    executionPayload: { targetPrice: 999 },
  }, { attempts: 1 });
  await assert.rejects(async () => jobExtra.waitUntilFinished(queueEvents), /Forbidden field 'executionPayload'/);

  // 2. Blank syncJobId
  const jobBlank = await rawQueue.add("execute-sync", {
    schemaVersion: 1,
    syncJobId: "   ",
  }, { attempts: 1 });
  await assert.rejects(async () => jobBlank.waitUntilFinished(queueEvents), /non-empty string 'syncJobId'/);

  // 3. Wrong schemaVersion
  const jobVersion = await rawQueue.add("execute-sync", {
    schemaVersion: 2,
    syncJobId: syncJob.id,
  }, { attempts: 1 });
  await assert.rejects(async () => jobVersion.waitUntilFinished(queueEvents), /Unsupported queue schemaVersion '2'/);

  // 4. Non-object / Array payload
  const jobArray = await rawQueue.add("execute-sync", [1, 2, 3], { attempts: 1 });
  await assert.rejects(async () => jobArray.waitUntilFinished(queueEvents), /Queue job payload must be a non-null object/);

  await queueEvents.close();
  await worker.close();

  // Assert executor was NEVER called
  assert.equal(executorInvoked, false, "Executor must never be called for malformed transport payloads");
});

// ----------------------------------------------------------------------
// Q-17 — MALFORMED REDIS_URL AND CONFIGURATION PARSING
// ----------------------------------------------------------------------
test("Q-17: parseRedisConnectionOptions throws RedisConfigurationError on malformed URL, invalid protocol, or invalid port", () => {
  // Malformed URL
  assert.throws(
    () => parseRedisConnectionOptions("not-a-valid-url"),
    RedisConfigurationError
  );

  // Unsupported protocol (http, mysql, postgres)
  assert.throws(
    () => parseRedisConnectionOptions("http://localhost:6379"),
    RedisConfigurationError
  );
  assert.throws(
    () => parseRedisConnectionOptions("postgres://localhost:5432"),
    RedisConfigurationError
  );

  // Invalid port
  assert.throws(
    () => parseRedisConnectionOptions("redis://localhost:99999"),
    RedisConfigurationError
  );
  assert.throws(
    () => parseRedisConnectionOptions("redis://localhost:abc"),
    RedisConfigurationError
  );

  // Missing hostname
  assert.throws(
    () => parseRedisConnectionOptions("redis://:6379"),
    RedisConfigurationError
  );

  // Valid redis:// parsing
  const plainOptions = parseRedisConnectionOptions("redis://localhost:6379") as { host?: string; port?: number; tls?: unknown };
  assert.equal(plainOptions.host, "localhost");
  assert.equal(plainOptions.port, 6379);
  assert.equal(plainOptions.tls, undefined);

  // Valid rediss:// parsing (TLS enabled)
  const tlsOptions = parseRedisConnectionOptions("rediss://secure-redis.internal:6380") as { host?: string; port?: number; tls?: unknown };
  assert.equal(tlsOptions.host, "secure-redis.internal");
  assert.equal(tlsOptions.port, 6380);
  assert.ok(tlsOptions.tls);
});

// ----------------------------------------------------------------------
// Q-18 — EXECUTOR INFRASTRUCTURE-CLASS SPOOF TEST
// ----------------------------------------------------------------------
test("Q-18: Executor throwing infrastructure-named errors does not bypass failure persistence and transitions PROCESSING -> FAILED", async () => {
  const { queueName, queue } = createIsolatedQueue("q18");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q18");

  const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

  let executionCount = 0;
  const testExecutor: SyncJobExecutor = {
    async execute() {
      executionCount++;
      throw new SyncJobExecutionClaimError("Executor deliberately threw infrastructure-named error");
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await assert.rejects(
    async () => job.waitUntilFinished(queueEvents),
    /Executor deliberately threw infrastructure-named error/
  );
  await queueEvents.close();
  await worker.close();

  assert.equal(executionCount, 1, "Executor must have been called exactly once");

  // Assert BullMQ state is failed
  const bullmqState = await job.getState();
  assert.equal(bullmqState, "failed");

  // Assert PostgreSQL SyncJob state
  const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(failedJob);
  assert.equal(failedJob.status, "FAILED");
  assert.equal(failedJob.attemptCount, 1);
  assert.equal(failedJob.lastErrorCode, "EXECUTION_ERROR");
  assert.ok(failedJob.lastErrorMessage?.includes("Executor deliberately threw infrastructure-named error"));

  // Assert SYNC_FAILED event
  const events = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
  });
  assert.equal(events.length, 1);
  const eventPayload = events[0]?.payload as { errorCode?: string; errorMessage?: string };
  assert.equal(eventPayload?.errorCode, "EXECUTION_ERROR");
  assert.ok(eventPayload?.errorMessage?.includes("Executor deliberately threw infrastructure-named error"));
});

// ----------------------------------------------------------------------
// Q-19 — MALFORMED AND HOSTILE ERROR OBJECT SAFETY
// ----------------------------------------------------------------------
test("Q-19: Hostile error objects with exploding getters/toString do not crash worker and persist safe fallback", async () => {
  const { queueName, queue } = createIsolatedQueue("q19");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q19");

  const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

  const hostileError = {
    get code() {
      throw new Error("code getter exploded");
    },
    toString() {
      throw new Error("toString exploded");
    },
  };

  const testExecutor: SyncJobExecutor = {
    async execute() {
      throw hostileError;
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await assert.rejects(async () => job.waitUntilFinished(queueEvents));
  await queueEvents.close();
  await worker.close();

  // Assert BullMQ state is failed
  const bullmqState = await job.getState();
  assert.equal(bullmqState, "failed");

  // Assert PostgreSQL state
  const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(failedJob);
  assert.equal(failedJob.status, "FAILED");
  assert.equal(failedJob.attemptCount, 1);
  assert.equal(failedJob.lastErrorCode, "EXECUTION_ERROR");
  assert.equal(failedJob.lastErrorMessage, "Unknown execution error");

  const events = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
  });
  assert.equal(events.length, 1);
  const eventPayload = events[0]?.payload as { errorCode?: string; errorMessage?: string };
  assert.equal(eventPayload?.errorCode, "EXECUTION_ERROR");
  assert.equal(eventPayload?.errorMessage, "Unknown execution error");
});

// ----------------------------------------------------------------------
// Q-20 — SECRET INSIDE error.code
// ----------------------------------------------------------------------
test("Q-20: Secret embedded in error.code is rejected by whitelist and normalized to EXECUTION_ERROR", async () => {
  const { queueName, queue } = createIsolatedQueue("q20");
  const queueEvents = createIsolatedEvents(queueName);
  const syncJob = await createTestSyncJob(prisma, "q20");

  const job = await queue.enqueueSyncJob(syncJob.id, { attempts: 1 });

  const dummySecretInCode = "secret-code-token-value-999";

  const testExecutor: SyncJobExecutor = {
    async execute() {
      const err = new Error("ordinary execution failure message");
      (err as unknown as Record<string, unknown>)["code"] = `access_token=${dummySecretInCode}`;
      throw err;
    },
  };

  const worker = createIsolatedWorker(queueName, testExecutor);

  await assert.rejects(async () => job.waitUntilFinished(queueEvents));
  await queueEvents.close();
  await worker.close();

  const failedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
  assert.ok(failedJob);
  assert.equal(failedJob.status, "FAILED");
  assert.equal(failedJob.lastErrorCode, "EXECUTION_ERROR", "Secret-bearing code must be normalized to EXECUTION_ERROR");

  // Assert secret string is NOT in database
  assert.equal(failedJob.lastErrorCode.includes(dummySecretInCode), false);

  const events = await prisma.syncEvent.findMany({
    where: { syncJobId: syncJob.id, eventType: "SYNC_FAILED" },
  });
  assert.equal(events.length, 1);
  const eventPayload = events[0]?.payload as { errorCode?: string };
  assert.equal(eventPayload?.errorCode, "EXECUTION_ERROR");
  assert.equal(eventPayload?.errorCode?.includes(dummySecretInCode), false);
});

// ----------------------------------------------------------------------
// Q-21 — FINAL CLEANUP
// ----------------------------------------------------------------------
test("Q-21: Cleanup removes all queue jobs and PostgreSQL test namespace rows", async () => {
  await Promise.allSettled(activeQueues.map((q) => q.rawQueue.obliterate({ force: true })));
  await Promise.allSettled(activeRawQueues.map((q) => q.obliterate({ force: true })));
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

  assert.equal(productCount, 0, "productCount should be 0");
  assert.equal(productSourceCount, 0, "productSourceCount should be 0");
  assert.equal(sourceVariantCount, 0, "sourceVariantCount should be 0");
  assert.equal(sourceSnapshotCount, 0, "sourceSnapshotCount should be 0");
  assert.equal(listingCount, 0, "listingCount should be 0");
  assert.equal(listingVariantCount, 0, "listingVariantCount should be 0");
  assert.equal(syncJobCount, 0, "syncJobCount should be 0");
  assert.equal(syncEventCount, 0, "syncEventCount should be 0");
  assert.equal(idempCount, 0, "idempCount should be 0");
});
