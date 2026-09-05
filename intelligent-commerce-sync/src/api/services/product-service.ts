import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../persistence/prisma.js";
import type { ProductDetailDto, ProductListResponse, ProductSummaryDto } from "../types.js";
import type { CanonicalProduct } from "../../canonical/types.js";

export interface ListProductsOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  q?: string | undefined;
  status?: string | undefined;
}

export class ProductService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async listProducts(options: ListProductsOptions = {}): Promise<ProductListResponse> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const searchQuery = options.q?.trim();

    const where: any = {};
    if (searchQuery) {
      where.sources = {
        some: {
          OR: [
            { sourceProductId: { contains: searchQuery, mode: "insensitive" } },
            { sourceUrl: { contains: searchQuery, mode: "insensitive" } },
          ],
        },
      };
    }

    const [total, products] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        include: {
          sources: {
            include: {
              snapshots: {
                orderBy: { capturedAt: "desc" },
                take: 1,
              },
              variants: true,
            },
          },
          marketplaceListings: true,
        },
      }),
    ]);

    const mapped: ProductSummaryDto[] = products.map((p) => {
      const primarySource = p.sources[0];
      const latestSnapshot = primarySource?.snapshots[0];
      const canonical = latestSnapshot?.canonicalPayload
        ? (latestSnapshot.canonicalPayload as unknown as CanonicalProduct)
        : undefined;

      const title = canonical?.title ?? primarySource?.sourceProductId ?? p.id;
      const brand = canonical?.brand ?? null;
      const sourceUrl = primarySource?.sourceUrl ?? "";
      const primaryImage = canonical?.images?.[0]?.url ?? null;
      const variantCount = primarySource?.variants.length ?? canonical?.variants?.length ?? 0;

      let priceRange: { min: number; max: number; currency: string } | null = null;
      if (canonical?.variants && canonical.variants.length > 0) {
        let min = Infinity;
        let max = -Infinity;
        for (const v of canonical.variants) {
          if (v.price.final < min) min = v.price.final;
          if (v.price.final > max) max = v.price.final;
        }
        if (min !== Infinity && max !== -Infinity) {
          priceRange = { min, max, currency: "IDR" };
        }
      }

      let status = "IMPORTED";
      const primaryListing = p.marketplaceListings[0];
      if (primaryListing) {
        status = primaryListing.status;
      }

      return {
        id: p.id,
        sourceProductId: primarySource?.sourceProductId ?? "",
        title,
        brand,
        sourceUrl,
        primaryImage,
        variantCount,
        priceRange,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        status,
      };
    });

    return {
      total,
      limit,
      offset,
      products: mapped,
    };
  }

  async getProductById(id: string): Promise<ProductDetailDto | null> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        sources: {
          include: {
            snapshots: {
              orderBy: { capturedAt: "desc" },
              take: 5,
            },
            variants: true,
          },
        },
        marketplaceListings: true,
      },
    });

    if (!product) {
      return null;
    }

    const primarySource = product.sources[0];
    const latestSnapshot = primarySource?.snapshots[0];
    const canonical = latestSnapshot?.canonicalPayload
      ? (latestSnapshot.canonicalPayload as unknown as CanonicalProduct)
      : null;

    return {
      id: product.id,
      source: {
        type: primarySource?.source ?? "JAKMALL",
        sourceProductId: primarySource?.sourceProductId ?? "",
        url: primarySource?.sourceUrl ?? "",
        sellerName: primarySource?.sourceSellerName ?? null,
        lastFetchedAt: primarySource?.lastFetchedAt?.toISOString() ?? null,
      },
      canonical,
      variants: (primarySource?.variants ?? []).map((v) => ({
        sourceSkuId: v.sourceSkuId,
        merchantSku: v.merchantSku,
        displaySku: v.displaySku,
        attributes: (v.attributes as Record<string, string>) ?? {},
        weightGrams: v.weightGrams,
      })),
      snapshots: (primarySource?.snapshots ?? []).map((s) => ({
        id: s.id,
        capturedAt: s.capturedAt.toISOString(),
        priceHash: s.priceHash,
        sourceHash: s.sourceHash,
      })),
      listings: product.marketplaceListings.map((l) => ({
        id: l.id,
        marketplace: l.marketplace,
        sellerAccountKey: l.sellerAccountKey,
        remoteListingId: l.remoteListingId,
        status: l.status,
      })),
    };
  }
}
