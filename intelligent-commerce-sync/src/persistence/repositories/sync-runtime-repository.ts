import type {
  IdempotencyRecord,
  Prisma,
  PrismaClient,
  SyncEvent,
  SyncJob,
  SyncJobStatus,
  SyncOperationType as PrismaSyncOperationType,
} from "@prisma/client";
import { z } from "zod";
import {
  type CreateListingExecutionPayload,
  type DurableExecutionPayload,
  DurableExecutionIdentityError,
  DurablePayloadValidationError,
  mapSyncOperationTypeToJobType,
  PayloadImmutabilityViolationError,
  type ResolveReviewExecutionTargetParams,
  type UpdatePriceExecutionPayload,
  type UpdateStockExecutionPayload,
  assertPayloadExecutionEligibility,
} from "../../execution/types.js";
import { validateDurableExecutionPayload } from "../../execution/durable-payload.js";
import type { SyncPlannedOperation } from "../../sync/types.js";
import {
  generateSyncBaseOperationKey,
  generateSyncOperationIdempotencyKey,
} from "../../sync/idempotency.js";
import { getPrismaClient } from "../prisma.js";

export interface ReserveSyncJobParams {
  operation: SyncPlannedOperation;
  payload: DurableExecutionPayload;
  productSourceId: string;
  sourceSnapshotId: string;
  marketplaceListingId?: string | undefined;
}

export type ReserveSyncJobOutcome =
  | {
      status: "CREATED";
      syncJob: SyncJob;
      idempotencyRecord: IdempotencyRecord;
      event: SyncEvent;
    }
  | {
      status: "EXISTING_RESERVATION";
      syncJob: SyncJob | null;
      idempotencyRecord: IdempotencyRecord;
    };

export interface ReplaceReviewPayloadParams {
  syncJobId: string;
  newPayload: DurableExecutionPayload;
  reviewedBy?: string | undefined;
  notes?: string | undefined;
}

const canonicalSnapshotVariantsSchema = z.object({
  variants: z
    .array(
      z.object({
        sourceSkuId: z.string().trim().min(1, "sourceSkuId must be a non-empty string"),
      })
    )
    .min(1, "canonicalPayload.variants must not be empty"),
});

/**
 * Fail-closed extractor for variant SKUs from SourceSnapshot.canonicalPayload.
 * Ensures the payload has a valid variants array, is non-empty, and contains no duplicate SKUs.
 */
export function extractCanonicalSnapshotSkuSet(canonicalPayload: unknown): Set<string> {
  const parsedCanonical = canonicalSnapshotVariantsSchema.safeParse(canonicalPayload);
  if (!parsedCanonical.success) {
    const issues = parsedCanonical.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new DurableExecutionIdentityError(
      `Invalid SourceSnapshot canonicalPayload variant structure: ${issues}`
    );
  }

  const snapshotSkuSet = new Set<string>();
  for (const v of parsedCanonical.data.variants) {
    if (snapshotSkuSet.has(v.sourceSkuId)) {
      throw new DurableExecutionIdentityError(
        `Duplicate sourceSkuId '${v.sourceSkuId}' in SourceSnapshot canonicalPayload variants.`
      );
    }
    snapshotSkuSet.add(v.sourceSkuId);
  }

  return snapshotSkuSet;
}

/**
 * Checks if a Prisma error corresponds to a verified P2002 unique constraint violation on IdempotencyRecord.key.
 * Fails closed and conservatively rejects unrelated unique constraints or generic 'key' substring collisions.
 */
export function isIdempotencyKeyUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; meta?: { target?: unknown } };
  if (err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  if (!target) {
    return false;
  }
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === "string" && t === "key");
  }
  if (typeof target === "string") {
    if (target === "key") {
      return true;
    }
    const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized.includes("idempotency") && normalized.includes("key");
  }
  return false;
}

/**
 * Validates invariant consistency between planned operation and execution payload,
 * and cryptographically verifies baseOperationKey and idempotencyKey integrity.
 */
function assertOperationPayloadAndKeyIntegrity(
  operation: SyncPlannedOperation,
  payload: DurableExecutionPayload
): void {
  if (operation.operationType !== payload.operationType) {
    throw new DurablePayloadValidationError(
      `Operation type mismatch between plan ('${operation.operationType}') and payload ('${payload.operationType}').`
    );
  }
  if (operation.marketplace !== payload.marketplace) {
    throw new DurablePayloadValidationError(
      `Marketplace mismatch: plan has '${operation.marketplace}', payload has '${payload.marketplace}'.`
    );
  }
  if (operation.sellerAccountKey !== payload.sellerAccountKey) {
    throw new DurablePayloadValidationError(
      `Seller account key mismatch: plan has '${operation.sellerAccountKey}', payload has '${payload.sellerAccountKey}'.`
    );
  }
  if (operation.source !== payload.source) {
    throw new DurablePayloadValidationError(
      `Source mismatch: plan has '${operation.source}', payload has '${payload.source}'.`
    );
  }
  if (operation.sourceProductId !== payload.sourceProductId) {
    throw new DurablePayloadValidationError(
      `Source product ID mismatch: plan has '${operation.sourceProductId}', payload has '${payload.sourceProductId}'.`
    );
  }

  // 1. Verify baseOperationKey integrity
  const expectedBaseOperationKey = generateSyncBaseOperationKey({
    marketplace: operation.marketplace,
    sellerAccountKey: operation.sellerAccountKey,
    source: operation.source,
    sourceProductId: operation.sourceProductId,
    operationType: operation.operationType,
  });

  if (operation.baseOperationKey !== expectedBaseOperationKey) {
    throw new DurablePayloadValidationError(
      `baseOperationKey integrity check failed: operation has '${operation.baseOperationKey}', expected '${expectedBaseOperationKey}'.`
    );
  }

  // 2. Verify idempotencyKey integrity
  const expectedIdempotencyKey = generateSyncOperationIdempotencyKey({
    marketplace: operation.marketplace,
    sellerAccountKey: operation.sellerAccountKey,
    source: operation.source,
    sourceProductId: operation.sourceProductId,
    operationType: operation.operationType,
    sourceSnapshotId:
      operation.operationType === "CREATE_LISTING" ? undefined : payload.sourceSnapshotId,
  });

  if (operation.idempotencyKey !== expectedIdempotencyKey) {
    throw new DurablePayloadValidationError(
      `idempotencyKey integrity check failed: operation has '${operation.idempotencyKey}', expected '${expectedIdempotencyKey}'.`
    );
  }
}

/**
 * Validates an existing IdempotencyRecord and its linked SyncJob against the requested parameters.
 */
export function validateExistingReservationAgainstRequest(
  existingRecord: IdempotencyRecord,
  existingJob: SyncJob | null,
  params: ReserveSyncJobParams
): ReserveSyncJobOutcome {
  const { operation, productSourceId, sourceSnapshotId, marketplaceListingId } = params;

  if (existingRecord.key !== operation.idempotencyKey) {
    throw new DurableExecutionIdentityError(
      `Existing reservation key mismatch: record has '${existingRecord.key}', expected '${operation.idempotencyKey}'.`
    );
  }
  if (existingRecord.operationType !== operation.operationType) {
    throw new DurableExecutionIdentityError(
      `Existing reservation operationType mismatch: record has '${existingRecord.operationType}', expected '${operation.operationType}'.`
    );
  }
  if (existingRecord.marketplace !== operation.marketplace) {
    throw new DurableExecutionIdentityError(
      `Existing reservation marketplace mismatch: record has '${existingRecord.marketplace}', expected '${operation.marketplace}'.`
    );
  }
  if (existingRecord.sellerAccountKey !== operation.sellerAccountKey) {
    throw new DurableExecutionIdentityError(
      `Existing reservation sellerAccountKey mismatch: record has '${existingRecord.sellerAccountKey}', expected '${operation.sellerAccountKey}'.`
    );
  }
  if (existingRecord.productSourceId !== productSourceId) {
    throw new DurableExecutionIdentityError(
      `Existing reservation productSourceId mismatch: record has '${existingRecord.productSourceId}', expected '${productSourceId}'.`
    );
  }

  if (!existingRecord.syncJobId) {
    throw new DurableExecutionIdentityError(
      `Existing idempotency record '${existingRecord.id}' has null syncJobId.`
    );
  }

  if (!existingJob) {
    throw new DurableExecutionIdentityError(
      `Existing SyncJob '${existingRecord.syncJobId}' linked to idempotency record not found.`
    );
  }

  if (existingJob.idempotencyKey !== operation.idempotencyKey) {
    throw new DurableExecutionIdentityError(
      `Existing SyncJob idempotencyKey mismatch: job has '${existingJob.idempotencyKey}', expected '${operation.idempotencyKey}'.`
    );
  }
  if (existingJob.operationType !== operation.operationType) {
    throw new DurableExecutionIdentityError(
      `Existing SyncJob operationType mismatch: job has '${existingJob.operationType}', expected '${operation.operationType}'.`
    );
  }
  if (existingJob.productSourceId !== productSourceId) {
    throw new DurableExecutionIdentityError(
      `Existing SyncJob productSourceId mismatch: job has '${existingJob.productSourceId}', expected '${productSourceId}'.`
    );
  }

  if (operation.operationType === "UPDATE_PRICE" || operation.operationType === "UPDATE_STOCK") {
    if (existingJob.sourceSnapshotId !== sourceSnapshotId) {
      throw new DurableExecutionIdentityError(
        `Existing SyncJob sourceSnapshotId mismatch for update operation: job has '${existingJob.sourceSnapshotId}', expected '${sourceSnapshotId}'.`
      );
    }
  }

  if (marketplaceListingId && existingJob.marketplaceListingId !== marketplaceListingId) {
    throw new DurableExecutionIdentityError(
      `Existing SyncJob marketplaceListingId mismatch: job has '${existingJob.marketplaceListingId}', expected '${marketplaceListingId}'.`
    );
  }

  return {
    status: "EXISTING_RESERVATION",
    syncJob: existingJob,
    idempotencyRecord: existingRecord,
  };
}

/**
 * Derives initial SyncJobStatus from the planned operation's eligibility.
 */
export function deriveInitialSyncJobStatus(
  operation: SyncPlannedOperation
): SyncJobStatus {
  switch (operation.eligibility) {
    case "ELIGIBLE":
      return "PENDING";
    case "REQUIRES_REVIEW":
      return "NEEDS_REVIEW";
    case "BLOCKED":
      return "BLOCKED";
    default: {
      const _exhaustive: never = operation.eligibility;
      throw new Error(`Unhandled SyncOperationEligibility: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Dedicated repository for durable synchronization job persistence, idempotency reservation,
 * and immutable execution payload lifecycle management.
 */
export class SyncRuntimeRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  /**
   * Atomically reserves an idempotency record and creates a durable SyncJob.
   * If an IdempotencyRecord already exists for the given idempotencyKey (or if a concurrent
   * race encounters a verified P2002 unique constraint violation), returns the existing reservation
   * after verifying its integrity against the request parameters.
   */
  async reserveSyncJob(params: ReserveSyncJobParams): Promise<ReserveSyncJobOutcome> {
    const { operation, productSourceId, marketplaceListingId, sourceSnapshotId } = params;

    if (!productSourceId || productSourceId.trim().length === 0) {
      throw new DurableExecutionIdentityError("productSourceId is required for durable sync job reservation.");
    }
    if (!sourceSnapshotId || sourceSnapshotId.trim().length === 0) {
      throw new DurableExecutionIdentityError("sourceSnapshotId is required for durable sync job reservation.");
    }

    // 1. Validate payload schema & strict JSON safety
    const validatedPayload = validateDurableExecutionPayload(params.payload);

    // 2. Validate alignment between planned operation, execution payload, and key derivation
    assertOperationPayloadAndKeyIntegrity(operation, validatedPayload);

    // 3. Validate snapshot ID alignment
    if (validatedPayload.sourceSnapshotId !== sourceSnapshotId) {
      throw new DurablePayloadValidationError(
        `sourceSnapshotId mismatch: param has '${sourceSnapshotId}', payload has '${validatedPayload.sourceSnapshotId}'.`
      );
    }

    // 4. Validate execution eligibility constraints
    assertPayloadExecutionEligibility(operation, validatedPayload, marketplaceListingId);

    const jobType = mapSyncOperationTypeToJobType(operation.operationType);
    const initialStatus = deriveInitialSyncJobStatus(operation);
    const idempotencyKey = operation.idempotencyKey;

    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient): Promise<ReserveSyncJobOutcome> => {
          // Pre-check for existing idempotency reservation (optimization)
          const existingRecord = await tx.idempotencyRecord.findUnique({
            where: { key: idempotencyKey },
          });

          if (existingRecord) {
            const existingJob = existingRecord.syncJobId
              ? await tx.syncJob.findUnique({ where: { id: existingRecord.syncJobId } })
              : null;

            return validateExistingReservationAgainstRequest(existingRecord, existingJob, params);
          }

          // Validate persisted entity relationships: ProductSource
          const productSource = await tx.productSource.findUnique({
            where: { id: productSourceId },
          });
          if (!productSource) {
            throw new DurableExecutionIdentityError(`ProductSource '${productSourceId}' not found.`);
          }
          if (productSource.source !== validatedPayload.source) {
            throw new DurableExecutionIdentityError(
              `ProductSource source mismatch: record has '${productSource.source}', payload has '${validatedPayload.source}'.`
            );
          }
          if (productSource.sourceProductId !== validatedPayload.sourceProductId) {
            throw new DurableExecutionIdentityError(
              `ProductSource sourceProductId mismatch: record has '${productSource.sourceProductId}', payload has '${validatedPayload.sourceProductId}'.`
            );
          }

          // Validate persisted entity relationships: SourceSnapshot
          const snapshot = await tx.sourceSnapshot.findUnique({
            where: { id: sourceSnapshotId },
          });
          if (!snapshot) {
            throw new DurableExecutionIdentityError(`SourceSnapshot '${sourceSnapshotId}' not found.`);
          }
          if (snapshot.productSourceId !== productSourceId) {
            throw new DurableExecutionIdentityError(
              `SourceSnapshot '${sourceSnapshotId}' belongs to ProductSource '${snapshot.productSourceId}', expected '${productSourceId}'.`
            );
          }

          // Validate variant membership against SourceSnapshot canonical variants - MUST FAIL CLOSED
          const snapshotSkuSet = extractCanonicalSnapshotSkuSet(snapshot.canonicalPayload);
          const payloadSkuSet = new Set(validatedPayload.variants.map((v) => v.sourceSkuId));

          if (operation.operationType === "CREATE_LISTING") {
            if (
              snapshotSkuSet.size !== payloadSkuSet.size ||
              !Array.from(payloadSkuSet).every((sku) => snapshotSkuSet.has(sku))
            ) {
              throw new DurableExecutionIdentityError(
                `CREATE_LISTING payload variant SKUs do not match SourceSnapshot canonical variant SKUs exactly.`
              );
            }
          } else {
            for (const sku of payloadSkuSet) {
              if (!snapshotSkuSet.has(sku)) {
                throw new DurableExecutionIdentityError(
                  `Update operation payload contains unknown sourceSkuId '${sku}' not present in SourceSnapshot.`
                );
              }
            }
          }

          // Validate persisted entity relationships: MarketplaceListing
          if (marketplaceListingId) {
            const listing = await tx.marketplaceListing.findUnique({
              where: { id: marketplaceListingId },
            });
            if (!listing) {
              throw new DurableExecutionIdentityError(`MarketplaceListing '${marketplaceListingId}' not found.`);
            }
            if (listing.productId !== productSource.productId) {
              throw new DurableExecutionIdentityError(
                `MarketplaceListing '${marketplaceListingId}' productId '${listing.productId}' does not match ProductSource productId '${productSource.productId}'.`
              );
            }
            if (listing.marketplace !== validatedPayload.marketplace) {
              throw new DurableExecutionIdentityError(
                `MarketplaceListing marketplace mismatch: record has '${listing.marketplace}', payload has '${validatedPayload.marketplace}'.`
              );
            }
            if (listing.sellerAccountKey !== validatedPayload.sellerAccountKey) {
              throw new DurableExecutionIdentityError(
                `MarketplaceListing sellerAccountKey mismatch: record has '${listing.sellerAccountKey}', payload has '${validatedPayload.sellerAccountKey}'.`
              );
            }

            if (operation.operationType === "UPDATE_PRICE" || operation.operationType === "UPDATE_STOCK") {
              const updatePayload = validatedPayload as UpdatePriceExecutionPayload | UpdateStockExecutionPayload;

              // Authoritative remoteListingId validation for ELIGIBLE update operations
              if (operation.eligibility === "ELIGIBLE") {
                if (!listing.remoteListingId || listing.remoteListingId.trim().length === 0) {
                  throw new DurableExecutionIdentityError(
                    `Persisted MarketplaceListing '${marketplaceListingId}' has no remoteListingId; cannot execute ELIGIBLE update.`
                  );
                }
                if (listing.remoteListingId !== updatePayload.remoteListingId) {
                  throw new DurableExecutionIdentityError(
                    `remoteListingId mismatch: listing has '${listing.remoteListingId}', payload has '${updatePayload.remoteListingId}'.`
                  );
                }
              } else {
                if (
                  listing.remoteListingId &&
                  updatePayload.remoteListingId &&
                  listing.remoteListingId !== updatePayload.remoteListingId
                ) {
                  throw new DurableExecutionIdentityError(
                    `remoteListingId mismatch: listing has '${listing.remoteListingId}', payload has '${updatePayload.remoteListingId}'.`
                  );
                }
              }

              // Validate MarketplaceListingVariant membership - MUST FAIL CLOSED
              const listingVariants = await tx.marketplaceListingVariant.findMany({
                where: { listingId: marketplaceListingId },
              });
              const listingSkuSet = new Set(listingVariants.map((v) => v.sourceSkuId));
              for (const variant of updatePayload.variants) {
                if (!listingSkuSet.has(variant.sourceSkuId)) {
                  throw new DurableExecutionIdentityError(
                    `Update operation payload contains sourceSkuId '${variant.sourceSkuId}' with no matching MarketplaceListingVariant on listing '${marketplaceListingId}'.`
                  );
                }
              }
            }
          }

          // Create new IdempotencyRecord in STARTED state
          const idempotencyRecord = await tx.idempotencyRecord.create({
            data: {
              key: idempotencyKey,
              operationType: operation.operationType,
              status: "STARTED",
              marketplace: operation.marketplace,
              sellerAccountKey: operation.sellerAccountKey,
              productSourceId,
            },
          });

          // Create SyncJob with exact operationType and frozen executionPayload
          const syncJob = await tx.syncJob.create({
            data: {
              operationType: operation.operationType as PrismaSyncOperationType,
              jobType,
              status: initialStatus,
              idempotencyKey,
              executionPayload: validatedPayload as unknown as Prisma.InputJsonValue,
              payloadVersion: 1,
              productSourceId,
              marketplaceListingId: marketplaceListingId ?? null,
              sourceSnapshotId,
            },
          });

          // Link IdempotencyRecord to the newly created SyncJob
          const updatedIdempotency = await tx.idempotencyRecord.update({
            where: { id: idempotencyRecord.id },
            data: { syncJobId: syncJob.id },
          });

          // Record SYNC_PLANNED event
          const event = await tx.syncEvent.create({
            data: {
              syncJobId: syncJob.id,
              productSourceId,
              marketplaceListingId: marketplaceListingId ?? null,
              sourceSnapshotId,
              eventType: "SYNC_PLANNED",
              payload: {
                operationType: operation.operationType,
                eligibility: operation.eligibility,
                idempotencyKey,
                payloadVersion: 1,
              },
            },
          });

          return {
            status: "CREATED",
            syncJob,
            idempotencyRecord: updatedIdempotency,
            event,
          };
        }
      );
    } catch (err: unknown) {
      // Check if error is a verified Prisma P2002 unique constraint conflict on IdempotencyRecord.key
      if (isIdempotencyKeyUniqueConflict(err)) {
        const existingRecord = await this.prisma.idempotencyRecord.findUnique({
          where: { key: idempotencyKey },
        });

        if (existingRecord) {
          const existingJob = existingRecord.syncJobId
            ? await this.prisma.syncJob.findUnique({ where: { id: existingRecord.syncJobId } })
            : null;

          return validateExistingReservationAgainstRequest(existingRecord, existingJob, params);
        }
      }

      throw err;
    }
  }

  /**
   * Resolves the target MarketplaceListing for a BLOCKED or NEEDS_REVIEW update job.
   *
   * RULES:
   * - Exclusively for UPDATE_PRICE and UPDATE_STOCK operations. Throws DurableExecutionIdentityError on CREATE_LISTING.
   * - Only permitted while job status is "NEEDS_REVIEW" or "BLOCKED".
   * - Forbidden once job enters "PENDING", "PROCESSING", "COMPLETED", "FAILED", or "CANCELLED".
   * - Forbids changing already-resolved marketplaceListingId.
   * - Requires authoritative listing.remoteListingId (rejects null/blank).
   * - Injects authoritative listing.remoteListingId into the execution payload.
   * - Validates listing relationship: productId, marketplace, sellerAccountKey, and variant mappings.
   * - Atomically updates SyncJob.marketplaceListingId, executionPayload (with authoritative remoteListingId),
   *   and increments payloadVersion.
   */
  async resolveReviewExecutionTarget(
    params: ResolveReviewExecutionTargetParams
  ): Promise<{ syncJob: SyncJob; auditLog: unknown }> {
    const { syncJobId, marketplaceListingId, reviewedBy, notes } = params;

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.syncJob.findUnique({
        where: { id: syncJobId },
      });

      if (!job) {
        throw new Error(`SyncJob '${syncJobId}' not found.`);
      }

      if (job.status !== "NEEDS_REVIEW" && job.status !== "BLOCKED") {
        throw new PayloadImmutabilityViolationError(
          `Cannot resolve execution target for SyncJob in status '${job.status}'. Target is immutable in active/terminal states.`
        );
      }

      const currentPayload = validateDurableExecutionPayload(job.executionPayload);

      // FIX 1: Exclusively for UPDATE_PRICE and UPDATE_STOCK
      if (currentPayload.operationType === "CREATE_LISTING") {
        throw new DurableExecutionIdentityError(
          "resolveReviewExecutionTarget is exclusively for UPDATE_PRICE and UPDATE_STOCK operations."
        );
      }

      if (job.marketplaceListingId && job.marketplaceListingId !== marketplaceListingId) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change already-resolved marketplaceListingId (current: '${job.marketplaceListingId}', replacement: '${marketplaceListingId}').`
        );
      }

      if (!job.productSourceId) {
        throw new DurableExecutionIdentityError(`SyncJob '${syncJobId}' has null productSourceId.`);
      }

      const productSource = await tx.productSource.findUnique({
        where: { id: job.productSourceId },
      });
      if (!productSource) {
        throw new DurableExecutionIdentityError(`ProductSource '${job.productSourceId}' not found.`);
      }

      const listing = await tx.marketplaceListing.findUnique({
        where: { id: marketplaceListingId },
      });
      if (!listing) {
        throw new DurableExecutionIdentityError(`MarketplaceListing '${marketplaceListingId}' not found.`);
      }

      if (listing.productId !== productSource.productId) {
        throw new DurableExecutionIdentityError(
          `MarketplaceListing productId '${listing.productId}' does not match ProductSource productId '${productSource.productId}'.`
        );
      }

      if (listing.marketplace !== currentPayload.marketplace) {
        throw new DurableExecutionIdentityError(
          `MarketplaceListing marketplace '${listing.marketplace}' does not match payload marketplace '${currentPayload.marketplace}'.`
        );
      }
      if (listing.sellerAccountKey !== currentPayload.sellerAccountKey) {
        throw new DurableExecutionIdentityError(
          `MarketplaceListing sellerAccountKey '${listing.sellerAccountKey}' does not match payload sellerAccountKey '${currentPayload.sellerAccountKey}'.`
        );
      }

      // FIX 2: Authoritative remote listing ID resolution
      if (!listing.remoteListingId || listing.remoteListingId.trim().length === 0) {
        throw new DurableExecutionIdentityError(
          `Target MarketplaceListing '${marketplaceListingId}' has no authoritative remoteListingId.`
        );
      }
      const authoritativeRemoteListingId = listing.remoteListingId.trim();

      const currUpdate = currentPayload as UpdatePriceExecutionPayload | UpdateStockExecutionPayload;
      if (currUpdate.remoteListingId !== undefined && currUpdate.remoteListingId !== authoritativeRemoteListingId) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change already-resolved remoteListingId (current: '${currUpdate.remoteListingId}', target listing: '${authoritativeRemoteListingId}').`
        );
      }

      const listingVariants = await tx.marketplaceListingVariant.findMany({
        where: { listingId: marketplaceListingId },
      });
      const listingSkuSet = new Set(listingVariants.map((v) => v.sourceSkuId));
      for (const variant of currUpdate.variants) {
        if (!listingSkuSet.has(variant.sourceSkuId)) {
          throw new DurableExecutionIdentityError(
            `Update operation payload contains sourceSkuId '${variant.sourceSkuId}' with no matching MarketplaceListingVariant on listing '${marketplaceListingId}'.`
          );
        }
      }

      const oldRemoteId = currUpdate.remoteListingId ?? null;
      const newRemoteId = authoritativeRemoteListingId;

      const updatedPayload: DurableExecutionPayload = {
        ...currUpdate,
        remoteListingId: newRemoteId,
      };

      const nextVersion = job.payloadVersion + 1;

      const updatedJob = await tx.syncJob.update({
        where: { id: syncJobId },
        data: {
          marketplaceListingId,
          executionPayload: updatedPayload as unknown as Prisma.InputJsonValue,
          payloadVersion: nextVersion,
        },
      });

      const auditLog = await tx.auditLog.create({
        data: {
          actorType: reviewedBy ? "OPERATOR" : "SYSTEM",
          actorId: reviewedBy ?? null,
          action: "RESOLVE_REVIEW_EXECUTION_TARGET",
          entityType: "SyncJob",
          entityId: syncJobId,
          before: {
            payloadVersion: job.payloadVersion,
            marketplaceListingId: job.marketplaceListingId,
            remoteListingId: oldRemoteId,
          } as unknown as Prisma.InputJsonValue,
          after: {
            payloadVersion: nextVersion,
            marketplaceListingId,
            remoteListingId: newRemoteId,
          } as unknown as Prisma.InputJsonValue,
          metadata: { notes: notes ?? "Resolved review execution target" },
        },
      });

      return {
        syncJob: updatedJob,
        auditLog,
      };
    });
  }

  /**
   * Replaces the execution payload of a job during human/policy review.
   *
   * IMMUTABILITY RULES:
   * - Only permitted while job status is "NEEDS_REVIEW" or "BLOCKED".
   * - Forbidden once job enters "PENDING", "PROCESSING", "COMPLETED", "FAILED", or "CANCELLED".
   * - Increments payloadVersion.
   * - Forbids changing identity fields: schemaVersion, operationType, source, sourceProductId,
   *   marketplace, sellerAccountKey, or idempotencyKey.
   * - For UPDATE_PRICE and UPDATE_STOCK: sourceSnapshotId is immutable; resolved remoteListingId is immutable;
   *   cannot introduce remoteListingId (must use resolveReviewExecutionTarget).
   * - For CREATE_LISTING: sourceSnapshotId MAY be updated during review if the new snapshot
   *   belongs to the same ProductSource and matches canonical variants.
   */
  async replaceReviewPayload(
    params: ReplaceReviewPayloadParams
  ): Promise<{ syncJob: SyncJob; auditLog: unknown }> {
    const { syncJobId, newPayload, reviewedBy, notes } = params;

    const validatedNewPayload = validateDurableExecutionPayload(newPayload);

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.syncJob.findUnique({
        where: { id: syncJobId },
      });

      if (!job) {
        throw new Error(`SyncJob '${syncJobId}' not found.`);
      }

      // Check status immutability contract
      if (job.status !== "NEEDS_REVIEW" && job.status !== "BLOCKED") {
        throw new PayloadImmutabilityViolationError(
          `Cannot replace execution payload for SyncJob in status '${job.status}'. Payload is immutable in active/terminal states.`
        );
      }

      const currentPayload = validateDurableExecutionPayload(job.executionPayload);

      // Persisted Job vs Current ExecutionPayload Integrity Checks
      if (!job.productSourceId) {
        throw new DurableExecutionIdentityError(`SyncJob '${syncJobId}' has null productSourceId.`);
      }
      if (job.operationType !== currentPayload.operationType) {
        throw new DurableExecutionIdentityError(
          `Persisted SyncJob operationType '${job.operationType}' does not match executionPayload operationType '${currentPayload.operationType}'.`
        );
      }
      if (currentPayload.operationType === "UPDATE_PRICE" || currentPayload.operationType === "UPDATE_STOCK") {
        if (job.sourceSnapshotId !== currentPayload.sourceSnapshotId) {
          throw new DurableExecutionIdentityError(
            `Persisted SyncJob sourceSnapshotId '${job.sourceSnapshotId}' does not match update executionPayload sourceSnapshotId '${currentPayload.sourceSnapshotId}'.`
          );
        }
      }
      if (currentPayload.operationType === "CREATE_LISTING") {
        if (job.sourceSnapshotId !== currentPayload.sourceSnapshotId) {
          throw new DurableExecutionIdentityError(
            `Persisted SyncJob sourceSnapshotId '${job.sourceSnapshotId}' does not match CREATE_LISTING current executionPayload sourceSnapshotId '${currentPayload.sourceSnapshotId}'.`
          );
        }
      }

      // Invariants: Identity fields must remain strictly identical
      if (currentPayload.schemaVersion !== validatedNewPayload.schemaVersion) {
        throw new PayloadImmutabilityViolationError("Cannot change schemaVersion during review payload replacement.");
      }
      if (currentPayload.operationType !== validatedNewPayload.operationType) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change operationType during review payload replacement (current: '${currentPayload.operationType}', replacement: '${validatedNewPayload.operationType}').`
        );
      }
      if (currentPayload.source !== validatedNewPayload.source) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change source during review payload replacement (current: '${currentPayload.source}', replacement: '${validatedNewPayload.source}').`
        );
      }
      if (currentPayload.sourceProductId !== validatedNewPayload.sourceProductId) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change sourceProductId during review payload replacement (current: '${currentPayload.sourceProductId}', replacement: '${validatedNewPayload.sourceProductId}').`
        );
      }
      if (currentPayload.marketplace !== validatedNewPayload.marketplace) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change marketplace during review payload replacement (current: '${currentPayload.marketplace}', replacement: '${validatedNewPayload.marketplace}').`
        );
      }
      if (currentPayload.sellerAccountKey !== validatedNewPayload.sellerAccountKey) {
        throw new PayloadImmutabilityViolationError(
          `Cannot change sellerAccountKey during review payload replacement (current: '${currentPayload.sellerAccountKey}', replacement: '${validatedNewPayload.sellerAccountKey}').`
        );
      }

      // Update operations: sourceSnapshotId and remoteListingId rules
      if (currentPayload.operationType === "UPDATE_PRICE" || currentPayload.operationType === "UPDATE_STOCK") {
        if (currentPayload.sourceSnapshotId !== validatedNewPayload.sourceSnapshotId) {
          throw new PayloadImmutabilityViolationError(
            `Cannot change sourceSnapshotId for update operations during review payload replacement (current: '${currentPayload.sourceSnapshotId}', replacement: '${validatedNewPayload.sourceSnapshotId}').`
          );
        }
        const currUpdate = currentPayload as UpdatePriceExecutionPayload | UpdateStockExecutionPayload;
        const nextUpdate = validatedNewPayload as UpdatePriceExecutionPayload | UpdateStockExecutionPayload;

        if (currUpdate.remoteListingId !== undefined) {
          if (nextUpdate.remoteListingId !== currUpdate.remoteListingId) {
            throw new PayloadImmutabilityViolationError(
              `Cannot change or remove already-resolved remoteListingId during review payload replacement (current: '${currUpdate.remoteListingId}', replacement: '${nextUpdate.remoteListingId}').`
            );
          }
        } else {
          if (nextUpdate.remoteListingId !== undefined) {
            throw new PayloadImmutabilityViolationError(
              `Cannot introduce remoteListingId in replaceReviewPayload; remoteListingId must be resolved via resolveReviewExecutionTarget.`
            );
          }
        }
      }

      // Determine and validate target SourceSnapshot
      let targetSnapshotId: string | null = null;
      if (currentPayload.operationType === "CREATE_LISTING") {
        targetSnapshotId = validatedNewPayload.sourceSnapshotId;
      } else {
        targetSnapshotId = job.sourceSnapshotId;
      }

      if (!targetSnapshotId) {
        throw new DurableExecutionIdentityError(`SyncJob '${syncJobId}' has null sourceSnapshotId.`);
      }

      const targetSnapshot = await tx.sourceSnapshot.findUnique({
        where: { id: targetSnapshotId },
      });
      if (!targetSnapshot) {
        throw new DurableExecutionIdentityError(
          `Target SourceSnapshot '${targetSnapshotId}' not found.`
        );
      }
      if (targetSnapshot.productSourceId !== job.productSourceId) {
        throw new DurableExecutionIdentityError(
          `Target SourceSnapshot '${targetSnapshotId}' belongs to ProductSource '${targetSnapshot.productSourceId}', expected '${job.productSourceId}'.`
        );
      }

      // Validate replacement payload variant SKUs against target snapshot canonical variants
      const snapshotSkuSet = extractCanonicalSnapshotSkuSet(targetSnapshot.canonicalPayload);
      const payloadSkuSet = new Set(validatedNewPayload.variants.map((v) => v.sourceSkuId));

      if (currentPayload.operationType === "CREATE_LISTING") {
        // Exact SKU-set match required (both on snapshot refresh and when snapshot stays the same)
        if (
          snapshotSkuSet.size !== payloadSkuSet.size ||
          !Array.from(payloadSkuSet).every((sku) => snapshotSkuSet.has(sku))
        ) {
          throw new DurableExecutionIdentityError(
            `Replacement CREATE_LISTING payload variant SKUs do not match Target SourceSnapshot '${targetSnapshotId}' canonical variant SKUs exactly.`
          );
        }
      } else {
        // Update operations: all replacement SKUs must exist in target snapshot
        for (const sku of payloadSkuSet) {
          if (!snapshotSkuSet.has(sku)) {
            throw new DurableExecutionIdentityError(
              `Update replacement payload contains sourceSkuId '${sku}' not present in SourceSnapshot '${targetSnapshotId}'.`
            );
          }
        }

        // If marketplaceListingId is already resolved, validate against MarketplaceListingVariant rows
        if (job.marketplaceListingId) {
          const listingVariants = await tx.marketplaceListingVariant.findMany({
            where: { listingId: job.marketplaceListingId },
          });
          const listingSkuSet = new Set(listingVariants.map((v) => v.sourceSkuId));
          for (const variant of validatedNewPayload.variants) {
            if (!listingSkuSet.has(variant.sourceSkuId)) {
              throw new DurableExecutionIdentityError(
                `Update replacement payload contains sourceSkuId '${variant.sourceSkuId}' with no matching MarketplaceListingVariant on listing '${job.marketplaceListingId}'.`
              );
            }
          }
        }
      }

      const nextVersion = job.payloadVersion + 1;

      const updatedJob = await tx.syncJob.update({
        where: { id: syncJobId },
        data: {
          sourceSnapshotId: targetSnapshotId,
          executionPayload: validatedNewPayload as unknown as Prisma.InputJsonValue,
          payloadVersion: nextVersion,
        },
      });

      const auditLog = await tx.auditLog.create({
        data: {
          actorType: reviewedBy ? "OPERATOR" : "SYSTEM",
          actorId: reviewedBy ?? null,
          action: "REPLACE_REVIEW_PAYLOAD",
          entityType: "SyncJob",
          entityId: syncJobId,
          before: {
            payloadVersion: job.payloadVersion,
            sourceSnapshotId: job.sourceSnapshotId,
            executionPayload: job.executionPayload,
          } as unknown as Prisma.InputJsonValue,
          after: {
            payloadVersion: nextVersion,
            sourceSnapshotId: targetSnapshotId,
            executionPayload: validatedNewPayload as unknown as Prisma.InputJsonValue,
          } as unknown as Prisma.InputJsonValue,
          metadata: { notes: notes ?? "Review payload replaced" },
        },
      });

      return {
        syncJob: updatedJob,
        auditLog,
      };
    });
  }

  /**
   * Fetches a SyncJob by its unique primary key.
   */
  async getSyncJobById(id: string): Promise<SyncJob | null> {
    return this.prisma.syncJob.findUnique({
      where: { id },
    });
  }

  /**
   * Fetches an IdempotencyRecord by its unique idempotency key.
   */
  async getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecord | null> {
    return this.prisma.idempotencyRecord.findUnique({
      where: { key },
    });
  }
}
