import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../persistence/prisma.js";
import type { CanonicalProduct } from "../../canonical/types.js";
import { buildShopeeDraft } from "../../marketplace/shopee/builder.js";
import type { ShopeePreparationConfig } from "../../marketplace/shopee/types.js";
import type { ShopeePrepareResponse, ShopeePrepareVariantDto } from "../types.js";

export class ShopeePrepareService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async prepareProduct(
    productId: string,
    config: ShopeePreparationConfig = {}
  ): Promise<ShopeePrepareResponse | null> {
    // 1. Find product by internal ID, or by sourceProductId
    const product = await this.prisma.product.findFirst({
      where: {
        OR: [
          { id: productId },
          { sources: { some: { sourceProductId: productId } } },
        ],
      },
      include: {
        sources: {
          include: {
            snapshots: {
              orderBy: { capturedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    if (!product) {
      return null;
    }

    const primarySource = product.sources[0];
    const latestSnapshot = primarySource?.snapshots[0];
    const canonical = latestSnapshot?.canonicalPayload
      ? (latestSnapshot.canonicalPayload as unknown as CanonicalProduct)
      : undefined;

    if (!canonical) {
      throw new Error(`Product ${productId} has no valid canonical snapshot to prepare.`);
    }

    // 2. Delegate to existing certified Shopee builder (DRY_RUN only, no live remote calls)
    const draft = buildShopeeDraft(canonical, config);

    // 3. Map to UI-ready response DTO
    const variants: ShopeePrepareVariantDto[] = draft.variants.map((v) => ({
      sourceSkuId: v.sourceSkuId,
      variationSku: v.shopeeVariationSku,
      attributes: v.attributes,
      sourcePrice: v.pricing.sourceFinalPrice,
      sellingPrice: v.pricing.finalSellingPrice,
      inventoryStatus: v.inventory.status,
      inventoryPolicy: v.inventory.policyApplied,
      destinationStock: v.inventory.destinationStock ?? null,
    }));

    const blockers = draft.validation.issues
      .filter((i) => i.severity === "BLOCKER")
      .map((i) => i.message);

    const warnings = draft.validation.issues
      .filter((i) => i.severity === "WARNING")
      .map((i) => i.message);

    return {
      productId: product.id,
      sourceProductId: canonical.sourceProductId,
      preparedTitle: draft.preparedTitle,
      sourceTitle: draft.sourceTitle,
      sourceBrand: draft.brand ?? null,
      category: {
        suggestion: draft.category.targetCategoryName ?? null,
        targetCategoryId: draft.category.targetCategoryId ?? null,
        status: draft.category.status,
        confidence: draft.category.confidence,
        method: draft.category.method,
      },
      variants,
      validation: {
        ready: draft.validation.validationReady,
        eligibleForApproval: draft.validation.eligibleForApproval,
        canPublish: draft.validation.canPublish,
        blockers,
        warnings,
        issues: draft.validation.issues.map((iss) => ({
          code: iss.code,
          field: iss.field,
          message: iss.message,
          severity: iss.severity,
        })),
      },
      reviewStatus: draft.review?.decision ?? (draft.validation.canPublish ? "APPROVED" : "PENDING"),
    };
  }
}
