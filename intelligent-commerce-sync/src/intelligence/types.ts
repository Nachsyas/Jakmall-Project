/**
 * Phase 5A: Semantic Intelligence Safety Foundation
 * Core Type Definitions and Safe Task Contracts
 */

export type SemanticTaskKind =
  | "CATEGORY_MAPPING"
  | "ATTRIBUTE_MAPPING"
  | "ANOMALY_REVIEW"
  | "PARSER_RECOVERY_SUGGESTION";

export type SemanticOutcome =
  | "RESOLVED_DETERMINISTICALLY"
  | "SUGGESTED"
  | "NEEDS_REVIEW"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PROVIDER_OUTPUT"
  | "INPUT_REJECTED"
  | "DETERMINISTIC_RESOLVER_FAILURE";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type SemanticSource = "DETERMINISTIC" | "AI" | "NONE";

export interface SemanticCandidate {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly parentId?: string | undefined;
  readonly path?: string | undefined;
}

export interface SemanticEvidenceItem {
  readonly id: string;
  readonly text: string;
}

export interface SemanticSpecificationItem {
  readonly key: string;
  readonly value: string;
}

export interface CategoryMappingSemanticInput {
  readonly taskKind: "CATEGORY_MAPPING";
  readonly productTitle: string;
  readonly productDescription?: string | undefined;
  readonly brand?: string | undefined;
  readonly categoryHints?: readonly string[] | undefined;
  readonly sourceCategoryPath?: string | undefined;
  readonly candidates: readonly SemanticCandidate[];
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface AttributeMappingSemanticInput {
  readonly taskKind: "ATTRIBUTE_MAPPING";
  readonly sourceSpecificationKey: string;
  readonly sourceSpecificationValue: string;
  readonly brand?: string | undefined;
  readonly productTitle?: string | undefined;
  readonly candidates: readonly SemanticCandidate[];
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface AnomalyReviewSemanticInput {
  readonly taskKind: "ANOMALY_REVIEW";
  readonly productTitle: string;
  readonly selectedCategoryPath: string;
  readonly sourceSpecifications?: readonly SemanticSpecificationItem[] | undefined;
  readonly variantLabels?: readonly string[] | undefined;
  readonly suspectedAnomalyReasons?: readonly string[] | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export interface ParserRecoverySemanticInput {
  readonly taskKind: "PARSER_RECOVERY_SUGGESTION";
  readonly urlPath: string;
  readonly diagnosticLabels: readonly string[];
  readonly failureSignals: readonly string[];
  readonly suspectedDomMarkers?: readonly string[] | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export type SemanticTaskInput =
  | CategoryMappingSemanticInput
  | AttributeMappingSemanticInput
  | AnomalyReviewSemanticInput
  | ParserRecoverySemanticInput;

/**
 * Untrusted Provider Output Schema
 * Strictly limited to semantic evidence returned by the model.
 * Does NOT contain authoritative risk or reviewRequired fields.
 */
export interface SemanticProviderOutput {
  readonly schemaVersion: 1;
  readonly taskKind: SemanticTaskKind;
  readonly selectedCandidateId: string | null;
  readonly confidence: number;
  readonly explanationSummary: string;
  readonly evidenceRefs: readonly string[];
}

/**
 * Deterministic resolution result returned by deterministic resolver.
 */
export interface DeterministicResolutionResult {
  readonly resolved: boolean;
  readonly candidateId?: string | null | undefined;
  readonly explanation?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
}

export interface DeterministicSemanticResolver {
  resolve(input: SemanticTaskInput): Promise<DeterministicResolutionResult> | DeterministicResolutionResult;
}

/**
 * Provider-neutral request abstraction.
 * Signal is required to guarantee service-level cooperative and enforced timeout.
 * Candidate and evidence allowlists are always non-null concrete arrays.
 */
export interface SemanticProviderRequest {
  readonly requestId: string;
  readonly taskKind: SemanticTaskKind;
  readonly prompt: string;
  readonly systemInstruction: string;
  readonly untrustedData: Record<string, unknown>;
  readonly allowedCandidateIds: readonly string[];
  readonly allowedEvidenceIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface SemanticProviderResponse {
  readonly rawText: string;
}

export interface SemanticAiProvider {
  complete(request: SemanticProviderRequest): Promise<SemanticProviderResponse>;
}

/**
 * Authoritative, trusted semantic intelligence result.
 * Supports taskKind = null when input taskKind is invalid or missing.
 * Never fabricates values on failure.
 */
export interface SemanticIntelligenceResult {
  readonly outcome: SemanticOutcome;
  readonly schemaVersion: number;
  readonly taskKind: SemanticTaskKind | null;
  readonly requestId: string | null;
  readonly selectedCandidateId: string | null;
  readonly confidence: number | null;
  readonly risk: RiskLevel | null;
  readonly reviewRequired: boolean;
  readonly explanationSummary: string;
  readonly evidenceRefs: readonly string[];
  readonly source: SemanticSource;
  readonly error?: string | undefined;
}

/**
 * Custom Error Hierarchy
 */
export class SemanticIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticIntelligenceError";
  }
}

export class SemanticConfigurationError extends SemanticIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "SemanticConfigurationError";
  }
}

export class SemanticInputValidationError extends SemanticIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "SemanticInputValidationError";
  }
}

export class SemanticOutputValidationError extends SemanticIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "SemanticOutputValidationError";
  }
}

export class SemanticProviderError extends SemanticIntelligenceError {
  constructor(message: string) {
    super(message);
    this.name = "SemanticProviderError";
  }
}
