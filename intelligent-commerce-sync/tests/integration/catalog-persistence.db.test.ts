import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { PrismaClient } from "@prisma/client";
import { CatalogPersistenceService } from "../../src/catalog/catalog-persistence.js";
import { parseJakmallHtml } from "../../src/jakmall/parser.js";
import { normalizeToCanonical } from "../../src/jakmall/normalizer.js";

const databaseUrl =
  process.env["DATABASE_URL"] ||
  "postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public";

const NS_SOURCE_ID = "6970238281488_phase6a";

let prisma: PrismaClient;
let persistence: CatalogPersistenceService;

async function cleanupTestData(client: PrismaClient) {
  const existingSource = await client.productSource.findUnique({
    where: {
      source_sourceProductId: {
        source: "jakmall",
        sourceProductId: NS_SOURCE_ID,
      },
    },
    include: { product: true },
  });

  if (existingSource) {
    await client.syncEvent.deleteMany({
      where: { productSourceId: existingSource.id },
    });
    await client.sourceSnapshot.deleteMany({
      where: { productSourceId: existingSource.id },
    });
    await client.sourceVariant.deleteMany({
      where: { productSourceId: existingSource.id },
    });
    await client.productSource.delete({
      where: { id: existingSource.id },
    });
    await client.product.delete({
      where: { id: existingSource.productId },
    });
  }
}

before(async () => {
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  await cleanupTestData(prisma);
  persistence = new CatalogPersistenceService(prisma);
});

after(async () => {
  if (prisma) {
    await cleanupTestData(prisma);
    await prisma.$disconnect();
  }
});

test("CP-01: CatalogPersistenceService transactionally creates Product, ProductSource, SourceVariants, SourceSnapshot, and SyncEvent", async () => {
  const fixturePath = path.resolve(process.cwd(), "tests/fixtures/acmic.html");
  const html = fs.readFileSync(fixturePath, "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w"
  );

  // Set test sourceProductId namespace to avoid collisions with other test runs
  canonical.sourceProductId = NS_SOURCE_ID;

  const result = await persistence.persistCanonicalProduct(canonical);

  assert.ok(result.productId, "Must generate valid productId");
  assert.ok(result.productSourceId, "Must generate valid productSourceId");
  assert.ok(result.sourceSnapshotId, "Must generate valid sourceSnapshotId");

  // Verify DB state
  const productSource = await prisma.productSource.findUnique({
    where: { id: result.productSourceId },
    include: {
      product: true,
      variants: true,
      snapshots: true,
      syncEvents: true,
    },
  });

  assert.ok(productSource);
  assert.equal(productSource.source, "jakmall");
  assert.equal(productSource.sourceProductId, NS_SOURCE_ID);
  assert.equal(productSource.product.id, result.productId);

  // 9 SKUs in ACMIC
  assert.equal(productSource.variants.length, 9, "Must persist all 9 canonical variants");

  // Snapshot verification
  assert.equal(productSource.snapshots.length, 1);
  const snap = productSource.snapshots[0]!;
  assert.equal(snap.id, result.sourceSnapshotId);
  assert.ok(snap.sourceHash && snap.sourceHash.length === 64, "Must compute valid SHA256 sourceHash");
  assert.ok(snap.contentHash && snap.contentHash.length === 64);
  assert.ok(snap.priceHash && snap.priceHash.length === 64);
  assert.ok(snap.inventoryHash && snap.inventoryHash.length === 64);
  assert.ok(snap.variantHash && snap.variantHash.length === 64);

  // Event verification
  assert.equal(productSource.syncEvents.length, 1);
  assert.equal(productSource.syncEvents[0]?.eventType, "SOURCE_CAPTURED");

  // Zero MarketplaceListing records fabricated
  const listings = await prisma.marketplaceListing.findMany({
    where: { productId: result.productId },
  });
  assert.equal(listings.length, 0, "Must NEVER fabricate marketplace listings during catalog import");
});

test("CP-02: Repeated catalog persistence for same product updates existing ProductSource and appends SourceSnapshot", async () => {
  const fixturePath = path.resolve(process.cwd(), "tests/fixtures/acmic.html");
  const html = fs.readFileSync(fixturePath, "utf-8");
  const parsed = parseJakmallHtml(html);
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w"
  );
  canonical.sourceProductId = NS_SOURCE_ID;

  // Second persistence run
  const result2 = await persistence.persistCanonicalProduct(canonical);

  const productSource = await prisma.productSource.findUnique({
    where: {
      source_sourceProductId: {
        source: "jakmall",
        sourceProductId: NS_SOURCE_ID,
      },
    },
    include: {
      snapshots: true,
      syncEvents: true,
    },
  });

  assert.ok(productSource);
  assert.equal(result2.productSourceId, productSource.id);
  // Now has 2 snapshots from the 2 imports
  assert.equal(productSource.snapshots.length, 2);
  assert.equal(productSource.syncEvents.length, 2);
});
