/**
 * Phase 5C: Review Intelligence Domain Types & Result Models
 * Strictly advisory contracts for Deterministic Anomaly Detection & Gated Semantic Review.
 */

import type {
  SemanticSpecificationItem,
  SemanticEvidenceItem,
} from "../types.js";
import type {
  CatalogMappingStatus,
  CatalogMappingReasonCode,
  CatalogMappingResult,
} from "../catalog/types.js";

export type {
  CatalogMappingStatus,
  CatalogMappingReasonCode,
  CatalogMappingResult,
};

export const REVIEW_BOUNDS = {
  MAX_MAPPING_RESULTS: 50,
  MAX_VARIANT_LABELS: 50,
  MAX_FINDINGS: 100,
  MAX_SOURCE_KEY_LENGTH: 500,
  MAX_REASON_MESSAGE_LENGTH: 1000,
  MAX_SUSPECTED_ANOMALY_REASONS: 20,
} as const;

export type ReviewStatus =
  | "NO_REVIEW_TRIGGERED"
  | "NEEDS_REVIEW"
  | "BLOCKED_FOR_REVIEW";

export type ReviewReasonCode =
  | "MAPPING_REVIEW_REQUIRED"
  | "MAPPING_FAILURE"
  | "CONFLICTING_MAPPING_RESULTS"
  | "LOW_CONFIDENCE_MAPPING"
  | "DUPLICATE_VARIANT_LABEL"
  | "BLANK_VARIANT_LABEL"
  | "CONFLICTING_VERIFIED_MAPPING"
  | "STALE_VERIFIED_TARGET"
  | "SUSPECTED_ANOMALY_FLAGGED"
  | "AI_ANOMALY_ANNOTATION";

export interface ReviewFinding {
  readonly code: ReviewReasonCode;
  readonly severity: "BLOCK" | "REVIEW" | "INFO";
  readonly message: string;
  readonly field?: string | undefined;
}

/**
 * Minimized trusted snapshot of a catalog mapping result for review consumption.
 * Discards unneeded 5B explanation, evidence, and requestId fields to minimize trust boundary surface.
 */
export interface ReviewMappingSnapshot {
  readonly taskKind: "CATEGORY" | "ATTRIBUTE";
  readonly sourceKey: string | null;
  readonly status: CatalogMappingStatus;
  readonly selectedCandidateId: string | null;
  readonly resolutionSource: "VERIFIED_STORE" | "DETERMINISTIC_RULE" | "AI" | "NONE";
  readonly confidence: number | null;
  readonly risk: "LOW" | "MEDIUM" | "HIGH" | null;
  readonly reviewRequired: boolean;
  readonly reasonCode: CatalogMappingReasonCode;
}

export interface ProductReviewInput {
  readonly productTitle?: string | undefined;
  readonly selectedCategoryPath?: string | undefined;
  readonly sourceSpecifications?: readonly SemanticSpecificationItem[] | undefined;
  readonly mappingResults?: readonly ReviewMappingSnapshot[] | undefined;
  readonly variantLabels?: readonly string[] | undefined;
  readonly suspectedAnomalyReasons?: readonly string[] | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface ProductReviewResult {
  readonly status: ReviewStatus;
  readonly findings: readonly ReviewFinding[];
  readonly advisorySummary: string | null;
  readonly reviewRequired: boolean;
  readonly blockingIssueCount: number;
  readonly reviewIssueCount: number;
}

export class ReviewIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewIntelligenceError";
  }
}

export class ReviewInputValidationError extends ReviewIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputValidationError";
  }
}
