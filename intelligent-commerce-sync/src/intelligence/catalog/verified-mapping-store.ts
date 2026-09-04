/**
 * Phase 5B: Verified Catalog Mapping Store Interface & Runtime Trust Boundary Validator
 * External/caller storage records are treated as untrusted until verified at runtime.
 */

import { deepFreeze } from "../safety.js";
import { normalizeLookupKey } from "./normalization.js";
import { CATALOG_BOUNDS, CatalogInputValidationError } from "./types.js";

export interface VerifiedCategoryMappingRecord {
  readonly sourceCategoryPath: string;
  readonly targetCandidateId: string;
  readonly verified: boolean;
}

export interface VerifiedAttributeMappingRecord {
  readonly sourceSpecificationKey: string;
  readonly targetCandidateId: string;
  readonly verified: boolean;
}

export interface VerifiedCatalogMappingStore {
  findCategoryMappings(normalizedSourceCategoryPath: string): Promise<readonly VerifiedCategoryMappingRecord[]>;
  findAttributeMappings(normalizedSourceSpecificationKey: string): Promise<readonly VerifiedAttributeMappingRecord[]>;
}

/**
 * Validates store-returned records against strict schema and trust boundaries:
 * 1. Output must be a non-sparse array.
 * 2. Array length must not exceed MAX_RAW_STORE_RECORDS before processing.
 * 3. Every record must be a non-null plain object with zero symbols.
 * 4. Exact allowed property set only (no updatedAt or extraneous fields).
 * 5. verified must be a strict boolean.
 * 6. targetCandidateId must be a non-blank string.
 * 7. Source key must normalize exactly to the queried lookup key.
 * 8. Returns fresh, recursively frozen snapshots (never freezes or mutates store-owned objects).
 */
export function validateAndCopyVerifiedCategoryStoreRecords(
  rawArray: unknown,
  expectedNormalizedKey: string,
  maxTargetCandidateIdLength: number
): readonly VerifiedCategoryMappingRecord[] {
  if (
    typeof maxTargetCandidateIdLength !== "number" ||
    !Number.isFinite(maxTargetCandidateIdLength) ||
    maxTargetCandidateIdLength <= 0 ||
    !Number.isInteger(maxTargetCandidateIdLength)
  ) {
    throw new CatalogInputValidationError("maxTargetCandidateIdLength must be a positive finite integer.");
  }

  if (!Array.isArray(rawArray)) {
    throw new CatalogInputValidationError("Verified store response must be an array.");
  }

  if (rawArray.length > CATALOG_BOUNDS.MAX_RAW_STORE_RECORDS) {
    throw new CatalogInputValidationError(
      `Verified store returned ${rawArray.length} records, exceeding maximum bound (${CATALOG_BOUNDS.MAX_RAW_STORE_RECORDS}).`
    );
  }

  const allowedKeys = new Set(["sourceCategoryPath", "targetCandidateId", "verified"]);
  const trustedRecords: VerifiedCategoryMappingRecord[] = [];

  for (let i = 0; i < rawArray.length; i++) {
    if (!(i in rawArray)) {
      throw new CatalogInputValidationError(`Store records array contains a sparse hole at index ${i}.`);
    }

    const rec = rawArray[i];
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      throw new CatalogInputValidationError(`Store record at index ${i} must be a non-null plain object.`);
    }

    const proto = Object.getPrototypeOf(rec);
    if (proto !== Object.prototype && proto !== null) {
      throw new CatalogInputValidationError(`Store record at index ${i} must be a plain object.`);
    }

    if (Object.getOwnPropertySymbols(rec).length > 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} cannot contain symbol properties.`);
    }

    const keys = Object.keys(rec);
    if (keys.length !== 3) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} has invalid property count (${keys.length}). Expected exact 3 properties.`
      );
    }

    for (const key of keys) {
      if (!allowedKeys.has(key)) {
        throw new CatalogInputValidationError(`Store record at index ${i} contains unauthorized property '${key}'.`);
      }
    }

    const obj = rec as Record<string, unknown>;
    const sourceCategoryPath = obj.sourceCategoryPath;
    const targetCandidateId = obj.targetCandidateId;
    const verified = obj.verified;

    if (typeof sourceCategoryPath !== "string" || sourceCategoryPath.trim().length === 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} has invalid or blank sourceCategoryPath.`);
    }

    if (typeof targetCandidateId !== "string" || targetCandidateId.trim().length === 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} has invalid or blank targetCandidateId.`);
    }

    if (targetCandidateId.length > maxTargetCandidateIdLength) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} targetCandidateId length exceeds maximum allowed limit (${maxTargetCandidateIdLength}).`
      );
    }

    if (typeof verified !== "boolean") {
      throw new CatalogInputValidationError(`Store record at index ${i} property 'verified' must be a boolean.`);
    }

    // Key mismatch verification: source key must normalize to queried key
    const normalizedKey = normalizeLookupKey(sourceCategoryPath);
    if (normalizedKey !== expectedNormalizedKey) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} sourceCategoryPath normalizes to '${normalizedKey}', mismatching queried key '${expectedNormalizedKey}'.`
      );
    }

    // Copy to fresh trusted object snapshot
    const copy: VerifiedCategoryMappingRecord = {
      sourceCategoryPath,
      targetCandidateId,
      verified,
    };

    trustedRecords.push(deepFreeze(copy));
  }

  return Object.freeze(trustedRecords);
}

/**
 * Validates attribute store records against strict schema and trust boundaries.
 */
export function validateAndCopyVerifiedAttributeStoreRecords(
  rawArray: unknown,
  expectedNormalizedKey: string,
  maxTargetCandidateIdLength: number
): readonly VerifiedAttributeMappingRecord[] {
  if (
    typeof maxTargetCandidateIdLength !== "number" ||
    !Number.isFinite(maxTargetCandidateIdLength) ||
    maxTargetCandidateIdLength <= 0 ||
    !Number.isInteger(maxTargetCandidateIdLength)
  ) {
    throw new CatalogInputValidationError("maxTargetCandidateIdLength must be a positive finite integer.");
  }

  if (!Array.isArray(rawArray)) {
    throw new CatalogInputValidationError("Verified store response must be an array.");
  }

  if (rawArray.length > CATALOG_BOUNDS.MAX_RAW_STORE_RECORDS) {
    throw new CatalogInputValidationError(
      `Verified store returned ${rawArray.length} records, exceeding maximum bound (${CATALOG_BOUNDS.MAX_RAW_STORE_RECORDS}).`
    );
  }

  const allowedKeys = new Set(["sourceSpecificationKey", "targetCandidateId", "verified"]);
  const trustedRecords: VerifiedAttributeMappingRecord[] = [];

  for (let i = 0; i < rawArray.length; i++) {
    if (!(i in rawArray)) {
      throw new CatalogInputValidationError(`Store records array contains a sparse hole at index ${i}.`);
    }

    const rec = rawArray[i];
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      throw new CatalogInputValidationError(`Store record at index ${i} must be a non-null plain object.`);
    }

    const proto = Object.getPrototypeOf(rec);
    if (proto !== Object.prototype && proto !== null) {
      throw new CatalogInputValidationError(`Store record at index ${i} must be a plain object.`);
    }

    if (Object.getOwnPropertySymbols(rec).length > 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} cannot contain symbol properties.`);
    }

    const keys = Object.keys(rec);
    if (keys.length !== 3) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} has invalid property count (${keys.length}). Expected exact 3 properties.`
      );
    }

    for (const key of keys) {
      if (!allowedKeys.has(key)) {
        throw new CatalogInputValidationError(`Store record at index ${i} contains unauthorized property '${key}'.`);
      }
    }

    const obj = rec as Record<string, unknown>;
    const sourceSpecificationKey = obj.sourceSpecificationKey;
    const targetCandidateId = obj.targetCandidateId;
    const verified = obj.verified;

    if (typeof sourceSpecificationKey !== "string" || sourceSpecificationKey.trim().length === 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} has invalid or blank sourceSpecificationKey.`);
    }

    if (typeof targetCandidateId !== "string" || targetCandidateId.trim().length === 0) {
      throw new CatalogInputValidationError(`Store record at index ${i} has invalid or blank targetCandidateId.`);
    }

    if (targetCandidateId.length > maxTargetCandidateIdLength) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} targetCandidateId length exceeds maximum allowed limit (${maxTargetCandidateIdLength}).`
      );
    }

    if (typeof verified !== "boolean") {
      throw new CatalogInputValidationError(`Store record at index ${i} property 'verified' must be a boolean.`);
    }

    const normalizedKey = normalizeLookupKey(sourceSpecificationKey);
    if (normalizedKey !== expectedNormalizedKey) {
      throw new CatalogInputValidationError(
        `Store record at index ${i} sourceSpecificationKey normalizes to '${normalizedKey}', mismatching queried key '${expectedNormalizedKey}'.`
      );
    }

    const copy: VerifiedAttributeMappingRecord = {
      sourceSpecificationKey,
      targetCandidateId,
      verified,
    };

    trustedRecords.push(deepFreeze(copy));
  }

  return Object.freeze(trustedRecords);
}
