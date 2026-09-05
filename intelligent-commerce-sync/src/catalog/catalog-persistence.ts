import type { PrismaClient } from "@prisma/client";
import type { CanonicalProduct } from "../canonical/types.js";
import { computeSnapshotHashes } from "../persistence/hash.js";

export interface PersistedCatalogProduct {
  productId: string;
  productSourceId: string;
  sourceSnapshotId: string;
}

export class CatalogPersistenceService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persists a newly imported CanonicalProduct into the existing PostgreSQL schema.
   * Executes in a single transactional unit:
   * 1. Upserts Product and ProductSource records (idempotent on source + sourceProductId).
   * 2. Upserts all SourceVariant rows.
   * 3. Computes cryptographic snapshot breakdown hashes and creates a durable SourceSnapshot.
   * 4. Emits a SOURCE_CAPTURED SyncEvent for operational traceability.
   *
   * Fails closed without fabricating remote Shopee listings.
   */
  async persistCanonicalProduct(canonical: CanonicalProduct): Promise<PersistedCatalogProduct> {
    const hashes = computeSnapshotHashes(canonical);

    return await this.prisma.$transaction(
      async (tx) => {
      // 1. Locate or create Product & ProductSource
      let productSource = await tx.productSource.findUnique({
        where: {
          source_sourceProductId: {
            source: canonical.source,
            sourceProductId: canonical.sourceProductId,
          },
        },
      });

      let productId: string;

      if (productSource) {
        productId = productSource.productId;
        productSource = await tx.productSource.update({
          where: { id: productSource.id },
          data: {
            sourceUrl: canonical.sourceUrl,
            sourceSellerId: canonical.seller.id ?? null,
            sourceSellerName: canonical.seller.name,
            lastFetchedAt: canonical.fetchedAt,
          },
        });
      } else {
        const product = await tx.product.create({
          data: {},
        });
        productId = product.id;

        productSource = await tx.productSource.create({
          data: {
            productId,
            source: canonical.source,
            sourceProductId: canonical.sourceProductId,
            sourceUrl: canonical.sourceUrl,
            sourceSellerId: canonical.seller.id ?? null,
            sourceSellerName: canonical.seller.name,
            lastFetchedAt: canonical.fetchedAt,
          },
        });
      }

      // 2. Upsert SourceVariant records
      for (const variant of canonical.variants) {
        await tx.sourceVariant.upsert({
          where: {
            productSourceId_sourceSkuId: {
              productSourceId: productSource.id,
              sourceSkuId: variant.sourceSkuId,
            },
          },
          create: {
            productSourceId: productSource.id,
            sourceSkuId: variant.sourceSkuId,
            merchantSku: variant.merchantSku ?? null,
            displaySku: variant.displaySku ?? null,
            attributes: variant.attributes,
            weightGrams: variant.weightGrams ?? null,
            preorder: variant.preorder ? (variant.preorder as any) : undefined,
            sourceMetadata: variant.sourceMetadata ? (variant.sourceMetadata as any) : undefined,
          },
          update: {
            merchantSku: variant.merchantSku ?? null,
            displaySku: variant.displaySku ?? null,
            attributes: variant.attributes,
            weightGrams: variant.weightGrams ?? null,
            preorder: variant.preorder ? (variant.preorder as any) : undefined,
            sourceMetadata: variant.sourceMetadata ? (variant.sourceMetadata as any) : undefined,
          },
        });
      }

      // 3. Create SourceSnapshot with authoritative payload and hashes
      const snapshot = await tx.sourceSnapshot.create({
        data: {
          productSourceId: productSource.id,
          sourceHash: hashes.sourceHash,
          contentHash: hashes.contentHash,
          priceHash: hashes.priceHash,
          inventoryHash: hashes.inventoryHash,
          variantHash: hashes.variantHash,
          canonicalPayload: JSON.parse(JSON.stringify(canonical)),
          sourceFetchedAt: canonical.fetchedAt,
        },
      });

      // 4. Create SOURCE_CAPTURED event
      await tx.syncEvent.create({
        data: {
          productSource: {
            connect: { id: productSource.id },
          },
          sourceSnapshot: {
            connect: { id: snapshot.id },
          },
          eventType: "SOURCE_CAPTURED",
          payload: {
            sourceProductId: canonical.sourceProductId,
            sourceHash: hashes.sourceHash,
            variantCount: canonical.variants.length,
          },
        },
      });

      return {
        productId,
        productSourceId: productSource.id,
        sourceSnapshotId: snapshot.id,
      };
    },
    {
      maxWait: 5000,
      timeout: 10000,
    });
  }
}
