/**
 * Phase 5C: Review Intelligence Service
 * Orchestrates Deterministic Anomaly Detection -> Gated Semantic Anomaly Review.
 * Enforces monotonic safety: AI is purely advisory and can never block or clear reviews.
 */

import { computeDeterministicRisk, deepFreeze, sanitizeErrorMessage } from "../safety.js";
import { SemanticIntelligenceService } from "../semantic-intelligence-service.js";
import { normalizeLookupKey } from "../catalog/normalization.js";
import {
  detectDeterministicAnomalies,
  type TrustedProductReviewData,
} from "./deterministic-anomaly-detector.js";
import {
  REVIEW_BOUNDS,
  ReviewInputValidationError,
  type ProductReviewResult,
  type ReviewFinding,
  type ReviewMappingSnapshot,
  type ReviewStatus,
  type CatalogMappingStatus,
  type CatalogMappingReasonCode,
} from "./types.js";
import type {
  AnomalyReviewSemanticInput,
  SemanticSpecificationItem,
  SemanticEvidenceItem,
  SemanticTaskKind,
} from "../types.js";

const VALID_CATALOG_REASON_CODES = new Set<CatalogMappingReasonCode>([
  "VERIFIED_STORE_MATCH",
  "DETERMINISTIC_RULE_MATCH",
  "CONFLICTING_VERIFIED_MAPPING",
  "STALE_VERIFIED_TARGET",
  "VERIFIED_MAPPING_STORE_FAILURE",
  "INVALID_VERIFIED_MAPPING_RECORD",
  "INPUT_VALIDATION_ERROR",
  "AI_SUGGESTION",
  "UNRESOLVED_NO_CANDIDATE",
  "SEMANTIC_INPUT_REJECTED",
  "SEMANTIC_PROVIDER_UNAVAILABLE",
  "SEMANTIC_INVALID_PROVIDER_OUTPUT",
  "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE",
]);

export class ReviewIntelligenceService {
  private readonly semanticService: SemanticIntelligenceService;

  constructor(options: {
    semanticService: SemanticIntelligenceService;
  }) {
    if (!options || !options.semanticService || typeof options.semanticService.executeTask !== "function") {
      throw new ReviewInputValidationError("ReviewIntelligenceService requires a valid SemanticIntelligenceService.");
    }
    this.semanticService = options.semanticService;
  }

  /**
   * Evaluates product review deterministically, gating advisory AI anomaly review.
   * 1. Validates caller input and constructs fresh trusted snapshots (caller raw input unmodified & unfrozen).
   * 2. Evaluates structural anomalies via DeterministicAnomalyDetector.
   * 3. Gates AI: 0 calls for NO_REVIEW_TRIGGERED, BLOCKED_FOR_REVIEW, or structural-only findings.
   * 4. If semantic trigger present and context available, dispatches at most 1 ANOMALY_REVIEW call.
   * 5. Enforces monotonic safety: AI cannot block, clear, or author severity/reason codes.
   */
  async evaluateReview(rawInput: unknown): Promise<ProductReviewResult> {
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
      throw new ReviewInputValidationError("ProductReviewInput must be a non-null plain object.");
    }

    const proto = Object.getPrototypeOf(rawInput);
    if (proto !== Object.prototype && proto !== null) {
      throw new ReviewInputValidationError("ProductReviewInput must be a plain object.");
    }

    if (Object.getOwnPropertySymbols(rawInput).length > 0) {
      throw new ReviewInputValidationError("ProductReviewInput rejects symbol-keyed properties.");
    }

    const allowedTopKeys = new Set([
      "productTitle",
      "selectedCategoryPath",
      "sourceSpecifications",
      "mappingResults",
      "variantLabels",
      "suspectedAnomalyReasons",
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

    for (const key of Object.keys(rawInput as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) {
        throw new ReviewInputValidationError(`ProductReviewInput rejects forbidden domain property '${key}'.`);
      }
      if (!allowedTopKeys.has(key)) {
        throw new ReviewInputValidationError(`Unknown property '${key}' in ProductReviewInput.`);
      }
    }

    const req = rawInput as Record<string, unknown>;
    const semConfig = this.semanticService.getConfig();

    // 1. Validate Product Title & Category Path
    let productTitle: string | undefined;
    if (req.productTitle !== undefined) {
      if (typeof req.productTitle !== "string") {
        throw new ReviewInputValidationError("Property 'productTitle' must be a string.");
      }
      if (req.productTitle.length > semConfig.maxTextChars) {
        throw new ReviewInputValidationError("Property 'productTitle' exceeds maximum text length.");
      }
      productTitle = req.productTitle;
    }

    let selectedCategoryPath: string | undefined;
    if (req.selectedCategoryPath !== undefined) {
      if (typeof req.selectedCategoryPath !== "string") {
        throw new ReviewInputValidationError("Property 'selectedCategoryPath' must be a string.");
      }
      if (req.selectedCategoryPath.length > semConfig.maxTextChars) {
        throw new ReviewInputValidationError("Property 'selectedCategoryPath' exceeds maximum text length.");
      }
      selectedCategoryPath = req.selectedCategoryPath;
    }

    // 2. Validate & Project Minimized Mapping Snapshots (Trust Boundary)
    let mappingResults: ReviewMappingSnapshot[] | undefined;
    if (req.mappingResults !== undefined) {
      if (!Array.isArray(req.mappingResults)) {
        throw new ReviewInputValidationError("Property 'mappingResults' must be an array.");
      }
      for (let i = 0; i < req.mappingResults.length; i++) {
        if (!(i in req.mappingResults)) {
          throw new ReviewInputValidationError(`mappingResults array contains a sparse hole at index ${i}.`);
        }
      }
      if (req.mappingResults.length > REVIEW_BOUNDS.MAX_MAPPING_RESULTS) {
        throw new ReviewInputValidationError(
          `mappingResults count (${req.mappingResults.length}) exceeds maximum limit (${REVIEW_BOUNDS.MAX_MAPPING_RESULTS}).`
        );
      }

      mappingResults = [];
      const allowedMappingKeys = new Set([
        "taskKind",
        "sourceKey",
        "status",
        "selectedCandidateId",
        "resolutionSource",
        "confidence",
        "risk",
        "reviewRequired",
        "reasonCode",
      ]);

      for (let i = 0; i < req.mappingResults.length; i++) {
        const item = req.mappingResults[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new ReviewInputValidationError(`mappingResults item at index ${i} must be a non-null plain object.`);
        }
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new ReviewInputValidationError(`mappingResults item at index ${i} must be a plain object.`);
        }
        if (Object.getOwnPropertySymbols(item).length > 0) {
          throw new ReviewInputValidationError(`mappingResults item at index ${i} rejects symbol properties.`);
        }

        for (const k of Object.keys(item as Record<string, unknown>)) {
          if (!allowedMappingKeys.has(k)) {
            throw new ReviewInputValidationError(`Unknown property '${k}' in review mapping snapshot at index ${i}.`);
          }
        }

        const m = item as Record<string, unknown>;

        if (m.taskKind !== "CATEGORY" && m.taskKind !== "ATTRIBUTE") {
          throw new ReviewInputValidationError(`Invalid taskKind '${String(m.taskKind)}' at index ${i}.`);
        }

        if (
          m.status !== "RESOLVED" &&
          m.status !== "SUGGESTED" &&
          m.status !== "NEEDS_REVIEW" &&
          m.status !== "BLOCKED_FOR_REVIEW"
        ) {
          throw new ReviewInputValidationError(`Invalid status '${String(m.status)}' at index ${i}.`);
        }

        if (
          m.resolutionSource !== "VERIFIED_STORE" &&
          m.resolutionSource !== "DETERMINISTIC_RULE" &&
          m.resolutionSource !== "AI" &&
          m.resolutionSource !== "NONE"
        ) {
          throw new ReviewInputValidationError(`Invalid resolutionSource '${String(m.resolutionSource)}' at index ${i}.`);
        }

        if (m.sourceKey !== null) {
          if (typeof m.sourceKey !== "string") {
            throw new ReviewInputValidationError(`Property 'sourceKey' at index ${i} must be a string or null.`);
          }
          if (m.sourceKey.trim().length === 0) {
            throw new ReviewInputValidationError(`sourceKey at index ${i} cannot be blank.`);
          }
          if (m.sourceKey.length > REVIEW_BOUNDS.MAX_SOURCE_KEY_LENGTH) {
            throw new ReviewInputValidationError(`sourceKey length at index ${i} exceeds maximum limit.`);
          }
          let normalized: string;
          try {
            normalized = normalizeLookupKey(m.sourceKey);
          } catch {
            throw new ReviewInputValidationError(`sourceKey at index ${i} cannot be normalized.`);
          }
          if (normalized !== m.sourceKey) {
            throw new ReviewInputValidationError(`sourceKey at index ${i} must be canonically normalized.`);
          }
        }

        if (m.selectedCandidateId !== null) {
          if (typeof m.selectedCandidateId !== "string") {
            throw new ReviewInputValidationError(`Property 'selectedCandidateId' at index ${i} must be a string or null.`);
          }
          if (m.selectedCandidateId.trim().length === 0) {
            throw new ReviewInputValidationError(`selectedCandidateId at index ${i} cannot be blank or whitespace-only.`);
          }
          if (m.selectedCandidateId.length > semConfig.maxTextChars) {
            throw new ReviewInputValidationError(`selectedCandidateId length at index ${i} exceeds maximum limit.`);
          }
        }

        if (m.confidence !== null) {
          if (
            typeof m.confidence !== "number" ||
            !Number.isFinite(m.confidence) ||
            Number.isNaN(m.confidence) ||
            m.confidence < 0 ||
            m.confidence > 1
          ) {
            throw new ReviewInputValidationError(`Confidence at index ${i} must be a finite number between 0 and 1.`);
          }
        }

        if (m.risk !== null && m.risk !== "LOW" && m.risk !== "MEDIUM" && m.risk !== "HIGH") {
          throw new ReviewInputValidationError(`Invalid risk '${String(m.risk)}' at index ${i}.`);
        }

        if (typeof m.reviewRequired !== "boolean") {
          throw new ReviewInputValidationError(`Property 'reviewRequired' at index ${i} must be a boolean.`);
        }

        if (typeof m.reasonCode !== "string" || !VALID_CATALOG_REASON_CODES.has(m.reasonCode as CatalogMappingReasonCode)) {
          throw new ReviewInputValidationError(`Invalid or unknown reasonCode '${String(m.reasonCode)}' at index ${i}.`);
        }

        // Invariant 4.1: Any mapping with resolutionSource === "VERIFIED_STORE" must have sourceKey !== null
        if (m.resolutionSource === "VERIFIED_STORE" && m.sourceKey === null) {
          throw new ReviewInputValidationError(
            `Review mapping snapshot with resolutionSource 'VERIFIED_STORE' requires non-null sourceKey at index ${i}.`
          );
        }

        // Invariant 4.2: Store failure reasons require non-null sourceKey
        if (
          (m.reasonCode === "VERIFIED_MAPPING_STORE_FAILURE" || m.reasonCode === "INVALID_VERIFIED_MAPPING_RECORD") &&
          m.sourceKey === null
        ) {
          throw new ReviewInputValidationError(
            `Review mapping snapshot with reasonCode '${m.reasonCode}' requires non-null sourceKey at index ${i}.`
          );
        }

        // Invariant 4.3: ATTRIBUTE mapping results require non-null sourceKey unless INPUT_VALIDATION_ERROR
        if (m.taskKind === "ATTRIBUTE" && m.reasonCode !== "INPUT_VALIDATION_ERROR" && m.sourceKey === null) {
          throw new ReviewInputValidationError(
            `ATTRIBUTE mapping snapshot with reasonCode '${m.reasonCode}' requires non-null sourceKey at index ${i}.`
          );
        }

        // Exact cross-field state coherence validation across legitimate 5B families
        let validFamily = false;

        // Family A: Verified Store Resolution
        if (
          m.status === "RESOLVED" &&
          m.resolutionSource === "VERIFIED_STORE" &&
          m.reasonCode === "VERIFIED_STORE_MATCH" &&
          m.selectedCandidateId !== null &&
          m.confidence === 1.0 &&
          m.risk === "LOW" &&
          m.reviewRequired === false
        ) {
          validFamily = true;
        }

        // Family B: Deterministic Rule Resolution
        else if (
          m.status === "RESOLVED" &&
          m.resolutionSource === "DETERMINISTIC_RULE" &&
          m.reasonCode === "DETERMINISTIC_RULE_MATCH" &&
          m.selectedCandidateId !== null &&
          m.confidence === 1.0 &&
          m.risk === "LOW" &&
          m.reviewRequired === false
        ) {
          validFamily = true;
        }

        // Family C: AI Suggestion
        else if (
          m.status === "SUGGESTED" &&
          m.resolutionSource === "AI" &&
          m.reasonCode === "AI_SUGGESTION" &&
          m.selectedCandidateId !== null &&
          typeof m.confidence === "number" &&
          m.reviewRequired === true
        ) {
          const semanticTaskKind: SemanticTaskKind =
            m.taskKind === "CATEGORY" ? "CATEGORY_MAPPING" : "ATTRIBUTE_MAPPING";
          const expectedRisk = computeDeterministicRisk(
            semanticTaskKind,
            m.confidence,
            m.selectedCandidateId,
            "AI"
          );
          if (m.risk === expectedRisk) {
            validFamily = true;
          }
        }

        // Family D: Unresolved AI Mapping
        else if (
          m.status === "NEEDS_REVIEW" &&
          m.resolutionSource === "AI" &&
          m.reasonCode === "UNRESOLVED_NO_CANDIDATE" &&
          m.selectedCandidateId === null &&
          typeof m.confidence === "number" &&
          m.reviewRequired === true
        ) {
          const semanticTaskKind: SemanticTaskKind =
            m.taskKind === "CATEGORY" ? "CATEGORY_MAPPING" : "ATTRIBUTE_MAPPING";
          const expectedRisk = computeDeterministicRisk(
            semanticTaskKind,
            m.confidence,
            m.selectedCandidateId,
            "AI"
          );
          if (m.risk === expectedRisk) {
            validFamily = true;
          }
        }

        // Family E: Verified Store Blocks
        else if (
          m.status === "BLOCKED_FOR_REVIEW" &&
          m.resolutionSource === "VERIFIED_STORE" &&
          (m.reasonCode === "CONFLICTING_VERIFIED_MAPPING" || m.reasonCode === "STALE_VERIFIED_TARGET") &&
          m.selectedCandidateId === null &&
          m.confidence === null &&
          m.risk === "HIGH" &&
          m.reviewRequired === true
        ) {
          validFamily = true;
        }

        // Family F: Local Store / Input Blocks
        else if (
          m.status === "BLOCKED_FOR_REVIEW" &&
          m.resolutionSource === "NONE" &&
          (m.reasonCode === "VERIFIED_MAPPING_STORE_FAILURE" ||
            m.reasonCode === "INVALID_VERIFIED_MAPPING_RECORD" ||
            m.reasonCode === "INPUT_VALIDATION_ERROR") &&
          m.selectedCandidateId === null &&
          m.confidence === null &&
          m.risk === "HIGH" &&
          m.reviewRequired === true
        ) {
          validFamily = true;
        }

        // Family G: Phase 5A Failure Blocks
        else if (
          m.status === "BLOCKED_FOR_REVIEW" &&
          m.resolutionSource === "NONE" &&
          (m.reasonCode === "SEMANTIC_INPUT_REJECTED" ||
            m.reasonCode === "SEMANTIC_PROVIDER_UNAVAILABLE" ||
            m.reasonCode === "SEMANTIC_INVALID_PROVIDER_OUTPUT" ||
            m.reasonCode === "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE") &&
          m.selectedCandidateId === null &&
          m.confidence === null &&
          m.risk === null &&
          m.reviewRequired === true
        ) {
          validFamily = true;
        }

        if (!validFamily) {
          throw new ReviewInputValidationError(
            `Incoherent mapping snapshot state for reasonCode '${m.reasonCode}' with status '${m.status}' and resolutionSource '${m.resolutionSource}' at index ${i}.`
          );
        }

        const snapshot: ReviewMappingSnapshot = {
          taskKind: m.taskKind,
          sourceKey: m.sourceKey,
          status: m.status as CatalogMappingStatus,
          selectedCandidateId: m.selectedCandidateId,
          resolutionSource: m.resolutionSource,
          confidence: m.confidence,
          risk: m.risk,
          reviewRequired: m.reviewRequired,
          reasonCode: m.reasonCode as CatalogMappingReasonCode,
        };

        mappingResults.push(snapshot);
      }
    }

    // 3. Validate Variant Labels (Blank strings allowed through for detection)
    let variantLabels: string[] | undefined;
    if (req.variantLabels !== undefined) {
      if (!Array.isArray(req.variantLabels)) {
        throw new ReviewInputValidationError("Property 'variantLabels' must be an array.");
      }
      for (let i = 0; i < req.variantLabels.length; i++) {
        if (!(i in req.variantLabels)) {
          throw new ReviewInputValidationError(`variantLabels array contains a sparse hole at index ${i}.`);
        }
      }
      if (req.variantLabels.length > REVIEW_BOUNDS.MAX_VARIANT_LABELS) {
        throw new ReviewInputValidationError(
          `variantLabels length (${req.variantLabels.length}) exceeds maximum limit (${REVIEW_BOUNDS.MAX_VARIANT_LABELS}).`
        );
      }
      variantLabels = [];
      for (let i = 0; i < req.variantLabels.length; i++) {
        const item = req.variantLabels[i];
        if (typeof item !== "string") {
          throw new ReviewInputValidationError(`Item in 'variantLabels' at index ${i} must be a string.`);
        }
        if (item.trim().length > 0 && item.length > 500) {
          throw new ReviewInputValidationError(`Non-blank variant label at index ${i} exceeds maximum length (500).`);
        }
        variantLabels.push(item);
      }
    }

    // 4. Validate Suspected Anomaly Reasons
    let suspectedAnomalyReasons: string[] | undefined;
    if (req.suspectedAnomalyReasons !== undefined) {
      if (!Array.isArray(req.suspectedAnomalyReasons)) {
        throw new ReviewInputValidationError("Property 'suspectedAnomalyReasons' must be an array.");
      }
      for (let i = 0; i < req.suspectedAnomalyReasons.length; i++) {
        if (!(i in req.suspectedAnomalyReasons)) {
          throw new ReviewInputValidationError(`suspectedAnomalyReasons array contains a sparse hole at index ${i}.`);
        }
      }
      if (req.suspectedAnomalyReasons.length > REVIEW_BOUNDS.MAX_SUSPECTED_ANOMALY_REASONS) {
        throw new ReviewInputValidationError(
          `suspectedAnomalyReasons length exceeds limit (${REVIEW_BOUNDS.MAX_SUSPECTED_ANOMALY_REASONS}).`
        );
      }
      suspectedAnomalyReasons = [];
      for (let i = 0; i < req.suspectedAnomalyReasons.length; i++) {
        const item = req.suspectedAnomalyReasons[i];
        if (typeof item !== "string" || item.trim().length === 0) {
          throw new ReviewInputValidationError(`Item in 'suspectedAnomalyReasons' at index ${i} must be a non-blank string.`);
        }
        if (item.length > REVIEW_BOUNDS.MAX_REASON_MESSAGE_LENGTH) {
          throw new ReviewInputValidationError(
            `Item in 'suspectedAnomalyReasons' at index ${i} exceeds maximum length (${REVIEW_BOUNDS.MAX_REASON_MESSAGE_LENGTH}).`
          );
        }
        suspectedAnomalyReasons.push(item);
      }
    }

    // 5. Validate Source Specifications (Reuse Phase 5A Semantic Contract)
    let sourceSpecifications: SemanticSpecificationItem[] | undefined;
    if (req.sourceSpecifications !== undefined) {
      if (!Array.isArray(req.sourceSpecifications)) {
        throw new ReviewInputValidationError("Property 'sourceSpecifications' must be an array.");
      }
      for (let i = 0; i < req.sourceSpecifications.length; i++) {
        if (!(i in req.sourceSpecifications)) {
          throw new ReviewInputValidationError(`sourceSpecifications contains a sparse hole at index ${i}.`);
        }
      }
      if (req.sourceSpecifications.length > semConfig.maxSpecifications) {
        throw new ReviewInputValidationError(
          `sourceSpecifications count (${req.sourceSpecifications.length}) exceeds maximum limit (${semConfig.maxSpecifications}).`
        );
      }
      sourceSpecifications = [];
      const allowedSpecKeys = new Set(["key", "value"]);
      for (let i = 0; i < req.sourceSpecifications.length; i++) {
        const item = req.sourceSpecifications[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new ReviewInputValidationError(`Specification item at index ${i} must be a non-null object.`);
        }
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new ReviewInputValidationError(`Specification item at index ${i} must be a plain object.`);
        }
        if (Object.getOwnPropertySymbols(item).length > 0) {
          throw new ReviewInputValidationError(`Specification item at index ${i} rejects symbol properties.`);
        }
        for (const k of Object.keys(item as Record<string, unknown>)) {
          if (!allowedSpecKeys.has(k)) {
            throw new ReviewInputValidationError(`Unknown property '${k}' in specification item at index ${i}.`);
          }
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.key !== "string" || obj.key.trim().length === 0) {
          throw new ReviewInputValidationError(`Specification key at index ${i} must be a non-blank string.`);
        }
        if (obj.key.length > semConfig.maxTextChars) {
          throw new ReviewInputValidationError(`Specification key at index ${i} exceeds maximum length bound.`);
        }
        if (typeof obj.value !== "string") {
          throw new ReviewInputValidationError(`Specification value at index ${i} must be a string.`);
        }
        if (obj.value.length > semConfig.maxTextChars) {
          throw new ReviewInputValidationError(`Specification value at index ${i} exceeds maximum length bound.`);
        }
        sourceSpecifications.push({ key: obj.key, value: obj.value });
      }
    }

    // 6. Validate Evidence (Reuse Phase 5A Semantic Contract)
    let evidence: SemanticEvidenceItem[] | undefined;
    if (req.evidence !== undefined) {
      if (!Array.isArray(req.evidence)) {
        throw new ReviewInputValidationError("Property 'evidence' must be an array.");
      }
      for (let i = 0; i < req.evidence.length; i++) {
        if (!(i in req.evidence)) {
          throw new ReviewInputValidationError(`evidence array contains a sparse hole at index ${i}.`);
        }
      }
      if (req.evidence.length > semConfig.maxEvidenceItems) {
        throw new ReviewInputValidationError(
          `evidence count (${req.evidence.length}) exceeds maximum limit (${semConfig.maxEvidenceItems}).`
        );
      }
      evidence = [];
      const allowedEvidenceKeys = new Set(["id", "text"]);
      const seenEvidenceIds = new Set<string>();
      for (let i = 0; i < req.evidence.length; i++) {
        const item = req.evidence[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new ReviewInputValidationError(`Evidence item at index ${i} must be a non-null object.`);
        }
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new ReviewInputValidationError(`Evidence item at index ${i} must be a plain object.`);
        }
        if (Object.getOwnPropertySymbols(item).length > 0) {
          throw new ReviewInputValidationError(`Evidence item at index ${i} rejects symbol properties.`);
        }
        for (const k of Object.keys(item as Record<string, unknown>)) {
          if (!allowedEvidenceKeys.has(k)) {
            throw new ReviewInputValidationError(`Unknown property '${k}' in evidence item at index ${i}.`);
          }
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
          throw new ReviewInputValidationError(`Evidence item at index ${i} must have non-blank id.`);
        }
        if (obj.id.length > semConfig.maxTextChars) {
          throw new ReviewInputValidationError(`Evidence item id at index ${i} exceeds maximum length.`);
        }
        if (typeof obj.text !== "string" || obj.text.trim().length === 0) {
          throw new ReviewInputValidationError(`Evidence item at index ${i} must have non-blank text.`);
        }
        if (obj.text.length > semConfig.maxTextChars) {
          throw new ReviewInputValidationError(`Evidence item text at index ${i} exceeds maximum length.`);
        }
        if (seenEvidenceIds.has(obj.id)) {
          throw new ReviewInputValidationError(`Duplicate evidence ID '${obj.id}' at index ${i}.`);
        }
        seenEvidenceIds.add(obj.id);
        evidence.push({ id: obj.id, text: obj.text });
      }
    }

    // Construct fresh trusted snapshot and deepFreeze it (caller raw input remains unfrozen)
    const trustedSnapshot = deepFreeze({
      productTitle,
      selectedCategoryPath,
      mappingResults: mappingResults ? [...mappingResults] : undefined,
      variantLabels: variantLabels ? [...variantLabels] : undefined,
      suspectedAnomalyReasons: suspectedAnomalyReasons ? [...suspectedAnomalyReasons] : undefined,
      sourceSpecifications: sourceSpecifications ? [...sourceSpecifications] : undefined,
      evidence: evidence ? [...evidence] : undefined,
    });

    // 7. Run Deterministic Anomaly Detection
    const reviewData: TrustedProductReviewData = {
      productTitle: trustedSnapshot.productTitle,
      selectedCategoryPath: trustedSnapshot.selectedCategoryPath,
      mappingResults: trustedSnapshot.mappingResults,
      variantLabels: trustedSnapshot.variantLabels,
      suspectedAnomalyReasons: trustedSnapshot.suspectedAnomalyReasons,
    };

    const { status: baselineStatus, findings: baselineFindings } = detectDeterministicAnomalies(reviewData);

    // 8. Evaluate Semantic Anomaly Review Gating
    let finalStatus: ReviewStatus = baselineStatus;
    let advisorySummary: string | null = null;
    const finalFindings: ReviewFinding[] = [...baselineFindings];

    // AI is gated strictly:
    // 0 calls if NO_REVIEW_TRIGGERED
    // 0 calls if BLOCKED_FOR_REVIEW
    // 0 calls if structural-only findings (DUPLICATE_VARIANT_LABEL or BLANK_VARIANT_LABEL only)
    if (baselineStatus === "NEEDS_REVIEW") {
      const hasEligibleSemanticTrigger = baselineFindings.some(
        (f) =>
          f.code === "SUSPECTED_ANOMALY_FLAGGED" ||
          f.code === "MAPPING_REVIEW_REQUIRED" ||
          f.code === "LOW_CONFIDENCE_MAPPING"
      );

      // Enforce MAX_FINDINGS cost boundary: if findings already reach MAX_FINDINGS, skip semantic call
      if (hasEligibleSemanticTrigger && baselineFindings.length < REVIEW_BOUNDS.MAX_FINDINGS) {
        // Required semantic context check
        const hasSemanticContext =
          typeof trustedSnapshot.productTitle === "string" &&
          trustedSnapshot.productTitle.trim().length > 0 &&
          typeof trustedSnapshot.selectedCategoryPath === "string" &&
          trustedSnapshot.selectedCategoryPath.trim().length > 0;

        if (hasSemanticContext) {
          const semanticInput: AnomalyReviewSemanticInput = {
            taskKind: "ANOMALY_REVIEW",
            productTitle: trustedSnapshot.productTitle!,
            selectedCategoryPath: trustedSnapshot.selectedCategoryPath!,
            ...(trustedSnapshot.sourceSpecifications && trustedSnapshot.sourceSpecifications.length > 0
              ? { sourceSpecifications: trustedSnapshot.sourceSpecifications }
              : {}),
            ...(trustedSnapshot.variantLabels && trustedSnapshot.variantLabels.length > 0
              ? { variantLabels: trustedSnapshot.variantLabels }
              : {}),
            ...(trustedSnapshot.suspectedAnomalyReasons && trustedSnapshot.suspectedAnomalyReasons.length > 0
              ? { suspectedAnomalyReasons: trustedSnapshot.suspectedAnomalyReasons }
              : {}),
            ...(trustedSnapshot.evidence && trustedSnapshot.evidence.length > 0
              ? { evidence: trustedSnapshot.evidence }
              : {}),
          };

          try {
            const semResult = await this.semanticService.executeTask(semanticInput);

            // Monotonic invariant: AI cannot convert to BLOCKED_FOR_REVIEW or NO_REVIEW_TRIGGERED
            finalStatus = "NEEDS_REVIEW";

            // Provenance gate: only record advisory summary and AI_ANOMALY_ANNOTATION if source is AI
            if (semResult.source === "AI") {
              advisorySummary = semResult.explanationSummary;
              const annotationMessage = semResult.explanationSummary;
              if (annotationMessage.length <= REVIEW_BOUNDS.MAX_REASON_MESSAGE_LENGTH) {
                finalFindings.push({
                  code: "AI_ANOMALY_ANNOTATION",
                  severity: "INFO",
                  message: annotationMessage,
                  field: "advisory",
                });

                // Re-sort findings code-unit stably
                finalFindings.sort((a, b) => {
                  const keyA = `${a.code}:${a.field ?? ""}`;
                  const keyB = `${b.code}:${b.field ?? ""}`;
                  if (keyA !== keyB) {
                    return keyA < keyB ? -1 : 1;
                  }
                  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
                });
              }
            }
          } catch {
            // Malformed or failed provider call preserves deterministic status safely
            finalStatus = "NEEDS_REVIEW";
            advisorySummary = null;
          }
        }
      }
    }

    const blockingIssueCount = finalFindings.filter((f) => f.severity === "BLOCK").length;
    const reviewIssueCount = finalFindings.filter((f) => f.severity === "REVIEW").length;
    const reviewRequired = finalStatus !== "NO_REVIEW_TRIGGERED";

    return deepFreeze({
      status: finalStatus,
      findings: finalFindings,
      advisorySummary,
      reviewRequired,
      blockingIssueCount,
      reviewIssueCount,
    });
  }
}
