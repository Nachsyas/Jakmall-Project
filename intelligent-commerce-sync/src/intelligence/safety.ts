/**
 * Phase 5A: Semantic Intelligence Safety, Sanitization & Deterministic Serialization
 */

import { createHash } from "node:crypto";
import { sanitizeErrorMessage } from "../queue/error-sanitizer.js";
import type { SemanticIntelligenceConfig } from "./config.js";
import {
  SemanticInputValidationError,
  type SemanticTaskInput,
  type SemanticCandidate,
  type SemanticEvidenceItem,
  type SemanticSpecificationItem,
  type SemanticTaskKind,
  type RiskLevel,
  type SemanticSource,
} from "./types.js";

export { sanitizeErrorMessage };

/**
 * Locale-independent code-unit comparator for stable sorting.
 * Zero locale-dependent string collation.
 */
function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively freezes an object and its nested properties.
 * Guarantees runtime immutability across the service boundary.
 */
export function deepFreeze<T>(val: T, seen = new Set<unknown>()): T {
  if (val === null || typeof val !== "object") {
    return val;
  }

  if (seen.has(val)) {
    return val;
  }
  seen.add(val);

  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (i in val) {
        deepFreeze(val[i], seen);
      }
    }
  } else {
    for (const key of Object.keys(val)) {
      deepFreeze((val as Record<string, unknown>)[key], seen);
    }
  }

  return Object.freeze(val);
}

/**
 * Fail-closed deterministic JSON serializer.
 * Rejects unsupported types (NaN, Infinity, bigint, Date, Map, Set, functions, symbols, class instances, circular references).
 * Rejects sparse arrays (arrays with holes).
 * Recursively sorts plain object keys.
 */
export function deterministicStringify(val: unknown, seen = new Set<unknown>()): string {
  if (val === null) {
    return "null";
  }

  const t = typeof val;
  if (t === "boolean") {
    return val ? "true" : "false";
  }

  if (t === "number") {
    const num = val as number;
    if (!Number.isFinite(num) || Number.isNaN(num)) {
      throw new SemanticInputValidationError(`Deterministic serializer cannot serialize non-finite number: ${num}.`);
    }
    return String(num);
  }

  if (t === "string") {
    return JSON.stringify(val);
  }

  if (t === "bigint" || t === "function" || t === "symbol" || t === "undefined") {
    throw new SemanticInputValidationError(`Deterministic serializer cannot serialize unsupported type: ${t}.`);
  }

  if (typeof val === "object") {
    if (seen.has(val)) {
      throw new SemanticInputValidationError("Deterministic serializer detected circular reference.");
    }
    seen.add(val);

    try {
      if (Array.isArray(val)) {
        // Reject sparse arrays / holes
        for (let i = 0; i < val.length; i++) {
          if (!(i in val)) {
            throw new SemanticInputValidationError(`Deterministic serializer rejects sparse array with hole at index ${i}.`);
          }
        }
        const items = val.map((item) => deterministicStringify(item, seen));
        return `[${items.join(",")}]`;
      }

      // Check if it's a plain object
      const proto = Object.getPrototypeOf(val);
      if (proto !== Object.prototype && proto !== null) {
        throw new SemanticInputValidationError(
          `Deterministic serializer rejects non-plain object or class instance: ${proto?.constructor?.name ?? "unknown"}.`
        );
      }

      // Check for symbol properties
      if (Object.getOwnPropertySymbols(val).length > 0) {
        throw new SemanticInputValidationError("Deterministic serializer rejects symbol-keyed objects.");
      }

      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).sort(codeUnitCompare);
      const entries = keys.map((key) => {
        const serializedKey = JSON.stringify(key);
        const serializedVal = deterministicStringify(obj[key], seen);
        return `${serializedKey}:${serializedVal}`;
      });

      return `{${entries.join(",")}}`;
    } finally {
      seen.delete(val);
    }
  }

  throw new SemanticInputValidationError(`Deterministic serializer encountered unhandled value.`);
}

/**
 * Canonicalizes semantic collections (candidates and evidence items) by ID
 * using locale-independent code-unit sorting.
 * Preserves sourceSpecifications order (not treated as set-like).
 */
export function canonicalizeSemanticPayload(input: SemanticTaskInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskKind: input.taskKind,
  };

  if ("productTitle" in input && input.productTitle !== undefined) {
    base.productTitle = input.productTitle;
  }
  if ("productDescription" in input && input.productDescription !== undefined) {
    base.productDescription = input.productDescription;
  }
  if ("brand" in input && input.brand !== undefined) base.brand = input.brand;
  if ("sourceCategoryPath" in input && input.sourceCategoryPath !== undefined) {
    base.sourceCategoryPath = input.sourceCategoryPath;
  }
  if ("selectedCategoryPath" in input) base.selectedCategoryPath = input.selectedCategoryPath;
  if ("sourceSpecificationKey" in input) base.sourceSpecificationKey = input.sourceSpecificationKey;
  if ("sourceSpecificationValue" in input) base.sourceSpecificationValue = input.sourceSpecificationValue;
  if ("urlPath" in input) base.urlPath = input.urlPath;

  // Preserve meaningful caller array order for text lists
  if ("categoryHints" in input && input.categoryHints !== undefined) base.categoryHints = input.categoryHints;
  if ("variantLabels" in input && input.variantLabels !== undefined) base.variantLabels = input.variantLabels;
  if ("suspectedAnomalyReasons" in input && input.suspectedAnomalyReasons !== undefined) {
    base.suspectedAnomalyReasons = input.suspectedAnomalyReasons;
  }
  if ("diagnosticLabels" in input) base.diagnosticLabels = input.diagnosticLabels;
  if ("failureSignals" in input) base.failureSignals = input.failureSignals;
  if ("suspectedDomMarkers" in input && input.suspectedDomMarkers !== undefined) {
    base.suspectedDomMarkers = input.suspectedDomMarkers;
  }

  // Preserve caller/source ordering for specifications (not set-like)
  if ("sourceSpecifications" in input && input.sourceSpecifications !== undefined) {
    base.sourceSpecifications = input.sourceSpecifications.map((s) => ({ key: s.key, value: s.value }));
  }

  // Candidates canonicalization by ID code-unit order
  if ("candidates" in input) {
    const sortedCandidates = [...input.candidates].sort((a, b) => codeUnitCompare(a.id, b.id));
    base.candidates = sortedCandidates.map((c) => {
      const cand: Record<string, unknown> = { id: c.id, name: c.name };
      if (c.description !== undefined) cand.description = c.description;
      if (c.parentId !== undefined) cand.parentId = c.parentId;
      if (c.path !== undefined) cand.path = c.path;
      return cand;
    });
  }

  // Evidence canonicalization by ID code-unit order.
  // Normalized so omitted evidence and evidence: [] produce identical canonical representation: base.evidence = [].
  if (input.evidence !== undefined && input.evidence.length > 0) {
    const sortedEvidence = [...input.evidence].sort((a, b) => codeUnitCompare(a.id, b.id));
    base.evidence = sortedEvidence.map((e) => ({ id: e.id, text: e.text }));
  } else {
    base.evidence = [];
  }

  return base;
}

/**
 * Returns canonicalized allowedCandidateIds sorted stably by ID.
 */
export function getCanonicalCandidateIds(input: SemanticTaskInput): readonly string[] {
  if ("candidates" in input && Array.isArray(input.candidates)) {
    return [...input.candidates].map((c) => c.id).sort(codeUnitCompare);
  }
  return [];
}

/**
 * Returns canonicalized allowedEvidenceIds sorted stably by ID.
 */
export function getCanonicalEvidenceIds(input: SemanticTaskInput): readonly string[] {
  if (input.evidence && Array.isArray(input.evidence) && input.evidence.length > 0) {
    return [...input.evidence].map((e) => e.id).sort(codeUnitCompare);
  }
  return [];
}

/**
 * Generates deterministic request identity using SHA-256 over canonicalized payload.
 * Zero Math.random, randomUUID, or Date.now.
 */
export function generateSemanticRequestId(taskKind: SemanticTaskKind, input: SemanticTaskInput): string {
  const canonical = canonicalizeSemanticPayload(input);
  const serialized = deterministicStringify(canonical);
  return createHash("sha256").update(`${taskKind}:${serialized}`).digest("hex");
}

/**
 * Validates task input against aggregate character limits, list bounds,
 * unknown fields, duplicate IDs, and blanks.
 * Returns an immutable, recursively frozen snapshot.
 */
export function validateSemanticTaskInput(
  raw: unknown,
  config: SemanticIntelligenceConfig
): SemanticTaskInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SemanticInputValidationError("SemanticTaskInput must be a non-null object.");
  }

  const obj = raw as Record<string, unknown>;
  const taskKind = obj.taskKind;

  if (
    taskKind !== "CATEGORY_MAPPING" &&
    taskKind !== "ATTRIBUTE_MAPPING" &&
    taskKind !== "ANOMALY_REVIEW" &&
    taskKind !== "PARSER_RECOVERY_SUGGESTION"
  ) {
    throw new SemanticInputValidationError(`Unknown or missing taskKind: '${String(taskKind)}'.`);
  }

  let totalChars = 0;
  function trackText(s: unknown, fieldName: string, allowBlank = false): string {
    if (typeof s !== "string") {
      throw new SemanticInputValidationError(`Field '${fieldName}' must be a string.`);
    }
    const trimmed = s.trim();
    if (!allowBlank && trimmed.length === 0) {
      throw new SemanticInputValidationError(`Field '${fieldName}' cannot be blank.`);
    }
    totalChars += s.length;
    return s;
  }

  function validateStringList(list: unknown, fieldName: string): string[] {
    if (!Array.isArray(list)) {
      throw new SemanticInputValidationError(`Field '${fieldName}' must be an array.`);
    }
    // Reject sparse arrays in input
    for (let i = 0; i < list.length; i++) {
      if (!(i in list)) {
        throw new SemanticInputValidationError(`Field '${fieldName}' contains a sparse array hole at index ${i}.`);
      }
    }
    if (list.length > config.maxListItems) {
      throw new SemanticInputValidationError(
        `Field '${fieldName}' length (${list.length}) exceeds maximum limit (${config.maxListItems}).`
      );
    }
    const result: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new SemanticInputValidationError(`Item in '${fieldName}' at index ${i} must be a non-blank string.`);
      }
      totalChars += item.length;
      result.push(item);
    }
    return result;
  }

  function validateCandidates(candidatesRaw: unknown): SemanticCandidate[] {
    if (!Array.isArray(candidatesRaw)) {
      throw new SemanticInputValidationError("Candidates must be an array.");
    }
    for (let i = 0; i < candidatesRaw.length; i++) {
      if (!(i in candidatesRaw)) {
        throw new SemanticInputValidationError(`Candidates array contains a sparse array hole at index ${i}.`);
      }
    }
    if (candidatesRaw.length === 0) {
      throw new SemanticInputValidationError("Candidates array cannot be empty for mapping tasks.");
    }
    if (candidatesRaw.length > config.maxCandidates) {
      throw new SemanticInputValidationError(
        `Candidates count (${candidatesRaw.length}) exceeds maximum limit (${config.maxCandidates}).`
      );
    }

    const candidateIds = new Set<string>();
    const validCandidates: SemanticCandidate[] = [];
    const allowedKeys = new Set(["id", "name", "description", "parentId", "path"]);

    for (let i = 0; i < candidatesRaw.length; i++) {
      const c = candidatesRaw[i];
      if (typeof c !== "object" || c === null || Array.isArray(c)) {
        throw new SemanticInputValidationError(`Candidate at index ${i} must be a non-null object.`);
      }

      for (const k of Object.keys(c as Record<string, unknown>)) {
        if (!allowedKeys.has(k)) {
          throw new SemanticInputValidationError(`Unknown property '${k}' in candidate at index ${i}.`);
        }
      }

      const id = (c as Record<string, unknown>).id;
      const name = (c as Record<string, unknown>).name;
      const desc = (c as Record<string, unknown>).description;
      const parentId = (c as Record<string, unknown>).parentId;
      const path = (c as Record<string, unknown>).path;

      if (typeof id !== "string" || id.trim().length === 0) {
        throw new SemanticInputValidationError(`Candidate at index ${i} has invalid or blank id.`);
      }
      if (candidateIds.has(id)) {
        throw new SemanticInputValidationError(`Duplicate candidate id detected: '${id}'.`);
      }
      candidateIds.add(id);

      if (typeof name !== "string" || name.trim().length === 0) {
        throw new SemanticInputValidationError(`Candidate '${id}' has invalid or blank name.`);
      }

      totalChars += id.length;
      totalChars += name.length;

      const item: { id: string; name: string; description?: string; parentId?: string; path?: string } = {
        id,
        name,
      };

      if (desc !== undefined) {
        if (typeof desc !== "string") {
          throw new SemanticInputValidationError(`Candidate '${id}' description must be a string.`);
        }
        totalChars += desc.length;
        item.description = desc;
      }
      if (parentId !== undefined) {
        if (typeof parentId !== "string" || parentId.trim().length === 0) {
          throw new SemanticInputValidationError(`Candidate '${id}' parentId must be a non-blank string.`);
        }
        totalChars += parentId.length;
        item.parentId = parentId;
      }
      if (path !== undefined) {
        if (typeof path !== "string" || path.trim().length === 0) {
          throw new SemanticInputValidationError(`Candidate '${id}' path must be a non-blank string.`);
        }
        totalChars += path.length;
        item.path = path;
      }

      validCandidates.push(item);
    }
    return validCandidates;
  }

  function validateEvidence(evidenceRaw: unknown): SemanticEvidenceItem[] | undefined {
    if (evidenceRaw === undefined) return undefined;
    if (!Array.isArray(evidenceRaw)) {
      throw new SemanticInputValidationError("Evidence must be an array.");
    }
    for (let i = 0; i < evidenceRaw.length; i++) {
      if (!(i in evidenceRaw)) {
        throw new SemanticInputValidationError(`Evidence array contains a sparse array hole at index ${i}.`);
      }
    }
    if (evidenceRaw.length > config.maxEvidenceItems) {
      throw new SemanticInputValidationError(
        `Evidence count (${evidenceRaw.length}) exceeds maximum limit (${config.maxEvidenceItems}).`
      );
    }

    const evidenceIds = new Set<string>();
    const validEvidence: SemanticEvidenceItem[] = [];
    const allowedKeys = new Set(["id", "text"]);

    for (let i = 0; i < evidenceRaw.length; i++) {
      const e = evidenceRaw[i];
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        throw new SemanticInputValidationError(`Evidence item at index ${i} must be a non-null object.`);
      }

      for (const k of Object.keys(e as Record<string, unknown>)) {
        if (!allowedKeys.has(k)) {
          throw new SemanticInputValidationError(`Unknown property '${k}' in evidence item at index ${i}.`);
        }
      }

      const id = (e as Record<string, unknown>).id;
      const text = (e as Record<string, unknown>).text;

      if (typeof id !== "string" || id.trim().length === 0) {
        throw new SemanticInputValidationError(`Evidence item at index ${i} has invalid or blank id.`);
      }
      if (evidenceIds.has(id)) {
        throw new SemanticInputValidationError(`Duplicate evidence id detected: '${id}'.`);
      }
      evidenceIds.add(id);

      if (typeof text !== "string" || text.trim().length === 0) {
        throw new SemanticInputValidationError(`Evidence item '${id}' has invalid or blank text.`);
      }

      totalChars += id.length;
      totalChars += text.length;

      validEvidence.push({ id, text });
    }
    return validEvidence;
  }

  let result: SemanticTaskInput;

  if (taskKind === "CATEGORY_MAPPING") {
    const allowedTopKeys = new Set([
      "taskKind",
      "productTitle",
      "productDescription",
      "brand",
      "categoryHints",
      "sourceCategoryPath",
      "candidates",
      "evidence",
    ]);
    for (const k of Object.keys(obj)) {
      if (!allowedTopKeys.has(k)) {
        throw new SemanticInputValidationError(`Unknown property '${k}' in CategoryMappingSemanticInput.`);
      }
    }

    const productTitle = trackText(obj.productTitle, "productTitle");
    const productDescription = obj.productDescription !== undefined
      ? trackText(obj.productDescription, "productDescription", true)
      : undefined;
    const brand = obj.brand !== undefined ? trackText(obj.brand, "brand") : undefined;
    const sourceCategoryPath = obj.sourceCategoryPath !== undefined
      ? trackText(obj.sourceCategoryPath, "sourceCategoryPath")
      : undefined;
    const categoryHints = obj.categoryHints !== undefined
      ? validateStringList(obj.categoryHints, "categoryHints")
      : undefined;
    const candidates = validateCandidates(obj.candidates);
    const evidence = validateEvidence(obj.evidence);

    if (totalChars > config.maxTextChars) {
      throw new SemanticInputValidationError(
        `Aggregate text character count (${totalChars}) exceeds maximum limit (${config.maxTextChars}).`
      );
    }

    result = {
      taskKind: "CATEGORY_MAPPING",
      productTitle,
      productDescription,
      brand,
      categoryHints,
      sourceCategoryPath,
      candidates,
      evidence,
    };
  } else if (taskKind === "ATTRIBUTE_MAPPING") {
    const allowedTopKeys = new Set([
      "taskKind",
      "sourceSpecificationKey",
      "sourceSpecificationValue",
      "brand",
      "productTitle",
      "candidates",
      "evidence",
    ]);
    for (const k of Object.keys(obj)) {
      if (!allowedTopKeys.has(k)) {
        throw new SemanticInputValidationError(`Unknown property '${k}' in AttributeMappingSemanticInput.`);
      }
    }

    const sourceSpecificationKey = trackText(obj.sourceSpecificationKey, "sourceSpecificationKey");
    const sourceSpecificationValue = trackText(obj.sourceSpecificationValue, "sourceSpecificationValue");
    const brand = obj.brand !== undefined ? trackText(obj.brand, "brand") : undefined;
    const productTitle = obj.productTitle !== undefined ? trackText(obj.productTitle, "productTitle") : undefined;
    const candidates = validateCandidates(obj.candidates);
    const evidence = validateEvidence(obj.evidence);

    if (totalChars > config.maxTextChars) {
      throw new SemanticInputValidationError(
        `Aggregate text character count (${totalChars}) exceeds maximum limit (${config.maxTextChars}).`
      );
    }

    result = {
      taskKind: "ATTRIBUTE_MAPPING",
      sourceSpecificationKey,
      sourceSpecificationValue,
      brand,
      productTitle,
      candidates,
      evidence,
    };
  } else if (taskKind === "ANOMALY_REVIEW") {
    const allowedTopKeys = new Set([
      "taskKind",
      "productTitle",
      "selectedCategoryPath",
      "sourceSpecifications",
      "variantLabels",
      "suspectedAnomalyReasons",
      "evidence",
    ]);
    for (const k of Object.keys(obj)) {
      if (!allowedTopKeys.has(k)) {
        throw new SemanticInputValidationError(`Unknown property '${k}' in AnomalyReviewSemanticInput.`);
      }
    }

    const productTitle = trackText(obj.productTitle, "productTitle");
    const selectedCategoryPath = trackText(obj.selectedCategoryPath, "selectedCategoryPath");

    let sourceSpecifications: SemanticSpecificationItem[] | undefined;
    if (obj.sourceSpecifications !== undefined) {
      if (!Array.isArray(obj.sourceSpecifications)) {
        throw new SemanticInputValidationError("sourceSpecifications must be an array.");
      }
      for (let i = 0; i < obj.sourceSpecifications.length; i++) {
        if (!(i in obj.sourceSpecifications)) {
          throw new SemanticInputValidationError(`sourceSpecifications contains a sparse array hole at index ${i}.`);
        }
      }
      if (obj.sourceSpecifications.length > config.maxSpecifications) {
        throw new SemanticInputValidationError(
          `sourceSpecifications count (${obj.sourceSpecifications.length}) exceeds maximum limit (${config.maxSpecifications}).`
        );
      }
      sourceSpecifications = [];
      const specAllowed = new Set(["key", "value"]);
      for (let i = 0; i < obj.sourceSpecifications.length; i++) {
        const s = obj.sourceSpecifications[i];
        if (typeof s !== "object" || s === null || Array.isArray(s)) {
          throw new SemanticInputValidationError(`Specification item at index ${i} must be a non-null object.`);
        }
        for (const k of Object.keys(s as Record<string, unknown>)) {
          if (!specAllowed.has(k)) {
            throw new SemanticInputValidationError(`Unknown property '${k}' in specification item at index ${i}.`);
          }
        }
        const key = (s as Record<string, unknown>).key;
        const val = (s as Record<string, unknown>).value;
        if (typeof key !== "string" || key.trim().length === 0) {
          throw new SemanticInputValidationError(`Specification key at index ${i} must be a non-blank string.`);
        }
        if (typeof val !== "string") {
          throw new SemanticInputValidationError(`Specification value at index ${i} must be a string.`);
        }
        totalChars += key.length;
        totalChars += val.length;
        sourceSpecifications.push({ key, value: val });
      }
    }

    const variantLabels = obj.variantLabels !== undefined
      ? validateStringList(obj.variantLabels, "variantLabels")
      : undefined;
    const suspectedAnomalyReasons = obj.suspectedAnomalyReasons !== undefined
      ? validateStringList(obj.suspectedAnomalyReasons, "suspectedAnomalyReasons")
      : undefined;
    const evidence = validateEvidence(obj.evidence);

    if (totalChars > config.maxTextChars) {
      throw new SemanticInputValidationError(
        `Aggregate text character count (${totalChars}) exceeds maximum limit (${config.maxTextChars}).`
      );
    }

    result = {
      taskKind: "ANOMALY_REVIEW",
      productTitle,
      selectedCategoryPath,
      sourceSpecifications,
      variantLabels,
      suspectedAnomalyReasons,
      evidence,
    };
  } else {
    // PARSER_RECOVERY_SUGGESTION
    const allowedTopKeys = new Set([
      "taskKind",
      "urlPath",
      "diagnosticLabels",
      "failureSignals",
      "suspectedDomMarkers",
      "evidence",
    ]);
    for (const k of Object.keys(obj)) {
      if (!allowedTopKeys.has(k)) {
        throw new SemanticInputValidationError(`Unknown property '${k}' in ParserRecoverySemanticInput.`);
      }
    }

    const urlPath = trackText(obj.urlPath, "urlPath");
    const diagnosticLabels = validateStringList(obj.diagnosticLabels, "diagnosticLabels");
    const failureSignals = validateStringList(obj.failureSignals, "failureSignals");
    const suspectedDomMarkers = obj.suspectedDomMarkers !== undefined
      ? validateStringList(obj.suspectedDomMarkers, "suspectedDomMarkers")
      : undefined;
    const evidence = validateEvidence(obj.evidence);

    if (totalChars > config.maxTextChars) {
      throw new SemanticInputValidationError(
        `Aggregate text character count (${totalChars}) exceeds maximum limit (${config.maxTextChars}).`
      );
    }

    result = {
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      urlPath,
      diagnosticLabels,
      failureSignals,
      suspectedDomMarkers,
      evidence,
    };
  }

  // Deep freeze the entire validated input snapshot for runtime immutability
  return deepFreeze(result);
}

/**
 * Pure deterministic risk classification policy.
 * AI never decides authoritative risk.
 */
export function computeDeterministicRisk(
  taskKind: SemanticTaskKind,
  confidence: number | null,
  selectedCandidateId: string | null,
  source: SemanticSource
): RiskLevel {
  if (taskKind === "PARSER_RECOVERY_SUGGESTION") {
    return "HIGH";
  }

  if (taskKind === "ANOMALY_REVIEW") {
    return "MEDIUM";
  }

  // CATEGORY_MAPPING or ATTRIBUTE_MAPPING
  if (source === "DETERMINISTIC") {
    return "LOW";
  }

  if (selectedCandidateId === null) {
    return "HIGH";
  }

  if (confidence === null || confidence < 0.8) {
    return "HIGH";
  }

  return "MEDIUM";
}
