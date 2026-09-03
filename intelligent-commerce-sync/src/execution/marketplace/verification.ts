import type { DurableExecutionPayload } from "../types.js";
import {
  type NormalizedRemoteListingState,
  type VerificationMismatch,
  type VerificationResult,
  extractResolvedTargetQuantity,
} from "./types.js";

export interface PersistedVariantMappingInfo {
  destinationSku: string;
  remoteVariantId?: string | null | undefined;
}

/**
 * Pure read-after-write verification algorithm.
 * Compares normalized remote state against frozen durable execution intent and expected remote listing ID.
 */
export function verifyRemoteListingState(
  durablePayload: DurableExecutionPayload,
  remoteState: NormalizedRemoteListingState,
  expectedRemoteListingId: string,
  variantMappings?: Map<string, PersistedVariantMappingInfo>
): VerificationResult {
  const mismatches: VerificationMismatch[] = [];

  // 1. Verify remote listing identity
  if (remoteState.remoteListingId !== expectedRemoteListingId) {
    mismatches.push({
      field: "remoteListingId",
      expected: expectedRemoteListingId,
      actual: remoteState.remoteListingId,
    });
  }

  // 2. Verify operation-specific fields
  switch (durablePayload.operationType) {
    case "CREATE_LISTING": {
      if (remoteState.title !== undefined && remoteState.title !== durablePayload.preparedTitle) {
        mismatches.push({
          field: "title",
          expected: durablePayload.preparedTitle,
          actual: remoteState.title,
        });
      }

      if (remoteState.variants.length !== durablePayload.variants.length) {
        mismatches.push({
          field: "variantCount",
          expected: durablePayload.variants.length,
          actual: remoteState.variants.length,
        });
      }

      for (const v of durablePayload.variants) {
        const remoteVariant = remoteState.variants.find(
          (rv) => rv.destinationSku === v.destinationSku
        );

        if (!remoteVariant) {
          mismatches.push({
            field: "variant",
            sourceSkuId: v.sourceSkuId,
            destinationSku: v.destinationSku,
            expected: "EXISTS",
            actual: "MISSING",
          });
          continue;
        }

        if (remoteVariant.priceIdr !== v.targetPriceIdr) {
          mismatches.push({
            field: "priceIdr",
            sourceSkuId: v.sourceSkuId,
            destinationSku: v.destinationSku,
            expected: v.targetPriceIdr,
            actual: remoteVariant.priceIdr,
          });
        }

        const expectedStock = extractResolvedTargetQuantity(v.inventory, v.sourceSkuId);
        if (remoteVariant.stock !== expectedStock) {
          mismatches.push({
            field: "stock",
            sourceSkuId: v.sourceSkuId,
            destinationSku: v.destinationSku,
            expected: expectedStock,
            actual: remoteVariant.stock,
          });
        }
      }
      break;
    }

    case "UPDATE_PRICE": {
      for (const v of durablePayload.variants) {
        const mapping = variantMappings?.get(v.sourceSkuId);
        const destinationSku = mapping?.destinationSku ?? v.sourceSkuId;

        const remoteVariant = remoteState.variants.find(
          (rv) =>
            rv.destinationSku === destinationSku ||
            (mapping?.remoteVariantId && rv.remoteVariantId === mapping.remoteVariantId)
        );

        if (!remoteVariant) {
          mismatches.push({
            field: "variant",
            sourceSkuId: v.sourceSkuId,
            destinationSku,
            expected: "EXISTS",
            actual: "MISSING",
          });
          continue;
        }

        if (remoteVariant.priceIdr !== v.targetPriceIdr) {
          mismatches.push({
            field: "priceIdr",
            sourceSkuId: v.sourceSkuId,
            destinationSku,
            expected: v.targetPriceIdr,
            actual: remoteVariant.priceIdr,
          });
        }
      }
      break;
    }

    case "UPDATE_STOCK": {
      for (const v of durablePayload.variants) {
        const mapping = variantMappings?.get(v.sourceSkuId);
        const destinationSku = mapping?.destinationSku ?? v.sourceSkuId;

        const remoteVariant = remoteState.variants.find(
          (rv) =>
            rv.destinationSku === destinationSku ||
            (mapping?.remoteVariantId && rv.remoteVariantId === mapping.remoteVariantId)
        );

        if (!remoteVariant) {
          mismatches.push({
            field: "variant",
            sourceSkuId: v.sourceSkuId,
            destinationSku,
            expected: "EXISTS",
            actual: "MISSING",
          });
          continue;
        }

        const expectedStock = extractResolvedTargetQuantity(v.inventory, v.sourceSkuId);
        if (remoteVariant.stock !== expectedStock) {
          mismatches.push({
            field: "stock",
            sourceSkuId: v.sourceSkuId,
            destinationSku,
            expected: expectedStock,
            actual: remoteVariant.stock,
          });
        }
      }
      break;
    }

    default: {
      const _exhaustive: never = durablePayload;
      throw new Error(`Unhandled operationType: ${String(_exhaustive)}`);
    }
  }

  return {
    verified: mismatches.length === 0,
    mismatches,
  };
}
