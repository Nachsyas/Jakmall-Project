import type { PrismaClient, SyncJob, Prisma } from "@prisma/client";
import {
  type DurableExecutionPayload,
  assertDurablePayloadReadyForExecution,
  DurableExecutionIdentityError,
} from "../types.js";
import type { SyncJobExecutor } from "../../queue/types.js";
import type { MarketplaceGatewayRegistry } from "./gateway.js";
import {
  type CreateListingCommand,
  type UpdatePriceCommand,
  type UpdateStockCommand,
  MarketplaceExecutionError,
  MarketplaceExecutionUnavailableError,
  MarketplaceTargetIntegrityError,
  MarketplaceVerifyNotFoundError,
  MarketplaceVerifyMismatchError,
  extractResolvedTargetQuantity,
} from "./types.js";
import {
  verifyRemoteListingState,
  type PersistedVariantMappingInfo,
} from "./verification.js";

/**
 * MarketplaceSyncJobExecutor
 *
 * Coordinates durable execution intent into normalized internal marketplace commands,
 * dispatches mutations via MarketplaceExecutionGateway, executes read-after-write verification,
 * and maintains local PostgreSQL marketplace state (MarketplaceListing / MarketplaceListingVariant).
 */
export class MarketplaceSyncJobExecutor implements SyncJobExecutor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gatewayRegistry: MarketplaceGatewayRegistry
  ) {}

  async execute(job: SyncJob, payload: DurableExecutionPayload): Promise<void> {
    // 1. Verify operationType alignment
    if (job.operationType !== payload.operationType) {
      throw new DurableExecutionIdentityError(
        `SyncJob operationType '${job.operationType}' does not match executionPayload operationType '${payload.operationType}'.`
      );
    }

    // 2. Validate that the durable payload is strictly execution-ready
    assertDurablePayloadReadyForExecution(payload);

    // 3. Resolve marketplace gateway
    const gateway = this.gatewayRegistry.getGateway(payload.marketplace);
    if (!gateway) {
      throw new MarketplaceExecutionUnavailableError(payload.marketplace);
    }

    // 4. Validate authoritative ProductSource relation in DB
    if (!job.productSourceId || job.productSourceId.trim().length === 0) {
      throw new MarketplaceTargetIntegrityError(
        `SyncJob '${job.id}' is missing required productSourceId.`
      );
    }

    const productSource = await this.prisma.productSource.findUnique({
      where: { id: job.productSourceId },
    });

    if (!productSource) {
      throw new MarketplaceTargetIntegrityError(
        `ProductSource '${job.productSourceId}' not found in database for SyncJob '${job.id}'.`
      );
    }

    // 5. Strengthen runtime source identity checks without recomputing business logic
    if (productSource.source !== payload.source) {
      throw new MarketplaceTargetIntegrityError(
        `ProductSource source '${productSource.source}' does not match payload source '${payload.source}'.`
      );
    }

    if (productSource.sourceProductId !== payload.sourceProductId) {
      throw new MarketplaceTargetIntegrityError(
        `ProductSource sourceProductId '${productSource.sourceProductId}' does not match payload sourceProductId '${payload.sourceProductId}'.`
      );
    }

    if (!job.sourceSnapshotId || job.sourceSnapshotId.trim().length === 0) {
      throw new MarketplaceTargetIntegrityError(
        `SyncJob '${job.id}' is missing required sourceSnapshotId.`
      );
    }

    if (job.sourceSnapshotId !== payload.sourceSnapshotId) {
      throw new MarketplaceTargetIntegrityError(
        `SyncJob sourceSnapshotId '${job.sourceSnapshotId}' does not match payload sourceSnapshotId '${payload.sourceSnapshotId}'.`
      );
    }

    const sourceSnapshot = await this.prisma.sourceSnapshot.findUnique({
      where: { id: job.sourceSnapshotId },
    });

    if (!sourceSnapshot) {
      throw new MarketplaceTargetIntegrityError(
        `SourceSnapshot '${job.sourceSnapshotId}' not found in database for SyncJob '${job.id}'.`
      );
    }

    if (sourceSnapshot.productSourceId !== productSource.id) {
      throw new MarketplaceTargetIntegrityError(
        `SourceSnapshot productSourceId '${sourceSnapshot.productSourceId}' does not match authoritative ProductSource id '${productSource.id}'.`
      );
    }

    switch (payload.operationType) {
      case "CREATE_LISTING": {
        await this.executeCreateListing(job, payload, productSource.productId, gateway);
        break;
      }
      case "UPDATE_PRICE": {
        await this.executeUpdatePrice(job, payload, productSource.productId, gateway);
        break;
      }
      case "UPDATE_STOCK": {
        await this.executeUpdateStock(job, payload, productSource.productId, gateway);
        break;
      }
      default: {
        const _exhaustive: never = payload;
        throw new Error(`Unhandled operationType: ${String(_exhaustive)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // CREATE_LISTING EXECUTION
  // --------------------------------------------------------------------------
  private async executeCreateListing(
    job: SyncJob,
    payload: Extract<DurableExecutionPayload, { operationType: "CREATE_LISTING" }>,
    productId: string,
    gateway: import("./gateway.js").MarketplaceExecutionGateway
  ): Promise<void> {
    // 1. Pre-mutation local target preflight: fail closed on knowable local inconsistencies BEFORE gateway mutation
    if (job.marketplaceListingId) {
      const preflightListing = await this.prisma.marketplaceListing.findUnique({
        where: { id: job.marketplaceListingId },
        include: { variants: true },
      });

      if (!preflightListing) {
        throw new MarketplaceTargetIntegrityError(
          `MarketplaceListing '${job.marketplaceListingId}' specified on SyncJob '${job.id}' was not found in database.`
        );
      }

      if (preflightListing.productId !== productId) {
        throw new MarketplaceTargetIntegrityError(
          `MarketplaceListing '${preflightListing.id}' productId '${preflightListing.productId}' does not match authoritative ProductSource productId '${productId}'.`
        );
      }

      if (preflightListing.marketplace !== payload.marketplace) {
        throw new MarketplaceTargetIntegrityError(
          `MarketplaceListing '${preflightListing.id}' marketplace '${preflightListing.marketplace}' does not match payload marketplace '${payload.marketplace}'.`
        );
      }

      if (preflightListing.sellerAccountKey !== payload.sellerAccountKey) {
        throw new MarketplaceTargetIntegrityError(
          `MarketplaceListing '${preflightListing.id}' sellerAccountKey '${preflightListing.sellerAccountKey}' does not match payload sellerAccountKey '${payload.sellerAccountKey}'.`
        );
      }

      for (const v of payload.variants) {
        const existingVariant = preflightListing.variants.find(
          (lv) => lv.sourceSkuId === v.sourceSkuId
        );
        if (existingVariant && existingVariant.destinationSku !== v.destinationSku) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${preflightListing.id}' variant for '${v.sourceSkuId}' destinationSku '${existingVariant.destinationSku}' conflicts with durable destinationSku '${v.destinationSku}'.`
          );
        }
      }
    }

    // Build normalized CREATE command with fail-closed resolved inventory quantity
    const command: CreateListingCommand = {
      schemaVersion: 1,
      operationType: "CREATE_LISTING",
      marketplace: payload.marketplace,
      sellerAccountKey: payload.sellerAccountKey,
      idempotencyKey: job.idempotencyKey,
      sourceProductId: payload.sourceProductId,
      preparedTitle: payload.preparedTitle,
      preparedDescription: payload.preparedDescription,
      targetCategoryId: payload.targetCategoryId!,
      targetCategoryName: payload.targetCategoryName,
      brand: payload.brand,
      totalWeightGrams: payload.totalWeightGrams,
      images: payload.images.map((img) => img.url),
      variants: payload.variants.map((v) => ({
        sourceSkuId: v.sourceSkuId,
        destinationSku: v.destinationSku,
        attributes: v.attributes,
        targetPriceIdr: v.targetPriceIdr,
        targetQuantity: extractResolvedTargetQuantity(v.inventory, v.sourceSkuId),
      })),
    };

    // Execute mutation on marketplace gateway
    const mutationResult = await gateway.createListing(command);
    const remoteListingId = mutationResult.remoteListingId;

    if (!remoteListingId || remoteListingId.trim().length === 0) {
      throw new MarketplaceTargetIntegrityError(
        "Marketplace gateway did not return a valid remoteListingId for CREATE_LISTING."
      );
    }

    // Validate gateway variantMappings: no duplicates, no unknown SKUs, no blank remoteVariantId
    const gatewayVariantMap = new Map<string, string>();
    if (mutationResult.variantMappings) {
      const seenSkus = new Set<string>();
      for (const vm of mutationResult.variantMappings) {
        if (!vm.sourceSkuId || vm.sourceSkuId.trim().length === 0) {
          throw new MarketplaceTargetIntegrityError(
            "Gateway variantMapping contains blank sourceSkuId."
          );
        }
        if (seenSkus.has(vm.sourceSkuId)) {
          throw new MarketplaceTargetIntegrityError(
            `Gateway variantMapping contains duplicate sourceSkuId '${vm.sourceSkuId}'.`
          );
        }
        seenSkus.add(vm.sourceSkuId);

        if (!payload.variants.some((pv) => pv.sourceSkuId === vm.sourceSkuId)) {
          throw new MarketplaceTargetIntegrityError(
            `Gateway variantMapping contains unknown sourceSkuId '${vm.sourceSkuId}' not present in durable payload.`
          );
        }

        if (
          vm.remoteVariantId !== undefined &&
          (typeof vm.remoteVariantId !== "string" || vm.remoteVariantId.trim().length === 0)
        ) {
          throw new MarketplaceTargetIntegrityError(
            `Gateway variantMapping for sourceSkuId '${vm.sourceSkuId}' contains blank remoteVariantId.`
          );
        }

        if (vm.remoteVariantId) {
          gatewayVariantMap.set(vm.sourceSkuId, vm.remoteVariantId);
        }
      }
    }

    // Local publication persistence & reconciliation inside PostgreSQL
    const resolvedListing = await this.prisma.$transaction(async (tx) => {
      let listing = null;

      // 1. If job.marketplaceListingId exists: validate listing, product, marketplace, sellerAccountKey, remoteListingId
      if (job.marketplaceListingId) {
        listing = await tx.marketplaceListing.findUnique({
          where: { id: job.marketplaceListingId },
          include: { variants: true },
        });

        if (!listing) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${job.marketplaceListingId}' specified on SyncJob '${job.id}' was not found in database.`
          );
        }

        if (listing.productId !== productId) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${listing.id}' productId '${listing.productId}' does not match authoritative ProductSource productId '${productId}'.`
          );
        }

        if (listing.marketplace !== payload.marketplace) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${listing.id}' marketplace '${listing.marketplace}' does not match payload marketplace '${payload.marketplace}'.`
          );
        }

        if (listing.sellerAccountKey !== payload.sellerAccountKey) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${listing.id}' sellerAccountKey '${listing.sellerAccountKey}' does not match payload sellerAccountKey '${payload.sellerAccountKey}'.`
          );
        }

        if (!listing.remoteListingId) {
          // Verify no other listing owns this remote binding
          const conflictingListing = await tx.marketplaceListing.findFirst({
            where: {
              marketplace: payload.marketplace,
              sellerAccountKey: payload.sellerAccountKey,
              remoteListingId,
              id: { not: listing.id },
            },
          });

          if (conflictingListing) {
            throw new MarketplaceTargetIntegrityError(
              `Cannot bind remoteListingId '${remoteListingId}' to MarketplaceListing '${listing.id}': another listing '${conflictingListing.id}' already owns this remote binding.`
            );
          }

          await tx.marketplaceListing.update({
            where: { id: listing.id },
            data: { remoteListingId },
          });
          listing.remoteListingId = remoteListingId;
        } else if (listing.remoteListingId !== remoteListingId) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${listing.id}' remoteListingId '${listing.remoteListingId}' conflicts with gateway-returned remoteListingId '${remoteListingId}'.`
          );
        }
      }

      // 2. If resolving existing listing by remoteListingId (when job.marketplaceListingId is not set)
      if (!listing) {
        const matchingListings = await tx.marketplaceListing.findMany({
          where: {
            marketplace: payload.marketplace,
            sellerAccountKey: payload.sellerAccountKey,
            remoteListingId,
          },
          include: { variants: true },
          take: 2,
        });

        if (matchingListings.length > 1) {
          throw new MarketplaceTargetIntegrityError(
            `Ambiguous local remote identity: multiple MarketplaceListings exist for marketplace '${payload.marketplace}', sellerAccountKey '${payload.sellerAccountKey}', and remoteListingId '${remoteListingId}'.`
          );
        }

        if (matchingListings.length === 1) {
          const existingByRemote = matchingListings[0]!;
          if (existingByRemote.productId !== productId) {
            throw new MarketplaceTargetIntegrityError(
              `Existing remote listing '${remoteListingId}' belongs to product '${existingByRemote.productId}', cannot associate with '${productId}'.`
            );
          }
          if (existingByRemote.marketplace !== payload.marketplace) {
            throw new MarketplaceTargetIntegrityError(
              `Existing remote listing '${remoteListingId}' marketplace '${existingByRemote.marketplace}' does not match payload marketplace '${payload.marketplace}'.`
            );
          }
          if (existingByRemote.sellerAccountKey !== payload.sellerAccountKey) {
            throw new MarketplaceTargetIntegrityError(
              `Existing remote listing '${remoteListingId}' sellerAccountKey '${existingByRemote.sellerAccountKey}' does not match payload sellerAccountKey '${payload.sellerAccountKey}'.`
            );
          }
          listing = existingByRemote;
        }
      }

      // 3. If no listing exists, create new MarketplaceListing
      if (!listing) {
        listing = await tx.marketplaceListing.create({
          data: {
            productId,
            marketplace: payload.marketplace,
            sellerAccountKey: payload.sellerAccountKey,
            remoteListingId,
            status: "PUBLISHED",
          },
          include: { variants: true },
        });
      }

      // 4. Reconcile variant mappings transactionally
      for (const v of payload.variants) {
        const localMatches = listing.variants.filter((lv) => lv.sourceSkuId === v.sourceSkuId);
        if (localMatches.length > 1) {
          throw new MarketplaceTargetIntegrityError(
            `MarketplaceListing '${listing.id}' contains duplicate local mappings for sourceSkuId '${v.sourceSkuId}'.`
          );
        }

        const gatewayRemoteVarId = gatewayVariantMap.get(v.sourceSkuId) ?? null;

        if (localMatches.length === 1) {
          const existing = localMatches[0]!;
          if (existing.destinationSku !== v.destinationSku) {
            throw new MarketplaceTargetIntegrityError(
              `MarketplaceListing '${listing.id}' variant for '${v.sourceSkuId}' destinationSku '${existing.destinationSku}' conflicts with durable destinationSku '${v.destinationSku}'.`
            );
          }

          if (!existing.remoteVariantId && gatewayRemoteVarId) {
            await tx.marketplaceListingVariant.update({
              where: { id: existing.id },
              data: { remoteVariantId: gatewayRemoteVarId },
            });
            existing.remoteVariantId = gatewayRemoteVarId;
          } else if (
            existing.remoteVariantId &&
            gatewayRemoteVarId &&
            existing.remoteVariantId !== gatewayRemoteVarId
          ) {
            throw new MarketplaceTargetIntegrityError(
              `MarketplaceListing '${listing.id}' variant for '${v.sourceSkuId}' remoteVariantId '${existing.remoteVariantId}' conflicts with gateway remoteVariantId '${gatewayRemoteVarId}'.`
            );
          }
        } else {
          // Mapping is absent -> create it
          const createdVar = await tx.marketplaceListingVariant.create({
            data: {
              listingId: listing.id,
              sourceSkuId: v.sourceSkuId,
              destinationSku: v.destinationSku,
              remoteVariantId: gatewayRemoteVarId,
            },
          });
          listing.variants.push(createdVar);
        }
      }

      // Ensure SyncJob points to resolved listing
      if (job.marketplaceListingId !== listing.id) {
        await tx.syncJob.update({
          where: { id: job.id },
          data: { marketplaceListingId: listing.id },
        });
      }

      return listing;
    });

    // Read-after-write verification
    const remoteState = await gateway.readListingState(remoteListingId);
    if (!remoteState) {
      throw new MarketplaceVerifyNotFoundError(remoteListingId);
    }

    const verification = verifyRemoteListingState(payload, remoteState, remoteListingId);

    if (!verification.verified) {
      await this.prisma.$transaction([
        this.prisma.syncEvent.create({
          data: {
            syncJobId: job.id,
            productSourceId: job.productSourceId,
            marketplaceListingId: resolvedListing.id,
            sourceSnapshotId: job.sourceSnapshotId,
            eventType: "VERIFY_MISMATCH",
            payload: {
              operationType: "CREATE_LISTING",
              remoteListingId,
              mismatches: verification.mismatches,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.marketplaceListing.update({
          where: { id: resolvedListing.id },
          data: {
            status: "NEEDS_REVIEW",
            lastVerifiedAt: new Date(),
          },
        }),
      ]);

      throw new MarketplaceVerifyMismatchError(
        `Read-after-write verification failed for CREATE_LISTING on remoteListingId '${remoteListingId}'.`,
        verification.mismatches
      );
    }

    // Success persistence with exact count check
    await this.prisma.$transaction(async (tx) => {
      await tx.marketplaceListing.update({
        where: { id: resolvedListing.id },
        data: {
          status: "VERIFIED",
          lastVerifiedAt: new Date(),
        },
      });

      for (const v of payload.variants) {
        const expectedStock = extractResolvedTargetQuantity(v.inventory, v.sourceSkuId);
        const updateRes = await tx.marketplaceListingVariant.updateMany({
          where: {
            listingId: resolvedListing.id,
            sourceSkuId: v.sourceSkuId,
          },
          data: {
            lastKnownDestinationPrice: v.targetPriceIdr,
            lastKnownDestinationStock: expectedStock,
          },
        });

        if (updateRes.count !== 1) {
          throw new MarketplaceTargetIntegrityError(
            `Failed to persist verified variant state: expected exactly 1 variant for listing '${resolvedListing.id}' and SKU '${v.sourceSkuId}', updated ${updateRes.count}.`
          );
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // UPDATE_PRICE EXECUTION
  // --------------------------------------------------------------------------
  private async executeUpdatePrice(
    job: SyncJob,
    payload: Extract<DurableExecutionPayload, { operationType: "UPDATE_PRICE" }>,
    productId: string,
    gateway: import("./gateway.js").MarketplaceExecutionGateway
  ): Promise<void> {
    const { listing, variantMap } = await this.validateAndLoadUpdateTarget(
      job,
      payload.remoteListingId!,
      payload.marketplace,
      payload.sellerAccountKey,
      productId,
      payload.variants.map((v) => v.sourceSkuId)
    );

    const command: UpdatePriceCommand = {
      schemaVersion: 1,
      operationType: "UPDATE_PRICE",
      marketplace: payload.marketplace,
      sellerAccountKey: payload.sellerAccountKey,
      idempotencyKey: job.idempotencyKey,
      remoteListingId: payload.remoteListingId!,
      variants: payload.variants.map((v) => {
        const mapping = variantMap.get(v.sourceSkuId)!;
        return {
          sourceSkuId: v.sourceSkuId,
          destinationSku: mapping.destinationSku,
          remoteVariantId: mapping.remoteVariantId ?? undefined,
          targetPriceIdr: v.targetPriceIdr,
        };
      }),
    };

    const mutationResult = await gateway.updatePrice(command);
    if (!mutationResult || mutationResult.success !== true) {
      throw new MarketplaceExecutionError(
        `Marketplace gateway updatePrice mutation returned unsuccessful result for remoteListingId '${payload.remoteListingId}'.`,
        "MARKETPLACE_MUTATION_FAILED"
      );
    }

    const remoteState = await gateway.readListingState(payload.remoteListingId!);
    if (!remoteState) {
      throw new MarketplaceVerifyNotFoundError(payload.remoteListingId!);
    }

    const verification = verifyRemoteListingState(
      payload,
      remoteState,
      payload.remoteListingId!,
      variantMap
    );

    if (!verification.verified) {
      await this.prisma.$transaction([
        this.prisma.syncEvent.create({
          data: {
            syncJobId: job.id,
            productSourceId: job.productSourceId,
            marketplaceListingId: listing.id,
            sourceSnapshotId: job.sourceSnapshotId,
            eventType: "VERIFY_MISMATCH",
            payload: {
              operationType: "UPDATE_PRICE",
              remoteListingId: payload.remoteListingId,
              mismatches: verification.mismatches,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.marketplaceListing.update({
          where: { id: listing.id },
          data: {
            status: "NEEDS_REVIEW",
            lastVerifiedAt: new Date(),
          },
        }),
      ]);

      throw new MarketplaceVerifyMismatchError(
        `Read-after-write verification failed for UPDATE_PRICE on remoteListingId '${payload.remoteListingId}'.`,
        verification.mismatches
      );
    }

    // Success persistence for affected variants with exact count check
    await this.prisma.$transaction(async (tx) => {
      await tx.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          status: "VERIFIED",
          lastVerifiedAt: new Date(),
        },
      });

      for (const v of payload.variants) {
        const updateRes = await tx.marketplaceListingVariant.updateMany({
          where: {
            listingId: listing.id,
            sourceSkuId: v.sourceSkuId,
          },
          data: {
            lastKnownDestinationPrice: v.targetPriceIdr,
          },
        });

        if (updateRes.count !== 1) {
          throw new MarketplaceTargetIntegrityError(
            `Failed to persist verified variant price: expected exactly 1 variant for listing '${listing.id}' and SKU '${v.sourceSkuId}', updated ${updateRes.count}.`
          );
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // UPDATE_STOCK EXECUTION
  // --------------------------------------------------------------------------
  private async executeUpdateStock(
    job: SyncJob,
    payload: Extract<DurableExecutionPayload, { operationType: "UPDATE_STOCK" }>,
    productId: string,
    gateway: import("./gateway.js").MarketplaceExecutionGateway
  ): Promise<void> {
    const { listing, variantMap } = await this.validateAndLoadUpdateTarget(
      job,
      payload.remoteListingId!,
      payload.marketplace,
      payload.sellerAccountKey,
      productId,
      payload.variants.map((v) => v.sourceSkuId)
    );

    const command: UpdateStockCommand = {
      schemaVersion: 1,
      operationType: "UPDATE_STOCK",
      marketplace: payload.marketplace,
      sellerAccountKey: payload.sellerAccountKey,
      idempotencyKey: job.idempotencyKey,
      remoteListingId: payload.remoteListingId!,
      variants: payload.variants.map((v) => {
        const mapping = variantMap.get(v.sourceSkuId)!;
        const targetQuantity = extractResolvedTargetQuantity(v.inventory, v.sourceSkuId);
        return {
          sourceSkuId: v.sourceSkuId,
          destinationSku: mapping.destinationSku,
          remoteVariantId: mapping.remoteVariantId ?? undefined,
          targetQuantity,
        };
      }),
    };

    const mutationResult = await gateway.updateStock(command);
    if (!mutationResult || mutationResult.success !== true) {
      throw new MarketplaceExecutionError(
        `Marketplace gateway updateStock mutation returned unsuccessful result for remoteListingId '${payload.remoteListingId}'.`,
        "MARKETPLACE_MUTATION_FAILED"
      );
    }

    const remoteState = await gateway.readListingState(payload.remoteListingId!);
    if (!remoteState) {
      throw new MarketplaceVerifyNotFoundError(payload.remoteListingId!);
    }

    const verification = verifyRemoteListingState(
      payload,
      remoteState,
      payload.remoteListingId!,
      variantMap
    );

    if (!verification.verified) {
      await this.prisma.$transaction([
        this.prisma.syncEvent.create({
          data: {
            syncJobId: job.id,
            productSourceId: job.productSourceId,
            marketplaceListingId: listing.id,
            sourceSnapshotId: job.sourceSnapshotId,
            eventType: "VERIFY_MISMATCH",
            payload: {
              operationType: "UPDATE_STOCK",
              remoteListingId: payload.remoteListingId,
              mismatches: verification.mismatches,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.marketplaceListing.update({
          where: { id: listing.id },
          data: {
            status: "NEEDS_REVIEW",
            lastVerifiedAt: new Date(),
          },
        }),
      ]);

      throw new MarketplaceVerifyMismatchError(
        `Read-after-write verification failed for UPDATE_STOCK on remoteListingId '${payload.remoteListingId}'.`,
        verification.mismatches
      );
    }

    // Success persistence for affected variants with exact count check
    await this.prisma.$transaction(async (tx) => {
      await tx.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          status: "VERIFIED",
          lastVerifiedAt: new Date(),
        },
      });

      for (const v of payload.variants) {
        const expectedStock = extractResolvedTargetQuantity(v.inventory, v.sourceSkuId);
        const updateRes = await tx.marketplaceListingVariant.updateMany({
          where: {
            listingId: listing.id,
            sourceSkuId: v.sourceSkuId,
          },
          data: {
            lastKnownDestinationStock: expectedStock,
          },
        });

        if (updateRes.count !== 1) {
          throw new MarketplaceTargetIntegrityError(
            `Failed to persist verified variant stock: expected exactly 1 variant for listing '${listing.id}' and SKU '${v.sourceSkuId}', updated ${updateRes.count}.`
          );
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // SHARED UPDATE TARGET INTEGRITY VALIDATOR
  // --------------------------------------------------------------------------
  private async validateAndLoadUpdateTarget(
    job: SyncJob,
    payloadRemoteListingId: string,
    payloadMarketplace: string,
    payloadSellerAccountKey: string,
    expectedProductId: string,
    targetSourceSkuIds: string[]
  ): Promise<{
    listing: { id: string; marketplace: string; sellerAccountKey: string; remoteListingId: string | null };
    variantMap: Map<string, PersistedVariantMappingInfo>;
  }> {
    if (!job.marketplaceListingId || job.marketplaceListingId.trim().length === 0) {
      throw new MarketplaceTargetIntegrityError(
        `SyncJob '${job.id}' is missing required marketplaceListingId for update operation.`
      );
    }

    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: job.marketplaceListingId },
      include: { variants: true },
    });

    if (!listing) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing '${job.marketplaceListingId}' not found for SyncJob '${job.id}'.`
      );
    }

    if (!listing.remoteListingId || listing.remoteListingId.trim().length === 0) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing '${listing.id}' has no remoteListingId.`
      );
    }

    if (listing.remoteListingId !== payloadRemoteListingId) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing remoteListingId '${listing.remoteListingId}' does not match payload remoteListingId '${payloadRemoteListingId}'.`
      );
    }

    if (listing.marketplace !== payloadMarketplace) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing marketplace '${listing.marketplace}' does not match payload marketplace '${payloadMarketplace}'.`
      );
    }

    if (listing.sellerAccountKey !== payloadSellerAccountKey) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing sellerAccountKey '${listing.sellerAccountKey}' does not match payload sellerAccountKey '${payloadSellerAccountKey}'.`
      );
    }

    if (listing.productId !== expectedProductId) {
      throw new MarketplaceTargetIntegrityError(
        `MarketplaceListing productId '${listing.productId}' does not match ProductSource productId '${expectedProductId}'.`
      );
    }

    const variantMap = new Map<string, PersistedVariantMappingInfo>();
    for (const v of listing.variants) {
      variantMap.set(v.sourceSkuId, {
        destinationSku: v.destinationSku,
        remoteVariantId: v.remoteVariantId,
      });
    }

    for (const sourceSkuId of targetSourceSkuIds) {
      if (!variantMap.has(sourceSkuId)) {
        throw new MarketplaceTargetIntegrityError(
          `MarketplaceListing '${listing.id}' has no persisted variant mapping for sourceSkuId '${sourceSkuId}'.`
        );
      }
    }

    return { listing, variantMap };
  }
}
