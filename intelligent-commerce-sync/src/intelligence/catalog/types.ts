/**
 * Phase 5B: Catalog Intelligence Domain Types & Result Models
 * Strictly advisory contracts for Category & Attribute Intelligence.
 */

import type {
  SemanticCandidate,
  SemanticEvidenceItem,
} from "../types.js";

export const CATALOG_BOUNDS = {
  MAX_SOURCE_KEY_LENGTH: 500,
  MAX_CANDIDATES: 100,
  MAX_RAW_STORE_RECORDS: 50,
} as const;

export type CatalogMappingTaskKind = "CATEGORY" | "ATTRIBUTE";

export type CatalogMappingStatus =
  | "RESOLVED"
  | "SUGGESTED"
  | "NEEDS_REVIEW"
  | "BLOCKED_FOR_REVIEW";

export type CatalogMappingReasonCode =
  | "VERIFIED_STORE_MATCH"
  | "DETERMINISTIC_RULE_MATCH"
  | "CONFLICTING_VERIFIED_MAPPING"
  | "STALE_VERIFIED_TARGET"
  | "VERIFIED_MAPPING_STORE_FAILURE"
  | "INVALID_VERIFIED_MAPPING_RECORD"
  | "INPUT_VALIDATION_ERROR"
  | "AI_SUGGESTION"
  | "UNRESOLVED_NO_CANDIDATE"
  | "SEMANTIC_INPUT_REJECTED"
  | "SEMANTIC_PROVIDER_UNAVAILABLE"
  | "SEMANTIC_INVALID_PROVIDER_OUTPUT"
  | "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE";

export interface CategoryMappingRequest {
  readonly productTitle: string;
  readonly candidates: readonly SemanticCandidate[];
  readonly productDescription?: string | undefined;
  readonly brand?: string | undefined;
  readonly categoryHints?: readonly string[] | undefined;
  readonly sourceCategoryPath?: string | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface AttributeMappingRequest {
  readonly sourceSpecificationKey: string;
  readonly sourceSpecificationValue: string;
  readonly candidates: readonly SemanticCandidate[];
  readonly brand?: string | undefined;
  readonly productTitle?: string | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface CatalogMappingResult {
  readonly taskKind: CatalogMappingTaskKind;
  readonly sourceKey: string | null;
  readonly status: CatalogMappingStatus;
  readonly selectedCandidateId: string | null;
  readonly resolutionSource: "VERIFIED_STORE" | "DETERMINISTIC_RULE" | "AI" | "NONE";
  readonly confidence: number | null;
  readonly risk: "LOW" | "MEDIUM" | "HIGH" | null;
  readonly reviewRequired: boolean;
  readonly reasonCode: CatalogMappingReasonCode;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
  readonly requestId: string | null;
}

export class CatalogIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogIntelligenceError";
  }
}

export class CatalogInputValidationError extends CatalogIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogInputValidationError";
  }
}
