/**
 * Phase 5D: Parser Recovery Service
 * Deterministic-First Diagnostic Orchestrator with Phase 5A Advisory Integration
 */

import { deepFreeze } from "../safety.js";
import { SemanticIntelligenceService } from "../semantic-intelligence-service.js";
import type {
  ParserRecoverySemanticInput,
  SemanticEvidenceItem,
  SemanticIntelligenceResult,
} from "../types.js";
import {
  type ParserRecoveryInput,
  type ParserRecoveryResult,
  type ParserRecoveryStatus,
  type ParserRecoveryReasonCode,
  type ParserRecoveryFailureCode,
  type ParserRecoveryObservation,
  type ParserDiagnosticFinding,
  PARSER_RECOVERY_BOUNDS,
  ParserRecoveryError,
  ParserRecoveryInputValidationError,
} from "./types.js";
import {
  generateDeterministicDiagnostics,
  hasNonSemanticBlocker,
  hasStructuralDiagnostic,
} from "./deterministic-parser-diagnostics.js";

const VALID_FAILURE_CODES = new Set<ParserRecoveryFailureCode>([
  "INVALID_SOURCE_URL",
  "SSRF_BLOCKED",
  "SOURCE_RATE_LIMITED",
  "PRODUCT_NOT_FOUND",
  "SOURCE_FETCH_FAILED",
  "TITLE_NOT_FOUND",
  "EXTRACTION_VALIDATION_FAILED",
  "EXTRACTION_FAILED",
  "MISSING_PRICE",
  "INVALID_PRICE",
]);

const VALID_OBSERVATIONS = new Set<ParserRecoveryObservation>([
  "SPDT_SCRIPT_MISSING_OBSERVED",
  "SPDT_SYNTAX_FAILURE_OBSERVED",
  "JSON_LD_PRODUCT_MISSING_OBSERVED",
  "JSON_LD_PRICE_INVALID_OBSERVED",
  "SKU_RECORD_EMPTY_OBSERVED",
  "FETCH_TIMEOUT_OBSERVED",
]);

const ALLOWED_INPUT_KEYS = new Set([
  "sourceUrlOrPath",
  "failureCode",
  "failureMessage",
  "observations",
  "suspectedDomMarkers",
  "evidence",
]);

const ALLOWED_EVIDENCE_KEYS = new Set(["id", "text"]);

interface ValidatedUrlResult {
  readonly valid: boolean;
  readonly urlPath: string | null;
  readonly error?: string | undefined;
}

/**
 * Strict URL and relative path sanitizer.
 * Enforces host allowlist, credential rejection, query/fragment removal,
 * and canonical pathname normalization.
 */
export function sanitizeSourceUrlOrPath(raw: string): ValidatedUrlResult {
  if (typeof raw !== "string") {
    return { valid: false, urlPath: null, error: "sourceUrlOrPath must be a string." };
  }

  // Raw ASCII control characters (< 32, 127) must be rejected BEFORE trim
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) {
      return { valid: false, urlPath: null, error: "Control characters in URL or path are strictly rejected." };
    }
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, urlPath: null, error: "sourceUrlOrPath cannot be empty or whitespace-only." };
  }

  // Full URL form: starts with http: or https:
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { valid: false, urlPath: null, error: "Malformed URL format." };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, urlPath: null, error: `Unsupported protocol: ${parsed.protocol}.` };
    }

    const host = parsed.hostname.toLowerCase();
    if (host !== "jakmall.com" && host !== "www.jakmall.com") {
      return { valid: false, urlPath: null, error: `Unauthorized host '${host}'. Host must be jakmall.com or www.jakmall.com.` };
    }

    if (parsed.username !== "" || parsed.password !== "") {
      return { valid: false, urlPath: null, error: "Credential-bearing URLs are strictly rejected." };
    }

    let canonicalPath = parsed.pathname;
    if (!canonicalPath || canonicalPath === "") {
      canonicalPath = "/";
    }

    if (canonicalPath.length > PARSER_RECOVERY_BOUNDS.MAX_URL_PATH_LENGTH) {
      return { valid: false, urlPath: null, error: `Canonical URL path exceeds maximum length of ${PARSER_RECOVERY_BOUNDS.MAX_URL_PATH_LENGTH}.` };
    }

    return { valid: true, urlPath: canonicalPath };
  }

  // Relative path form: starts with "/"
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) {
      return { valid: false, urlPath: null, error: "Protocol-relative paths starting with '//' are rejected." };
    }

    if (trimmed.includes("\\")) {
      return { valid: false, urlPath: null, error: "Backslash characters in paths are rejected." };
    }

    // Strip query string and fragment
    const questionIndex = trimmed.indexOf("?");
    const pathNoQuery = questionIndex === -1 ? trimmed : trimmed.slice(0, questionIndex);
    const hashIndex = pathNoQuery.indexOf("#");
    const cleanPath = hashIndex === -1 ? pathNoQuery : pathNoQuery.slice(0, hashIndex);

    if (!cleanPath.startsWith("/")) {
      return { valid: false, urlPath: null, error: "Path must start with '/'." };
    }

    if (cleanPath.length > PARSER_RECOVERY_BOUNDS.MAX_URL_PATH_LENGTH) {
      return { valid: false, urlPath: null, error: `Canonical path exceeds maximum length of ${PARSER_RECOVERY_BOUNDS.MAX_URL_PATH_LENGTH}.` };
    }

    return { valid: true, urlPath: cleanPath };
  }

  return { valid: false, urlPath: null, error: "sourceUrlOrPath must be a valid JakMall URL or relative path starting with '/'." };
}

interface ValidatedInputSnapshot {
  readonly sanitizedUrlPath: string;
  readonly failureCode?: ParserRecoveryFailureCode | undefined;
  readonly failureMessage?: string | undefined;
  readonly observations?: readonly ParserRecoveryObservation[] | undefined;
  readonly suspectedDomMarkers?: readonly string[] | undefined;
  readonly evidence?: readonly SemanticEvidenceItem[] | undefined;
}

export class ParserRecoveryService {
  constructor(private readonly semanticService: SemanticIntelligenceService) {
    if (!semanticService || typeof semanticService.executeTask !== "function") {
      throw new ParserRecoveryError("ParserRecoveryService requires a valid SemanticIntelligenceService instance.");
    }
  }

  /**
   * Evaluates parser degradation or failure evidence deterministically,
   * escalating to Phase 5A Semantic Intelligence when structurally eligible and contextual evidence exists.
   */
  async evaluate(rawInput: unknown): Promise<ParserRecoveryResult> {
    // 1. Strict Input Validation (Plain object, no symbols, exact keys)
    let validated: ValidatedInputSnapshot;
    try {
      validated = this.validateRawInput(rawInput);
    } catch {
      // Local input validation failed: fail closed
      let safePath: string | null = null;
      if (
        typeof rawInput === "object" &&
        rawInput !== null &&
        "sourceUrlOrPath" in rawInput &&
        typeof (rawInput as Record<string, unknown>).sourceUrlOrPath === "string"
      ) {
        const urlCheck = sanitizeSourceUrlOrPath((rawInput as Record<string, unknown>).sourceUrlOrPath as string);
        if (urlCheck.valid) {
          safePath = urlCheck.urlPath;
        }
      }

      return deepFreeze({
        status: "BLOCKED_FOR_REVIEW",
        reasonCode: "INPUT_VALIDATION_ERROR",
        urlPath: safePath,
        diagnostics: [],
        recoveryGuidance: [],
        semanticSummary: null,
        semanticSource: null,
        semanticRequestId: null,
        evidenceRefs: [],
        risk: "HIGH",
        reviewRequired: true,
      });
    }

    const { sanitizedUrlPath, failureCode, failureMessage, observations, suspectedDomMarkers, evidence } = validated;

    // 2. Generate Authoritative Deterministic Diagnostics & Guidance
    const { diagnostics, recoveryGuidance } = generateDeterministicDiagnostics({
      failureCode,
      failureMessage,
      observations,
    });

    // 3. Non-Semantic Blocker Check (Section 8 & 14: Blocker Dominance)
    if (hasNonSemanticBlocker(failureCode, observations)) {
      return deepFreeze({
        status: "BLOCKED_FOR_REVIEW",
        reasonCode: "NON_SEMANTIC_SOURCE_FAILURE",
        urlPath: sanitizedUrlPath,
        diagnostics: [...diagnostics],
        recoveryGuidance: [...recoveryGuidance],
        semanticSummary: null,
        semanticSource: null,
        semanticRequestId: null,
        evidenceRefs: [],
        risk: "HIGH",
        reviewRequired: true,
      });
    }

    // 4. Structural Semantic Eligibility Gate (Section 7 & 15)
    const isStructural = hasStructuralDiagnostic(diagnostics);
    const hasContext =
      (suspectedDomMarkers !== undefined && suspectedDomMarkers.length > 0) ||
      (evidence !== undefined && evidence.length > 0);

    if (!isStructural || !hasContext) {
      return deepFreeze({
        status: "RECOVERY_GUIDANCE_AVAILABLE",
        reasonCode: "DETERMINISTIC_GUIDANCE_AVAILABLE",
        urlPath: sanitizedUrlPath,
        diagnostics: [...diagnostics],
        recoveryGuidance: [...recoveryGuidance],
        semanticSummary: null,
        semanticSource: null,
        semanticRequestId: null,
        evidenceRefs: [],
        risk: "HIGH",
        reviewRequired: true,
      });
    }

    // 5. Build Canonical Semantic Payload Components (Section 24)
    // diagnosticLabels: sorted unique diagnostic codes
    const diagnosticCodes = Array.from(new Set(diagnostics.map((d) => d.code)));
    diagnosticCodes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // failureSignals: sorted unique failureCode + observations
    const signalSet = new Set<string>();
    if (failureCode !== undefined) {
      signalSet.add(failureCode);
    }
    if (observations !== undefined) {
      for (const obs of observations) {
        signalSet.add(obs);
      }
    }
    const failureSignals = Array.from(signalSet);
    failureSignals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // suspectedDomMarkers: sorted canonical copy
    let canonicalMarkers: string[] | undefined;
    if (suspectedDomMarkers !== undefined && suspectedDomMarkers.length > 0) {
      canonicalMarkers = [...suspectedDomMarkers];
      canonicalMarkers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    // evidence: defensive copy of items
    let canonicalEvidence: SemanticEvidenceItem[] | undefined;
    if (evidence !== undefined && evidence.length > 0) {
      canonicalEvidence = evidence.map((e) => ({ id: e.id, text: e.text }));
    }

    // 6. Active Phase 5A Config Gate & Zero-Truncation Safety (Section 10 & 23)
    const activeConfig = this.semanticService.getConfig();

    const evidenceExceeds = canonicalEvidence !== undefined && canonicalEvidence.length > activeConfig.maxEvidenceItems;
    const listItemsExceeds =
      diagnosticCodes.length > activeConfig.maxListItems ||
      failureSignals.length > activeConfig.maxListItems ||
      (canonicalMarkers !== undefined && canonicalMarkers.length > activeConfig.maxListItems);

    let totalSemanticTextChars = sanitizedUrlPath.length;
    for (const label of diagnosticCodes) totalSemanticTextChars += label.length;
    for (const sig of failureSignals) totalSemanticTextChars += sig.length;
    if (canonicalMarkers !== undefined) {
      for (const marker of canonicalMarkers) totalSemanticTextChars += marker.length;
    }
    if (canonicalEvidence !== undefined) {
      for (const item of canonicalEvidence) totalSemanticTextChars += item.id.length + item.text.length;
    }

    const textCharsExceeds = totalSemanticTextChars > activeConfig.maxTextChars;

    if (evidenceExceeds || listItemsExceeds || textCharsExceeds) {
      // Safe bypass: payload would exceed active Phase 5A bounds, zero silent truncation
      return deepFreeze({
        status: "RECOVERY_GUIDANCE_AVAILABLE",
        reasonCode: "DETERMINISTIC_GUIDANCE_AVAILABLE",
        urlPath: sanitizedUrlPath,
        diagnostics: [...diagnostics],
        recoveryGuidance: [...recoveryGuidance],
        semanticSummary: null,
        semanticSource: null,
        semanticRequestId: null,
        evidenceRefs: [],
        risk: "HIGH",
        reviewRequired: true,
      });
    }

    // 7. Invoke Semantic Intelligence Service (Section 25: At most once)
    const semanticTaskInput: ParserRecoverySemanticInput = {
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      urlPath: sanitizedUrlPath,
      diagnosticLabels: diagnosticCodes,
      failureSignals,
      suspectedDomMarkers: canonicalMarkers,
      evidence: canonicalEvidence,
    };

    let semanticResult: SemanticIntelligenceResult;
    try {
      semanticResult = await this.semanticService.executeTask(semanticTaskInput);
    } catch {
      // Direct unexpected exception fails closed
      return deepFreeze({
        status: "BLOCKED_FOR_REVIEW",
        reasonCode: "SEMANTIC_PROVIDER_UNAVAILABLE",
        urlPath: sanitizedUrlPath,
        diagnostics: [...diagnostics],
        recoveryGuidance: [...recoveryGuidance],
        semanticSummary: null,
        semanticSource: null,
        semanticRequestId: null,
        evidenceRefs: [],
        risk: "HIGH",
        reviewRequired: true,
      });
    }

    // 8. Translate Phase 5A Outcome (Section 11 & 26: Exact Reachable Translation)
    let finalStatus: ParserRecoveryStatus;
    let finalReason: ParserRecoveryReasonCode;
    let finalSemanticSource: "DETERMINISTIC" | "AI" | null = null;
    let finalSemanticSummary: string | null = null;
    let finalSemanticRequestId: string | null = null;
    let finalEvidenceRefs: readonly string[] = [];

    switch (semanticResult.outcome) {
      case "RESOLVED_DETERMINISTICALLY":
        finalStatus = "RECOVERY_GUIDANCE_AVAILABLE";
        finalReason = "SEMANTIC_DETERMINISTIC_GUIDANCE";
        finalSemanticSource = "DETERMINISTIC";
        finalSemanticSummary = semanticResult.explanationSummary;
        finalSemanticRequestId = semanticResult.requestId;
        finalEvidenceRefs = semanticResult.evidenceRefs ? [...semanticResult.evidenceRefs] : [];
        break;

      case "SUGGESTED":
        finalStatus = "RECOVERY_GUIDANCE_AVAILABLE";
        finalReason = "AI_RECOVERY_SUGGESTION";
        finalSemanticSource = "AI";
        finalSemanticSummary = semanticResult.explanationSummary;
        finalSemanticRequestId = semanticResult.requestId;
        finalEvidenceRefs = semanticResult.evidenceRefs ? [...semanticResult.evidenceRefs] : [];
        break;

      case "INPUT_REJECTED":
        finalStatus = "BLOCKED_FOR_REVIEW";
        finalReason = "SEMANTIC_INPUT_REJECTED";
        break;

      case "PROVIDER_UNAVAILABLE":
        finalStatus = "BLOCKED_FOR_REVIEW";
        finalReason = "SEMANTIC_PROVIDER_UNAVAILABLE";
        break;

      case "INVALID_PROVIDER_OUTPUT":
        finalStatus = "BLOCKED_FOR_REVIEW";
        finalReason = "SEMANTIC_INVALID_PROVIDER_OUTPUT";
        break;

      case "DETERMINISTIC_RESOLVER_FAILURE":
        finalStatus = "BLOCKED_FOR_REVIEW";
        finalReason = "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE";
        break;

      default:
        // Any unexpected or uncertified outcome (such as NEEDS_REVIEW) fails closed
        finalStatus = "BLOCKED_FOR_REVIEW";
        finalReason = "SEMANTIC_INVALID_PROVIDER_OUTPUT";
        break;
    }

    return deepFreeze({
      status: finalStatus,
      reasonCode: finalReason,
      urlPath: sanitizedUrlPath,
      diagnostics: [...diagnostics],
      recoveryGuidance: [...recoveryGuidance],
      semanticSummary: finalSemanticSummary,
      semanticSource: finalSemanticSource,
      semanticRequestId: finalSemanticRequestId,
      evidenceRefs: finalEvidenceRefs,
      risk: "HIGH",
      reviewRequired: true,
    });
  }

  /**
   * Internal fail-closed input validator.
   */
  private validateRawInput(raw: unknown): ValidatedInputSnapshot {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ParserRecoveryInputValidationError("Input must be a non-null plain object.");
    }

    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) {
      throw new ParserRecoveryInputValidationError("Input must be a plain object with Object.prototype or null prototype.");
    }

    if (Object.getOwnPropertySymbols(raw).length > 0) {
      throw new ParserRecoveryInputValidationError("Symbol keys are not allowed on input.");
    }

    const keys = Object.keys(raw);
    for (const key of keys) {
      if (!ALLOWED_INPUT_KEYS.has(key)) {
        throw new ParserRecoveryInputValidationError(`Unknown input property '${key}'.`);
      }
    }

    const obj = raw as Record<string, unknown>;

    // 1. sourceUrlOrPath validation
    if (typeof obj.sourceUrlOrPath !== "string") {
      throw new ParserRecoveryInputValidationError("Property 'sourceUrlOrPath' must be a string.");
    }
    const urlValidation = sanitizeSourceUrlOrPath(obj.sourceUrlOrPath);
    if (!urlValidation.valid || urlValidation.urlPath === null) {
      throw new ParserRecoveryInputValidationError(`Invalid sourceUrlOrPath: ${urlValidation.error}`);
    }
    const sanitizedUrlPath = urlValidation.urlPath;

    // 2. failureCode validation
    let failureCode: ParserRecoveryFailureCode | undefined;
    if (obj.failureCode !== undefined) {
      if (typeof obj.failureCode !== "string" || !VALID_FAILURE_CODES.has(obj.failureCode as ParserRecoveryFailureCode)) {
        throw new ParserRecoveryInputValidationError(`Invalid failureCode: '${String(obj.failureCode)}'.`);
      }
      failureCode = obj.failureCode as ParserRecoveryFailureCode;
    }

    // 3. failureMessage validation
    let failureMessage: string | undefined;
    if (obj.failureMessage !== undefined) {
      if (typeof obj.failureMessage !== "string") {
        throw new ParserRecoveryInputValidationError("Property 'failureMessage' must be a string.");
      }
      if (obj.failureMessage.length > PARSER_RECOVERY_BOUNDS.MAX_FAILURE_MESSAGE_LENGTH) {
        throw new ParserRecoveryInputValidationError(
          `failureMessage length (${obj.failureMessage.length}) exceeds maximum limit (${PARSER_RECOVERY_BOUNDS.MAX_FAILURE_MESSAGE_LENGTH}).`
        );
      }
      failureMessage = obj.failureMessage;
    }

    // 4. observations validation
    let observations: ParserRecoveryObservation[] | undefined;
    if (obj.observations !== undefined) {
      if (!Array.isArray(obj.observations)) {
        throw new ParserRecoveryInputValidationError("Property 'observations' must be an array.");
      }
      // Check for sparse holes
      for (let i = 0; i < obj.observations.length; i++) {
        if (!(i in obj.observations)) {
          throw new ParserRecoveryInputValidationError("Sparse arrays are not allowed for observations.");
        }
      }
      if (obj.observations.length > PARSER_RECOVERY_BOUNDS.MAX_OBSERVATIONS_COUNT) {
        throw new ParserRecoveryInputValidationError(
          `observations count (${obj.observations.length}) exceeds maximum limit (${PARSER_RECOVERY_BOUNDS.MAX_OBSERVATIONS_COUNT}).`
        );
      }
      const obsSeen = new Set<string>();
      observations = [];
      for (const item of obj.observations) {
        if (typeof item !== "string" || !VALID_OBSERVATIONS.has(item as ParserRecoveryObservation)) {
          throw new ParserRecoveryInputValidationError(`Invalid observation literal: '${String(item)}'.`);
        }
        if (obsSeen.has(item)) {
          throw new ParserRecoveryInputValidationError(`Duplicate observation literal: '${item}'.`);
        }
        obsSeen.add(item);
        observations.push(item as ParserRecoveryObservation);
      }
    }

    // Mandatory Failure Requirement (Section 2 & 7)
    if (failureCode === undefined && (observations === undefined || observations.length === 0)) {
      throw new ParserRecoveryInputValidationError(
        "ParserRecoveryInput requires at least one of failureCode or non-empty observations."
      );
    }

    // 5. suspectedDomMarkers validation
    let suspectedDomMarkers: string[] | undefined;
    if (obj.suspectedDomMarkers !== undefined) {
      if (!Array.isArray(obj.suspectedDomMarkers)) {
        throw new ParserRecoveryInputValidationError("Property 'suspectedDomMarkers' must be an array.");
      }
      for (let i = 0; i < obj.suspectedDomMarkers.length; i++) {
        if (!(i in obj.suspectedDomMarkers)) {
          throw new ParserRecoveryInputValidationError("Sparse arrays are not allowed for suspectedDomMarkers.");
        }
      }
      if (obj.suspectedDomMarkers.length > PARSER_RECOVERY_BOUNDS.MAX_DOM_MARKER_COUNT) {
        throw new ParserRecoveryInputValidationError(
          `suspectedDomMarkers count (${obj.suspectedDomMarkers.length}) exceeds maximum limit (${PARSER_RECOVERY_BOUNDS.MAX_DOM_MARKER_COUNT}).`
        );
      }
      const markerSeen = new Set<string>();
      suspectedDomMarkers = [];
      for (const marker of obj.suspectedDomMarkers) {
        if (typeof marker !== "string") {
          throw new ParserRecoveryInputValidationError("Elements of suspectedDomMarkers must be strings.");
        }
        const trimmedMarker = marker.trim();
        if (trimmedMarker.length === 0) {
          throw new ParserRecoveryInputValidationError("Elements of suspectedDomMarkers cannot be empty or whitespace-only.");
        }
        if (marker.length > PARSER_RECOVERY_BOUNDS.MAX_DOM_MARKER_LENGTH) {
          throw new ParserRecoveryInputValidationError(
            `DOM marker length (${marker.length}) exceeds maximum limit (${PARSER_RECOVERY_BOUNDS.MAX_DOM_MARKER_LENGTH}).`
          );
        }
        if (markerSeen.has(marker)) {
          throw new ParserRecoveryInputValidationError(`Duplicate DOM marker '${marker}'.`);
        }
        markerSeen.add(marker);
        suspectedDomMarkers.push(marker);
      }
    }

    // 6. evidence validation
    let evidence: SemanticEvidenceItem[] | undefined;
    if (obj.evidence !== undefined) {
      if (!Array.isArray(obj.evidence)) {
        throw new ParserRecoveryInputValidationError("Property 'evidence' must be an array.");
      }
      for (let i = 0; i < obj.evidence.length; i++) {
        if (!(i in obj.evidence)) {
          throw new ParserRecoveryInputValidationError("Sparse arrays are not allowed for evidence.");
        }
      }
      if (obj.evidence.length > PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_COUNT) {
        throw new ParserRecoveryInputValidationError(
          `evidence count (${obj.evidence.length}) exceeds maximum limit (${PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_COUNT}).`
        );
      }
      const evidenceSeen = new Set<string>();
      evidence = [];
      for (const item of obj.evidence) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new ParserRecoveryInputValidationError("Evidence items must be non-null plain objects.");
        }
        const itemProto = Object.getPrototypeOf(item);
        if (itemProto !== Object.prototype && itemProto !== null) {
          throw new ParserRecoveryInputValidationError("Evidence items must have Object.prototype or null prototype.");
        }
        if (Object.getOwnPropertySymbols(item).length > 0) {
          throw new ParserRecoveryInputValidationError("Symbol keys are not allowed on evidence items.");
        }
        const itemKeys = Object.keys(item);
        if (itemKeys.length !== 2 || !itemKeys.includes("id") || !itemKeys.includes("text")) {
          throw new ParserRecoveryInputValidationError("Evidence item must contain exactly 'id' and 'text' properties.");
        }
        const e = item as Record<string, unknown>;
        if (typeof e.id !== "string" || e.id.trim().length === 0) {
          throw new ParserRecoveryInputValidationError("Evidence 'id' must be a non-empty, non-blank string.");
        }
        if (e.id.length > PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_ITEM_LENGTH) {
          throw new ParserRecoveryInputValidationError(`Evidence 'id' length exceeds limit of ${PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_ITEM_LENGTH}.`);
        }
        if (typeof e.text !== "string" || e.text.trim().length === 0) {
          throw new ParserRecoveryInputValidationError("Evidence 'text' must be a non-empty, non-blank string.");
        }
        if (e.text.length > PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_ITEM_LENGTH) {
          throw new ParserRecoveryInputValidationError(`Evidence 'text' length exceeds limit of ${PARSER_RECOVERY_BOUNDS.MAX_EVIDENCE_ITEM_LENGTH}.`);
        }
        if (evidenceSeen.has(e.id)) {
          throw new ParserRecoveryInputValidationError(`Duplicate evidence ID '${e.id}'.`);
        }
        evidenceSeen.add(e.id);
        evidence.push({ id: e.id, text: e.text });
      }
    }

    return deepFreeze({
      sanitizedUrlPath,
      failureCode,
      failureMessage,
      observations,
      suspectedDomMarkers,
      evidence,
    });
  }
}
