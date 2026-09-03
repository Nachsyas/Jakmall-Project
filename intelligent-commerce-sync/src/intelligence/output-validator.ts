/**
 * Phase 5A: Strict Semantic Output Validator & Candidate/Evidence Allowlisting
 */

import type { SemanticIntelligenceConfig } from "./config.js";
import {
  SemanticOutputValidationError,
  type SemanticProviderOutput,
  type SemanticProviderResponse,
  type SemanticTaskKind,
  type DeterministicResolutionResult,
} from "./types.js";

/**
 * Strictly validates the provider response envelope at runtime before accessing rawText.
 * Enforces plain-object structure, non-null, non-array, zero symbol keys,
 * exactly one allowed property 'rawText', and primitive string type.
 * Returns a new trusted object: { rawText: obj.rawText }.
 */
export function validateSemanticProviderResponse(raw: unknown): SemanticProviderResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SemanticOutputValidationError(
      "Provider response must be a non-null, non-array object envelope."
    );
  }

  // Plain object check: prototype must be Object.prototype or null
  const proto = Object.getPrototypeOf(raw);
  if (proto !== null && proto !== Object.prototype) {
    throw new SemanticOutputValidationError(
      "Provider response envelope must be a plain object."
    );
  }

  // Reject symbol-keyed properties
  if (Object.getOwnPropertySymbols(raw).length > 0) {
    throw new SemanticOutputValidationError(
      "Provider response envelope must not contain symbol-keyed properties."
    );
  }

  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "rawText") {
    const unknownKeys = keys.filter((k) => k !== "rawText");
    if (unknownKeys.length > 0) {
      throw new SemanticOutputValidationError(
        `Unknown property '${unknownKeys[0]}' in provider response envelope.`
      );
    }
    throw new SemanticOutputValidationError(
      "Provider response envelope must contain exactly the 'rawText' property."
    );
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.rawText !== "string") {
    throw new SemanticOutputValidationError(
      "Provider response envelope 'rawText' must be a primitive string."
    );
  }

  return {
    rawText: record.rawText,
  };
}

/**
 * Validates raw provider response text against strict schema, candidate allowlist,
 * evidence allowlist, confidence bounds, and task-specific rules.
 * All allowlists are concrete and non-optional.
 */
export function validateSemanticOutput(
  raw: unknown,
  expectedTaskKind: SemanticTaskKind,
  config: SemanticIntelligenceConfig,
  allowedCandidateIds: readonly string[],
  allowedEvidenceIds: readonly string[]
): SemanticProviderOutput {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SemanticOutputValidationError("Provider output is not valid JSON.");
    }
  } else {
    parsed = raw;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SemanticOutputValidationError("Provider output must be a non-null JSON object.");
  }

  const obj = parsed as Record<string, unknown>;

  // Strict schema: only exact allowed top-level keys
  const allowedKeys = new Set([
    "schemaVersion",
    "taskKind",
    "selectedCandidateId",
    "confidence",
    "explanationSummary",
    "evidenceRefs",
  ]);

  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new SemanticOutputValidationError(`Unknown property '${key}' in provider output.`);
    }
  }

  // 1. schemaVersion
  if (obj.schemaVersion !== 1) {
    throw new SemanticOutputValidationError(
      `Invalid schemaVersion: expected 1, received: ${String(obj.schemaVersion)}.`
    );
  }

  // 2. taskKind
  if (obj.taskKind !== expectedTaskKind) {
    throw new SemanticOutputValidationError(
      `taskKind mismatch: expected '${expectedTaskKind}', received: '${String(obj.taskKind)}'.`
    );
  }

  // 3. confidence
  const conf = obj.confidence;
  if (typeof conf !== "number" || Number.isNaN(conf) || !Number.isFinite(conf)) {
    throw new SemanticOutputValidationError(`confidence must be a finite number. Received: ${String(conf)}.`);
  }
  if (conf < 0 || conf > 1) {
    throw new SemanticOutputValidationError(`confidence must be between 0.0 and 1.0. Received: ${conf}.`);
  }

  // 4. explanationSummary
  const expl = obj.explanationSummary;
  if (typeof expl !== "string" || expl.trim().length === 0) {
    throw new SemanticOutputValidationError("explanationSummary must be a non-blank string.");
  }
  if (expl.length > config.maxExplanationChars) {
    throw new SemanticOutputValidationError(
      `explanationSummary length (${expl.length}) exceeds maximum limit (${config.maxExplanationChars}).`
    );
  }

  // 5. evidenceRefs
  const refs = obj.evidenceRefs;
  if (!Array.isArray(refs)) {
    throw new SemanticOutputValidationError("evidenceRefs must be an array.");
  }
  if (refs.length > config.maxEvidenceRefs) {
    throw new SemanticOutputValidationError(
      `evidenceRefs count (${refs.length}) exceeds maximum limit (${config.maxEvidenceRefs}).`
    );
  }

  const refSet = new Set<string>();
  const allowedEvidenceSet = new Set(allowedEvidenceIds);

  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (typeof r !== "string" || r.trim().length === 0) {
      throw new SemanticOutputValidationError(`evidenceRefs item at index ${i} must be a non-blank string.`);
    }
    if (refSet.has(r)) {
      throw new SemanticOutputValidationError(`Duplicate evidenceRef detected: '${r}'.`);
    }
    refSet.add(r);

    if (!allowedEvidenceSet.has(r)) {
      throw new SemanticOutputValidationError(
        `Fabricated or unprovided evidenceRef '${r}' rejected by evidence allowlist.`
      );
    }
  }

  // 6. selectedCandidateId & Task-Specific Candidate Rules
  const sel = obj.selectedCandidateId;
  if (expectedTaskKind === "CATEGORY_MAPPING" || expectedTaskKind === "ATTRIBUTE_MAPPING") {
    if (sel !== null && typeof sel !== "string") {
      throw new SemanticOutputValidationError(
        `selectedCandidateId must be a string or null for ${expectedTaskKind}.`
      );
    }

    if (typeof sel === "string") {
      if (sel.trim().length === 0) {
        throw new SemanticOutputValidationError("selectedCandidateId cannot be an empty or whitespace string.");
      }
      const allowedCandSet = new Set(allowedCandidateIds);
      if (!allowedCandSet.has(sel)) {
        throw new SemanticOutputValidationError(
          `Fabricated or unprovided candidate ID '${sel}' rejected by candidate allowlist.`
        );
      }
    }
  } else {
    // ANOMALY_REVIEW and PARSER_RECOVERY_SUGGESTION
    if (sel !== null) {
      throw new SemanticOutputValidationError(
        `selectedCandidateId MUST be null for ${expectedTaskKind}. Received: '${String(sel)}'.`
      );
    }
  }

  return {
    schemaVersion: 1,
    taskKind: expectedTaskKind,
    selectedCandidateId: sel,
    confidence: conf,
    explanationSummary: expl,
    evidenceRefs: refs,
  };
}

/**
 * Validates deterministic resolver output.
 * Every resolver response must pass strict runtime validation.
 * Enforces that deterministic resolution cannot bypass validation, candidate allowlisting, or bounds.
 */
export function validateDeterministicResolution(
  taskKind: SemanticTaskKind,
  rawResolution: unknown,
  config: SemanticIntelligenceConfig,
  allowedCandidateIds: readonly string[],
  allowedEvidenceIds: readonly string[]
): DeterministicResolutionResult {
  if (typeof rawResolution !== "object" || rawResolution === null || Array.isArray(rawResolution)) {
    throw new SemanticOutputValidationError("Deterministic resolution must be a non-null object.");
  }

  const obj = rawResolution as Record<string, unknown>;

  // Strict schema: only exact allowed top-level keys
  const allowedKeys = new Set(["resolved", "candidateId", "explanation", "evidenceRefs"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new SemanticOutputValidationError(`Unknown property '${key}' in deterministic resolution.`);
    }
  }

  if (typeof obj.resolved !== "boolean") {
    throw new SemanticOutputValidationError("Deterministic resolution 'resolved' field must be a boolean.");
  }

  // For unresolved results: strict minimal contract
  if (!obj.resolved) {
    if (obj.candidateId !== undefined || obj.explanation !== undefined || obj.evidenceRefs !== undefined) {
      throw new SemanticOutputValidationError(
        "Unresolved deterministic resolution must not provide candidateId, explanation, or evidenceRefs."
      );
    }
    return { resolved: false };
  }

  // Resolved results
  const candId = obj.candidateId;
  if (taskKind === "CATEGORY_MAPPING" || taskKind === "ATTRIBUTE_MAPPING") {
    if (candId === null || candId === undefined || typeof candId !== "string" || candId.trim().length === 0) {
      throw new SemanticOutputValidationError(
        `Deterministic resolution for ${taskKind} must provide a non-null, non-blank candidateId.`
      );
    }
    const allowedCandSet = new Set(allowedCandidateIds);
    if (!allowedCandSet.has(candId)) {
      throw new SemanticOutputValidationError(
        `Deterministic resolution candidate ID '${candId}' is not in the allowed candidates list.`
      );
    }
  } else {
    // ANOMALY_REVIEW and PARSER_RECOVERY_SUGGESTION
    if (candId !== null && candId !== undefined) {
      throw new SemanticOutputValidationError(
        `Deterministic resolution for ${taskKind} must not specify a candidateId.`
      );
    }
  }

  let explanation: string | undefined;
  if (obj.explanation !== undefined) {
    if (typeof obj.explanation !== "string" || obj.explanation.trim().length === 0) {
      throw new SemanticOutputValidationError("Deterministic resolution explanation must be a non-blank string.");
    }
    if (obj.explanation.length > config.maxExplanationChars) {
      throw new SemanticOutputValidationError(
        `Deterministic resolution explanation length (${obj.explanation.length}) exceeds maximum limit (${config.maxExplanationChars}).`
      );
    }
    explanation = obj.explanation;
  }

  let evidenceRefs: readonly string[] | undefined;
  if (obj.evidenceRefs !== undefined) {
    if (!Array.isArray(obj.evidenceRefs)) {
      throw new SemanticOutputValidationError("Deterministic resolution evidenceRefs must be an array.");
    }
    if (obj.evidenceRefs.length > config.maxEvidenceRefs) {
      throw new SemanticOutputValidationError(
        `Deterministic resolution evidenceRefs count (${obj.evidenceRefs.length}) exceeds maximum limit (${config.maxEvidenceRefs}).`
      );
    }
    const refSet = new Set<string>();
    const allowedEvidenceSet = new Set(allowedEvidenceIds);
    const validRefs: string[] = [];
    for (let i = 0; i < obj.evidenceRefs.length; i++) {
      const r = obj.evidenceRefs[i];
      if (typeof r !== "string" || r.trim().length === 0) {
        throw new SemanticOutputValidationError(
          `Deterministic resolution evidenceRef at index ${i} must be a non-blank string.`
        );
      }
      if (refSet.has(r)) {
        throw new SemanticOutputValidationError(
          `Duplicate evidenceRef in deterministic resolution: '${r}'.`
        );
      }
      refSet.add(r);
      if (!allowedEvidenceSet.has(r)) {
        throw new SemanticOutputValidationError(
          `Deterministic resolution evidenceRef '${r}' rejected by evidence allowlist.`
        );
      }
      validRefs.push(r);
    }
    evidenceRefs = validRefs;
  }

  return {
    resolved: true,
    candidateId: candId as string | null | undefined,
    explanation,
    evidenceRefs,
  };
}
