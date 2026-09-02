-- CreateEnum
CREATE TYPE "SyncOperationType" AS ENUM ('CREATE_LISTING', 'UPDATE_PRICE', 'UPDATE_STOCK');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('SOURCE_SYNC', 'PRICE_UPDATE', 'STOCK_UPDATE', 'CONTENT_UPDATE', 'FULL_SYNC');

-- CreateEnum
CREATE TYPE "SyncEventType" AS ENUM ('SOURCE_CAPTURED', 'NO_CHANGE', 'PRICE_CHANGED', 'INVENTORY_CHANGED', 'CONTENT_CHANGED', 'VARIANTS_CHANGED', 'MULTIPLE_CHANGED', 'SYNC_PLANNED', 'SYNC_BLOCKED', 'SYNC_COMPLETED', 'SYNC_FAILED', 'VERIFY_MISMATCH');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sources" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceSellerId" TEXT,
    "sourceSellerName" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_variants" (
    "id" TEXT NOT NULL,
    "productSourceId" TEXT NOT NULL,
    "sourceSkuId" TEXT NOT NULL,
    "merchantSku" TEXT,
    "displaySku" TEXT,
    "attributes" JSONB NOT NULL,
    "weightGrams" INTEGER,
    "preorder" JSONB,
    "sourceMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" TEXT NOT NULL,
    "productSourceId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "priceHash" TEXT NOT NULL,
    "inventoryHash" TEXT NOT NULL,
    "variantHash" TEXT NOT NULL,
    "canonicalPayload" JSONB NOT NULL,
    "sourceFetchedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sellerAccountKey" TEXT NOT NULL,
    "remoteListingId" TEXT,
    "status" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listing_variants" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "sourceSkuId" TEXT NOT NULL,
    "destinationSku" TEXT NOT NULL,
    "remoteVariantId" TEXT,
    "lastKnownDestinationPrice" INTEGER,
    "lastKnownDestinationStock" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listing_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "productSourceId" TEXT,
    "marketplaceListingId" TEXT,
    "sourceSnapshotId" TEXT,
    "operationType" "SyncOperationType" NOT NULL,
    "jobType" "SyncJobType" NOT NULL,
    "executionPayload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "SyncJobStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" TEXT NOT NULL,
    "syncJobId" TEXT,
    "productSourceId" TEXT,
    "marketplaceListingId" TEXT,
    "sourceSnapshotId" TEXT,
    "eventType" "SyncEventType" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "marketplace" TEXT,
    "sellerAccountKey" TEXT,
    "productSourceId" TEXT,
    "syncJobId" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_sources_sourceProductId_idx" ON "product_sources"("sourceProductId");

-- CreateIndex
CREATE UNIQUE INDEX "product_sources_source_sourceProductId_key" ON "product_sources"("source", "sourceProductId");

-- CreateIndex
CREATE INDEX "source_variants_sourceSkuId_idx" ON "source_variants"("sourceSkuId");

-- CreateIndex
CREATE UNIQUE INDEX "source_variants_productSourceId_sourceSkuId_key" ON "source_variants"("productSourceId", "sourceSkuId");

-- CreateIndex
CREATE INDEX "source_snapshots_productSourceId_capturedAt_idx" ON "source_snapshots"("productSourceId", "capturedAt");

-- CreateIndex
CREATE INDEX "source_snapshots_sourceHash_idx" ON "source_snapshots"("sourceHash");

-- CreateIndex
CREATE INDEX "marketplace_listings_productId_marketplace_sellerAccountKey_idx" ON "marketplace_listings"("productId", "marketplace", "sellerAccountKey");

-- CreateIndex
CREATE INDEX "marketplace_listings_marketplace_remoteListingId_idx" ON "marketplace_listings"("marketplace", "remoteListingId");

-- CreateIndex
CREATE INDEX "marketplace_listing_variants_destinationSku_idx" ON "marketplace_listing_variants"("destinationSku");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listing_variants_listingId_sourceSkuId_key" ON "marketplace_listing_variants"("listingId", "sourceSkuId");

-- CreateIndex
CREATE INDEX "sync_jobs_status_createdAt_idx" ON "sync_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "sync_jobs_idempotencyKey_idx" ON "sync_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "sync_events_syncJobId_createdAt_idx" ON "sync_events"("syncJobId", "createdAt");

-- CreateIndex
CREATE INDEX "sync_events_eventType_createdAt_idx" ON "sync_events"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "sync_events_productSourceId_createdAt_idx" ON "sync_events"("productSourceId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_key_key" ON "idempotency_records"("key");

-- CreateIndex
CREATE INDEX "idempotency_records_operationType_status_idx" ON "idempotency_records"("operationType", "status");

-- AddForeignKey
ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_variants" ADD CONSTRAINT "source_variants_productSourceId_fkey" FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_productSourceId_fkey" FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listing_variants" ADD CONSTRAINT "marketplace_listing_variants_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "marketplace_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_productSourceId_fkey" FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_marketplaceListingId_fkey" FOREIGN KEY ("marketplaceListingId") REFERENCES "marketplace_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "source_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_productSourceId_fkey" FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_marketplaceListingId_fkey" FOREIGN KEY ("marketplaceListingId") REFERENCES "marketplace_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "source_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_productSourceId_fkey" FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
