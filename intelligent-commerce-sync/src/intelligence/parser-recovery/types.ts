/**
 * Phase 5D: Parser Recovery Assistance
 * Domain Types, Finite Codes, Bounds, and Error Hierarchies
 */

import type { SemanticEvidenceItem } from "../types.js";

export type ParserRecoveryFailureCode =
  | "INVALID_SOURCE_URL"
  | "SSRF_BLOCKED"
  | "SOURCE_RATE_LIMITED"
  | "PRODUCT_NOT_FOUND"
  | "SOURCE_FETCH_FAILED"
  | "TITLE_NOT_FOUND"
  | "EXTRACTION_VALIDATION_FAILED"
  | "EXTRACTION_FAILED"
  | "MISSING_PRICE"
  | "INVALID_PRICE";

export type ParserRecoveryObservation =
  | "SPDT_SCRIPT_MISSING_OBSERVED"
  | "SPDT_SYNTAX_FAILURE_OBSERVED"
  | "JSON_LD_PRODUCT_MISSING_OBSERVED"
  | "JSON_LD_PRICE_INVALID_OBSERVED"
  | "SKU_RECORD_EMPTY_OBSERVED"
  | "FETCH_TIMEOUT_OBSERVED";

export type ParserRecoveryStatus =
  | "RECOVERY_GUIDANCE_AVAILABLE"
  | "BLOCKED_FOR_REVIEW";

export type ParserRecoveryReasonCode =
  // Local input validation failure
  | "INPUT_VALIDATION_ERROR"

  // Authoritative non-semantic source blocker (404, 429, SSRF, network transport)
  | "NON_SEMANTIC_SOURCE_FAILURE"

  // Local deterministic diagnostics & guidance available (no AI call needed)
  | "DETERMINISTIC_GUIDANCE_AVAILABLE"

  // Phase 5A resolved deterministically (DeterministicSemanticResolver)
  | "SEMANTIC_DETERMINISTIC_GUIDANCE"

  // Phase 5A AI provider generated advisory suggestion
  | "AI_RECOVERY_SUGGESTION"

  // Phase 5A service / provider failures
  | "SEMANTIC_INPUT_REJECTED"
  | "SEMANTIC_PROVIDER_UNAVAILABLE"
  | "SEMANTIC_INVALID_PROVIDER_OUTPUT"
  | "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE";

export type ParserDiagnosticCode =
  // Non-semantic client / network failures
  | "DIAG_INVALID_SOURCE_URL"
  | "DIAG_SSRF_BLOCKED"
  | "DIAG_RATE_LIMITED"
  | "DIAG_PRODUCT_NOT_FOUND"
  | "DIAG_SOURCE_FETCH_FAILED"
  | "DIAG_NETWORK_TIMEOUT"

  // Structural page failures
  | "DIAG_PRODUCT_TITLE_MISSING"

  // SPDT / JSON-LD extraction failures
  | "DIAG_SPDT_SCHEMA_MISMATCH"
  | "DIAG_EXTRACTION_FAILED_UNKNOWN"
  | "DIAG_JSON_LD_PRODUCT_MISSING"
  | "DIAG_JSON_LD_PRICE_INVALID"

  // Authoritative price failures
  | "DIAG_AUTHORITATIVE_PRICE_MISSING"
  | "DIAG_AUTHORITATIVE_PRICE_INVALID"

  // Diagnostic observations
  | "DIAG_SPDT_SCRIPT_MISSING_OBSERVED"
  | "DIAG_SPDT_SYNTAX_FAILURE_OBSERVED"
  | "DIAG_SKU_RECORD_EMPTY_OBSERVED";

export interface ParserDiagnosticFinding {
  readonly code: ParserDiagnosticCode;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly details: string;
}

export interface ParserRecoveryInput {
  readonly sourceUrlOrPath: string;
  readonly failureCode?: ParserRecoveryFailureCode | undefined;
  readonly failureMessage?: string | undefined;
  readonly observations?: readonly ParserRecoveryObservation[] | undefined;
  readonly suspectedDomMarkers?: readonly string[] | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface ParserRecoveryResult {
  readonly status: ParserRecoveryStatus;
  readonly reasonCode: ParserRecoveryReasonCode;
  readonly urlPath: string | null;
  readonly diagnostics: readonly ParserDiagnosticFinding[];
  readonly recoveryGuidance: readonly string[];
  readonly semanticSummary: string | null;
  readonly semanticSource: "DETERMINISTIC" | "AI" | null;
  readonly semanticRequestId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly risk: "HIGH";
  readonly reviewRequired: true;
}

export const PARSER_RECOVERY_BOUNDS = Object.freeze({
  MAX_URL_PATH_LENGTH: 500,
  MAX_FAILURE_MESSAGE_LENGTH: 500,
  MAX_OBSERVATIONS_COUNT: 10,
  MAX_DOM_MARKER_COUNT: 10,
  MAX_DOM_MARKER_LENGTH: 100,
  MAX_EVIDENCE_COUNT: 5,
  MAX_EVIDENCE_ITEM_LENGTH: 500,
  MAX_DIAGNOSTICS_COUNT: 20,
  MAX_GUIDANCE_COUNT: 10,
  MAX_GUIDANCE_LENGTH: 500,
});

export class ParserRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserRecoveryError";
  }
}

export class ParserRecoveryInputValidationError extends ParserRecoveryError {
  constructor(message: string) {
    super(message);
    this.name = "ParserRecoveryInputValidationError";
  }
}
