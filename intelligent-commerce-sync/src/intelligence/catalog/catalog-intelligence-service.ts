/**
 * Phase 5B: Catalog Intelligence Service
 * Orchestrates Category & Attribute Intelligence:
 * Verified Store (Deterministic Authority) -> Phase 5A Semantic Service (Advisory Fallback)
 */

import { deepFreeze, sanitizeErrorMessage, validateSemanticTaskInput } from "../safety.js";
import { SemanticIntelligenceService } from "../semantic-intelligence-service.js";
import { normalizeLookupKey } from "./normalization.js";
import {
  type VerifiedCatalogMappingStore,
  validateAndCopyVerifiedCategoryStoreRecords,
  validateAndCopyVerifiedAttributeStoreRecords,
} from "./verified-mapping-store.js";
import {
  CATALOG_BOUNDS,
  CatalogInputValidationError,
  type CatalogMappingResult,
  type CatalogMappingReasonCode,
  type CatalogMappingStatus,
} from "./types.js";
import type {
  CategoryMappingSemanticInput,
  AttributeMappingSemanticInput,
  SemanticIntelligenceResult,
} from "../types.js";

export class CatalogIntelligenceService {
  private readonly store?: VerifiedCatalogMappingStore | undefined;
  private readonly semanticService: SemanticIntelligenceService;

  constructor(options: {
    store?: VerifiedCatalogMappingStore | undefined;
    semanticService: SemanticIntelligenceService;
  }) {
    if (!options || !options.semanticService || typeof options.semanticService.executeTask !== "function") {
      throw new CatalogInputValidationError("CatalogIntelligenceService requires a valid SemanticIntelligenceService.");
    }
    this.store = options.store;
    this.semanticService = options.semanticService;
  }

  /**
   * Resolves category mapping for a product.
   * 1. Validates caller request (copy-then-freeze; caller raw input remains unmodified and unfrozen).
   * 2. Checks candidate set validity against Phase 5A rules before querying store.
   * 3. If sourceCategoryPath is present, normalizes and queries VerifiedCatalogMappingStore.
   * 4. If store match found, checks candidate allowlist.
   * 5. If store match absent or sourceCategoryPath is absent (sourceKey: null), falls back to Phase 5A.
   */
  async mapCategory(rawRequest: unknown): Promise<CatalogMappingResult> {
    // Step 1: Pre-validation of raw input structure
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
      return this.buildBlockedResult(
        "CATEGORY",
        null,
        "INPUT_VALIDATION_ERROR",
        "CategoryMappingRequest must be a non-null plain object."
      );
    }

    const proto = Object.getPrototypeOf(rawRequest);
    if (proto !== Object.prototype && proto !== null) {
      return this.buildBlockedResult(
        "CATEGORY",
        null,
        "INPUT_VALIDATION_ERROR",
        "CategoryMappingRequest must be a plain object."
      );
    }

    if (Object.getOwnPropertySymbols(rawRequest).length > 0) {
      return this.buildBlockedResult(
        "CATEGORY",
        null,
        "INPUT_VALIDATION_ERROR",
        "CategoryMappingRequest rejects symbol-keyed properties."
      );
    }

    const allowedKeys = new Set([
      "productTitle",
      "candidates",
      "productDescription",
      "brand",
      "categoryHints",
      "sourceCategoryPath",
      "evidence",
    ]);

    const forbiddenKeys = new Set([
      "price",
      "stock",
      "sku",
      "markup",
      "marketplaceAction",
      "executionPayload",
      "credentials",
      "password",
      "token",
    ]);

    for (const key of Object.keys(rawRequest as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) {
        return this.buildBlockedResult(
          "CATEGORY",
          null,
          "INPUT_VALIDATION_ERROR",
          `CategoryMappingRequest rejects forbidden domain property '${key}'.`
        );
      }
      if (!allowedKeys.has(key)) {
        return this.buildBlockedResult(
          "CATEGORY",
          null,
          "INPUT_VALIDATION_ERROR",
          `Unknown property '${key}' in CategoryMappingRequest.`
        );
      }
    }

    const req = rawRequest as Record<string, unknown>;

    // Step 2: Validate candidates and semantic subset using Phase 5A rules
    let validatedSemanticInput: CategoryMappingSemanticInput;
    try {
      const semanticPayload: Record<string, unknown> = {
        taskKind: "CATEGORY_MAPPING",
        productTitle: req.productTitle,
        candidates: req.candidates,
      };
      if (req.productDescription !== undefined) semanticPayload.productDescription = req.productDescription;
      if (req.brand !== undefined) semanticPayload.brand = req.brand;
      if (req.categoryHints !== undefined) semanticPayload.categoryHints = req.categoryHints;
      if (req.sourceCategoryPath !== undefined) semanticPayload.sourceCategoryPath = req.sourceCategoryPath;
      if (req.evidence !== undefined) semanticPayload.evidence = req.evidence;

      const validated = validateSemanticTaskInput(semanticPayload, this.semanticService.getConfig());
      if (validated.taskKind !== "CATEGORY_MAPPING") {
        throw new CatalogInputValidationError("Internal error: validated taskKind mismatch.");
      }
      validatedSemanticInput = validated;
    } catch (err: unknown) {
      return this.buildBlockedResult(
        "CATEGORY",
        null,
        "INPUT_VALIDATION_ERROR",
        sanitizeErrorMessage(err)
      );
    }

    // Step 3: Determine safe deterministic source key
    let sourceKey: string | null = null;
    if (validatedSemanticInput.sourceCategoryPath !== undefined) {
      try {
        sourceKey = normalizeLookupKey(validatedSemanticInput.sourceCategoryPath);
        if (sourceKey.length > CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH) {
          throw new CatalogInputValidationError("Normalized sourceCategoryPath exceeds maximum length bound.");
        }
      } catch (err: unknown) {
        return this.buildBlockedResult(
          "CATEGORY",
          null,
          "INPUT_VALIDATION_ERROR",
          sanitizeErrorMessage(err)
        );
      }
    }

    // Step 4: Query Verified Store if sourceKey is non-null and store is present
    if (sourceKey !== null && this.store !== undefined) {
      let rawStoreRecords: unknown;
      try {
        rawStoreRecords = await this.store.findCategoryMappings(sourceKey);
      } catch (err: unknown) {
        return this.buildBlockedResult(
          "CATEGORY",
          sourceKey,
          "VERIFIED_MAPPING_STORE_FAILURE",
          `Verified store query failed: ${sanitizeErrorMessage(err)}`
        );
      }

      let trustedStoreRecords;
      try {
        const maxCandidateIdLength = this.semanticService.getConfig().maxTextChars;
        trustedStoreRecords = validateAndCopyVerifiedCategoryStoreRecords(
          rawStoreRecords,
          sourceKey,
          maxCandidateIdLength
        );
      } catch (err: unknown) {
        return this.buildBlockedResult(
          "CATEGORY",
          sourceKey,
          "INVALID_VERIFIED_MAPPING_RECORD",
          `Verified store returned invalid records: ${sanitizeErrorMessage(err)}`
        );
      }

      // Filter structurally valid records where verified === true
      const verifiedRecords = trustedStoreRecords.filter((r) => r.verified === true);

      if (verifiedRecords.length > 0) {
        const uniqueCandidateIds = Array.from(new Set(verifiedRecords.map((r) => r.targetCandidateId)));

        if (uniqueCandidateIds.length > 1) {
          return this.buildBlockedResult(
            "CATEGORY",
            sourceKey,
            "CONFLICTING_VERIFIED_MAPPING",
            `Multiple conflicting verified mappings found in store for '${sourceKey}'.`,
            "VERIFIED_STORE"
          );
        }

        const matchedCandidateId = uniqueCandidateIds[0]!;
        const candidateMatch = validatedSemanticInput.candidates.find((c) => c.id === matchedCandidateId);

        if (!candidateMatch) {
          return this.buildBlockedResult(
            "CATEGORY",
            sourceKey,
            "STALE_VERIFIED_TARGET",
            `Verified target '${matchedCandidateId}' is not present in caller candidates allowlist.`,
            "VERIFIED_STORE"
          );
        }

        // Exact verified match
        return deepFreeze({
          taskKind: "CATEGORY",
          sourceKey,
          status: "RESOLVED" as CatalogMappingStatus,
          selectedCandidateId: candidateMatch.id,
          resolutionSource: "VERIFIED_STORE",
          confidence: 1.0,
          risk: "LOW",
          reviewRequired: false,
          reasonCode: "VERIFIED_STORE_MATCH" as CatalogMappingReasonCode,
          explanation: `Resolved deterministically via verified store match for '${sourceKey}'.`,
          evidenceRefs: [],
          requestId: null,
        });
      }
    }

    // Step 5: Fallback to Phase 5A Semantic Intelligence Service
    const semanticResult = await this.semanticService.executeTask(validatedSemanticInput);
    return this.translateSemanticResult("CATEGORY", sourceKey, semanticResult);
  }

  /**
   * Resolves attribute mapping for a specification item.
   * 1. Requires sourceSpecificationKey and sourceSpecificationValue. productTitle is optional.
   * 2. Validates caller candidates against Phase 5A before store query.
   * 3. Normalizes sourceSpecificationKey and queries VerifiedCatalogMappingStore.
   * 4. If store match found, validates against candidates.
   * 5. If unresolved, falls back to Phase 5A Semantic Service.
   */
  async mapAttribute(rawRequest: unknown): Promise<CatalogMappingResult> {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        "AttributeMappingRequest must be a non-null plain object."
      );
    }

    const proto = Object.getPrototypeOf(rawRequest);
    if (proto !== Object.prototype && proto !== null) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        "AttributeMappingRequest must be a plain object."
      );
    }

    if (Object.getOwnPropertySymbols(rawRequest).length > 0) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        "AttributeMappingRequest rejects symbol-keyed properties."
      );
    }

    const allowedKeys = new Set([
      "sourceSpecificationKey",
      "sourceSpecificationValue",
      "candidates",
      "brand",
      "productTitle",
      "evidence",
    ]);

    const forbiddenKeys = new Set([
      "price",
      "stock",
      "sku",
      "markup",
      "marketplaceAction",
      "executionPayload",
      "credentials",
      "password",
      "token",
    ]);

    for (const key of Object.keys(rawRequest as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) {
        return this.buildBlockedResult(
          "ATTRIBUTE",
          null,
          "INPUT_VALIDATION_ERROR",
          `AttributeMappingRequest rejects forbidden domain property '${key}'.`
        );
      }
      if (!allowedKeys.has(key)) {
        return this.buildBlockedResult(
          "ATTRIBUTE",
          null,
          "INPUT_VALIDATION_ERROR",
          `Unknown property '${key}' in AttributeMappingRequest.`
        );
      }
    }

    const req = rawRequest as Record<string, unknown>;

    // sourceSpecificationValue is strictly REQUIRED
    if (typeof req.sourceSpecificationValue !== "string" || req.sourceSpecificationValue.trim().length === 0) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        "AttributeMappingRequest property 'sourceSpecificationValue' is required and cannot be blank."
      );
    }

    // Validate candidates and semantic subset using Phase 5A rules
    let validatedSemanticInput: AttributeMappingSemanticInput;
    try {
      const semanticPayload: Record<string, unknown> = {
        taskKind: "ATTRIBUTE_MAPPING",
        sourceSpecificationKey: req.sourceSpecificationKey,
        sourceSpecificationValue: req.sourceSpecificationValue,
        candidates: req.candidates,
      };
      if (req.productTitle !== undefined) {
        semanticPayload.productTitle = req.productTitle;
      }
      if (req.brand !== undefined) semanticPayload.brand = req.brand;
      if (req.evidence !== undefined) semanticPayload.evidence = req.evidence;

      const validated = validateSemanticTaskInput(semanticPayload, this.semanticService.getConfig());
      if (validated.taskKind !== "ATTRIBUTE_MAPPING") {
        throw new CatalogInputValidationError("Internal error: validated taskKind mismatch.");
      }
      validatedSemanticInput = validated;
    } catch (err: unknown) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        sanitizeErrorMessage(err)
      );
    }

    // Determine safe deterministic source key
    let sourceKey: string;
    try {
      sourceKey = normalizeLookupKey(validatedSemanticInput.sourceSpecificationKey);
      if (sourceKey.length > CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH) {
        throw new CatalogInputValidationError("Normalized sourceSpecificationKey exceeds maximum length bound.");
      }
    } catch (err: unknown) {
      return this.buildBlockedResult(
        "ATTRIBUTE",
        null,
        "INPUT_VALIDATION_ERROR",
        sanitizeErrorMessage(err)
      );
    }

    // Query Verified Store if present
    if (this.store !== undefined) {
      let rawStoreRecords: unknown;
      try {
        rawStoreRecords = await this.store.findAttributeMappings(sourceKey);
      } catch (err: unknown) {
        return this.buildBlockedResult(
          "ATTRIBUTE",
          sourceKey,
          "VERIFIED_MAPPING_STORE_FAILURE",
          `Verified store query failed: ${sanitizeErrorMessage(err)}`
        );
      }

      let trustedStoreRecords;
      try {
        const maxCandidateIdLength = this.semanticService.getConfig().maxTextChars;
        trustedStoreRecords = validateAndCopyVerifiedAttributeStoreRecords(
          rawStoreRecords,
          sourceKey,
          maxCandidateIdLength
        );
      } catch (err: unknown) {
        return this.buildBlockedResult(
          "ATTRIBUTE",
          sourceKey,
          "INVALID_VERIFIED_MAPPING_RECORD",
          `Verified store returned invalid records: ${sanitizeErrorMessage(err)}`
        );
      }

      const verifiedRecords = trustedStoreRecords.filter((r) => r.verified === true);

      if (verifiedRecords.length > 0) {
        const uniqueCandidateIds = Array.from(new Set(verifiedRecords.map((r) => r.targetCandidateId)));

        if (uniqueCandidateIds.length > 1) {
          return this.buildBlockedResult(
            "ATTRIBUTE",
            sourceKey,
            "CONFLICTING_VERIFIED_MAPPING",
            `Multiple conflicting verified mappings found in store for '${sourceKey}'.`,
            "VERIFIED_STORE"
          );
        }

        const matchedCandidateId = uniqueCandidateIds[0]!;
        const candidateMatch = validatedSemanticInput.candidates.find((c) => c.id === matchedCandidateId);

        if (!candidateMatch) {
          return this.buildBlockedResult(
            "ATTRIBUTE",
            sourceKey,
            "STALE_VERIFIED_TARGET",
            `Verified target '${matchedCandidateId}' is not present in caller candidates allowlist.`,
            "VERIFIED_STORE"
          );
        }

        return deepFreeze({
          taskKind: "ATTRIBUTE",
          sourceKey,
          status: "RESOLVED" as CatalogMappingStatus,
          selectedCandidateId: candidateMatch.id,
          resolutionSource: "VERIFIED_STORE",
          confidence: 1.0,
          risk: "LOW",
          reviewRequired: false,
          reasonCode: "VERIFIED_STORE_MATCH" as CatalogMappingReasonCode,
          explanation: `Resolved deterministically via verified store match for '${sourceKey}'.`,
          evidenceRefs: [],
          requestId: null,
        });
      }
    }

    // Fallback to Phase 5A Semantic Service
    const semanticResult = await this.semanticService.executeTask(validatedSemanticInput);
    return this.translateSemanticResult("ATTRIBUTE", sourceKey, semanticResult);
  }

  private translateSemanticResult(
    taskKind: "CATEGORY" | "ATTRIBUTE",
    sourceKey: string | null,
    sem: SemanticIntelligenceResult
  ): CatalogMappingResult {
    let status: CatalogMappingStatus;
    let reasonCode: CatalogMappingReasonCode;
    let reviewRequired: boolean;
    let resolutionSource: "VERIFIED_STORE" | "DETERMINISTIC_RULE" | "AI" | "NONE";

    switch (sem.outcome) {
      case "RESOLVED_DETERMINISTICALLY":
        status = "RESOLVED";
        reasonCode = "DETERMINISTIC_RULE_MATCH";
        reviewRequired = false;
        resolutionSource = "DETERMINISTIC_RULE";
        break;

      case "SUGGESTED":
        status = "SUGGESTED";
        reasonCode = "AI_SUGGESTION";
        reviewRequired = true;
        resolutionSource = "AI";
        break;

      case "NEEDS_REVIEW":
        status = "NEEDS_REVIEW";
        reasonCode = "UNRESOLVED_NO_CANDIDATE";
        reviewRequired = true;
        resolutionSource = sem.source === "AI" ? "AI" : "NONE";
        break;

      case "INPUT_REJECTED":
        status = "BLOCKED_FOR_REVIEW";
        reasonCode = "SEMANTIC_INPUT_REJECTED";
        reviewRequired = true;
        resolutionSource = "NONE";
        break;

      case "PROVIDER_UNAVAILABLE":
        status = "BLOCKED_FOR_REVIEW";
        reasonCode = "SEMANTIC_PROVIDER_UNAVAILABLE";
        reviewRequired = true;
        resolutionSource = "NONE";
        break;

      case "INVALID_PROVIDER_OUTPUT":
        status = "BLOCKED_FOR_REVIEW";
        reasonCode = "SEMANTIC_INVALID_PROVIDER_OUTPUT";
        reviewRequired = true;
        resolutionSource = "NONE";
        break;

      case "DETERMINISTIC_RESOLVER_FAILURE":
        status = "BLOCKED_FOR_REVIEW";
        reasonCode = "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE";
        reviewRequired = true;
        resolutionSource = "NONE";
        break;

      default:
        status = "BLOCKED_FOR_REVIEW";
        reasonCode = "SEMANTIC_PROVIDER_UNAVAILABLE";
        reviewRequired = true;
        resolutionSource = "NONE";
        break;
    }

    return deepFreeze({
      taskKind,
      sourceKey,
      status,
      selectedCandidateId: sem.selectedCandidateId,
      resolutionSource,
      confidence: sem.confidence,
      risk: sem.risk,
      reviewRequired,
      reasonCode,
      explanation: sem.explanationSummary,
      evidenceRefs: sem.evidenceRefs ? [...sem.evidenceRefs] : [],
      requestId: sem.requestId,
    });
  }

  private buildBlockedResult(
    taskKind: "CATEGORY" | "ATTRIBUTE",
    sourceKey: string | null,
    reasonCode: CatalogMappingReasonCode,
    explanation: string,
    resolutionSource: "VERIFIED_STORE" | "NONE" = "NONE"
  ): CatalogMappingResult {
    return deepFreeze({
      taskKind,
      sourceKey,
      status: "BLOCKED_FOR_REVIEW" as CatalogMappingStatus,
      selectedCandidateId: null,
      resolutionSource,
      confidence: null,
      risk: "HIGH",
      reviewRequired: true,
      reasonCode,
      explanation,
      evidenceRefs: [],
      requestId: null,
    });
  }
}
