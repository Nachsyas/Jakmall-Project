/**
 * Phase 5A: Semantic Intelligence Configuration & Bounds
 */

import { SemanticConfigurationError } from "./types.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 5000;
export const MIN_PROVIDER_TIMEOUT_MS = 100;
export const MAX_PROVIDER_TIMEOUT_MS = 60000;

export const DEFAULT_MAX_TEXT_CHARS = 12000;
export const MIN_MAX_TEXT_CHARS = 100;
export const MAX_MAX_TEXT_CHARS = 50000;

export const DEFAULT_MAX_CANDIDATES = 100;
export const MIN_MAX_CANDIDATES = 1;
export const MAX_MAX_CANDIDATES = 200;

export const DEFAULT_MAX_SPECIFICATIONS = 50;
export const MIN_MAX_SPECIFICATIONS = 1;
export const MAX_MAX_SPECIFICATIONS = 100;

export const DEFAULT_MAX_EVIDENCE_ITEMS = 20;
export const MIN_MAX_EVIDENCE_ITEMS = 1;
export const MAX_MAX_EVIDENCE_ITEMS = 50;

export const DEFAULT_MAX_EVIDENCE_REFS = 20;
export const MIN_MAX_EVIDENCE_REFS = 1;
export const MAX_MAX_EVIDENCE_REFS = 50;

export const DEFAULT_MAX_EXPLANATION_CHARS = 1000;
export const MIN_MAX_EXPLANATION_CHARS = 10;
export const MAX_MAX_EXPLANATION_CHARS = 5000;

export const DEFAULT_MAX_LIST_ITEMS = 100;
export const MIN_MAX_LIST_ITEMS = 1;
export const MAX_MAX_LIST_ITEMS = 200;

export interface SemanticIntelligenceConfig {
  readonly providerTimeoutMs: number;
  readonly maxTextChars: number;
  readonly maxCandidates: number;
  readonly maxSpecifications: number;
  readonly maxEvidenceItems: number;
  readonly maxEvidenceRefs: number;
  readonly maxExplanationChars: number;
  readonly maxListItems: number;
}

function parseStrictInteger(
  name: string,
  raw: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (raw === undefined) {
    return defaultValue;
  }

  let value: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || !Number.isFinite(raw) || Number.isNaN(raw)) {
      throw new SemanticConfigurationError(
        `Configuration property '${name}' must be a finite integer. Received: ${raw}.`
      );
    }
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new SemanticConfigurationError(
        `Configuration property '${name}' cannot be empty or whitespace-only.`
      );
    }
    if (!/^-?\d+$/.test(trimmed)) {
      throw new SemanticConfigurationError(
        `Configuration property '${name}' must be an integer string. Received: '${trimmed}'.`
      );
    }
    value = parseInt(trimmed, 10);
    if (!Number.isSafeInteger(value)) {
      throw new SemanticConfigurationError(
        `Configuration property '${name}' exceeds safe integer limits. Received: '${trimmed}'.`
      );
    }
  } else {
    throw new SemanticConfigurationError(
      `Configuration property '${name}' must be a number or numeric string.`
    );
  }

  if (value < min) {
    throw new SemanticConfigurationError(
      `Configuration property '${name}' cannot be less than ${min}. Received: ${value}.`
    );
  }

  if (value > max) {
    throw new SemanticConfigurationError(
      `Configuration property '${name}' cannot exceed ${max}. Received: ${value}.`
    );
  }

  return value;
}

export function validateSemanticConfig(raw: unknown): SemanticIntelligenceConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SemanticConfigurationError("SemanticIntelligenceConfig must be a non-null object.");
  }

  const obj = raw as Record<string, unknown>;

  // Reject unknown configuration properties
  const allowedKeys = new Set([
    "providerTimeoutMs",
    "maxTextChars",
    "maxCandidates",
    "maxSpecifications",
    "maxEvidenceItems",
    "maxEvidenceRefs",
    "maxExplanationChars",
    "maxListItems",
  ]);

  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new SemanticConfigurationError(`Unknown configuration property '${key}'.`);
    }
  }

  const providerTimeoutMs = parseStrictInteger(
    "providerTimeoutMs",
    obj.providerTimeoutMs,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    MIN_PROVIDER_TIMEOUT_MS,
    MAX_PROVIDER_TIMEOUT_MS
  );

  const maxTextChars = parseStrictInteger(
    "maxTextChars",
    obj.maxTextChars,
    DEFAULT_MAX_TEXT_CHARS,
    MIN_MAX_TEXT_CHARS,
    MAX_MAX_TEXT_CHARS
  );

  const maxCandidates = parseStrictInteger(
    "maxCandidates",
    obj.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MIN_MAX_CANDIDATES,
    MAX_MAX_CANDIDATES
  );

  const maxSpecifications = parseStrictInteger(
    "maxSpecifications",
    obj.maxSpecifications,
    DEFAULT_MAX_SPECIFICATIONS,
    MIN_MAX_SPECIFICATIONS,
    MAX_MAX_SPECIFICATIONS
  );

  const maxEvidenceItems = parseStrictInteger(
    "maxEvidenceItems",
    obj.maxEvidenceItems,
    DEFAULT_MAX_EVIDENCE_ITEMS,
    MIN_MAX_EVIDENCE_ITEMS,
    MAX_MAX_EVIDENCE_ITEMS
  );

  const maxEvidenceRefs = parseStrictInteger(
    "maxEvidenceRefs",
    obj.maxEvidenceRefs,
    DEFAULT_MAX_EVIDENCE_REFS,
    MIN_MAX_EVIDENCE_REFS,
    MAX_MAX_EVIDENCE_REFS
  );

  const maxExplanationChars = parseStrictInteger(
    "maxExplanationChars",
    obj.maxExplanationChars,
    DEFAULT_MAX_EXPLANATION_CHARS,
    MIN_MAX_EXPLANATION_CHARS,
    MAX_MAX_EXPLANATION_CHARS
  );

  const maxListItems = parseStrictInteger(
    "maxListItems",
    obj.maxListItems,
    DEFAULT_MAX_LIST_ITEMS,
    MIN_MAX_LIST_ITEMS,
    MAX_MAX_LIST_ITEMS
  );

  return Object.freeze({
    providerTimeoutMs,
    maxTextChars,
    maxCandidates,
    maxSpecifications,
    maxEvidenceItems,
    maxEvidenceRefs,
    maxExplanationChars,
    maxListItems,
  });
}

export function resolveSemanticConfig(partial?: unknown): SemanticIntelligenceConfig {
  if (partial === undefined) {
    return Object.freeze({
      providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      maxTextChars: DEFAULT_MAX_TEXT_CHARS,
      maxCandidates: DEFAULT_MAX_CANDIDATES,
      maxSpecifications: DEFAULT_MAX_SPECIFICATIONS,
      maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
      maxEvidenceRefs: DEFAULT_MAX_EVIDENCE_REFS,
      maxExplanationChars: DEFAULT_MAX_EXPLANATION_CHARS,
      maxListItems: DEFAULT_MAX_LIST_ITEMS,
    });
  }

  return validateSemanticConfig(partial);
}
