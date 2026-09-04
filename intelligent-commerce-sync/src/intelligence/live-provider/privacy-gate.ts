/**
 * Phase 5E: Defense-in-Depth Privacy Gate & Request Envelope Validation
 * Structural schema enforcement, property-name scanner, and provenance consistency.
 */

import {
  SemanticProviderError,
  type SemanticProviderRequest,
  type SemanticTaskKind,
} from "../types.js";

const VALID_TASK_KINDS = new Set<SemanticTaskKind>([
  "CATEGORY_MAPPING",
  "ATTRIBUTE_MAPPING",
  "ANOMALY_REVIEW",
  "PARSER_RECOVERY_SUGGESTION",
]);

const REQUEST_EXACT_KEYS = [
  "requestId",
  "taskKind",
  "prompt",
  "systemInstruction",
  "untrustedData",
  "allowedCandidateIds",
  "allowedEvidenceIds",
  "signal",
] as const;

const FORBIDDEN_PROPERTY_NAMES = new Set([
  "password",
  "token",
  "cookie",
  "authorization",
  "auth",
  "secret",
  "apikey",
  "session",
  "rawhtml",
  "html",
  "browserstorage",
  "executionpayload",
  "privatekey",
]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  if (proto === null || proto === Object.prototype) {
    return true;
  }
  if (proto && typeof proto === "object" && proto.constructor === Object) {
    return true;
  }
  return false;
}

function isDenseArray(arr: unknown): arr is unknown[] {
  if (!Array.isArray(arr)) {
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    if (!hasOwn(arr, i)) {
      return false;
    }
  }
  return true;
}

function isDenseStringArray(arr: unknown): arr is string[] {
  if (!isDenseArray(arr)) {
    return false;
  }
  return arr.every((item) => typeof item === "string");
}

function isDenseNonBlankStringArray(arr: unknown): arr is string[] {
  if (!isDenseArray(arr)) {
    return false;
  }
  return arr.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isGenuineAbortSignal(signal: unknown): signal is AbortSignal {
  if (typeof signal !== "object" || signal === null) {
    return false;
  }
  try {
    return (
      signal instanceof AbortSignal &&
      Object.prototype.toString.call(signal) === "[object AbortSignal]" &&
      typeof (signal as AbortSignal).aborted === "boolean" &&
      typeof (signal as AbortSignal).addEventListener === "function" &&
      typeof (signal as AbortSignal).removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const REQUEST_EXACT_KEY_SET = new Set<string>(REQUEST_EXACT_KEYS);

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateRequestEnvelope(request: unknown): asserts request is SemanticProviderRequest {
  if (!isPlainObject(request)) {
    throw new SemanticProviderError("Semantic provider request must be a non-null plain object.");
  }

  if (Object.getOwnPropertySymbols(request).length > 0) {
    throw new SemanticProviderError("Semantic provider request must not contain symbol-keyed properties.");
  }

  const keys = Object.keys(request);
  if (keys.length !== REQUEST_EXACT_KEYS.length) {
    throw new SemanticProviderError(
      `Semantic provider request must have exactly ${REQUEST_EXACT_KEYS.length} properties, found ${keys.length}.`
    );
  }

  for (const k of keys) {
    if (!REQUEST_EXACT_KEY_SET.has(k)) {
      throw new SemanticProviderError(`Semantic provider request contains unknown property: '${k}'.`);
    }
  }

  for (const expectedKey of REQUEST_EXACT_KEYS) {
    if (!hasOwn(request, expectedKey)) {
      throw new SemanticProviderError(`Semantic provider request missing required property: '${expectedKey}'.`);
    }
  }

  const req = request as Record<string, unknown>;

  // requestId: 64 lowercase hex characters
  if (typeof req.requestId !== "string" || !/^[0-9a-f]{64}$/.test(req.requestId)) {
    throw new SemanticProviderError(
      "Semantic provider request 'requestId' must be exactly 64 lowercase hexadecimal characters."
    );
  }

  // taskKind: exact finite enum
  if (typeof req.taskKind !== "string" || !VALID_TASK_KINDS.has(req.taskKind as SemanticTaskKind)) {
    throw new SemanticProviderError(
      `Semantic provider request 'taskKind' is invalid: '${String(req.taskKind)}'.`
    );
  }

  // prompt: primitive nonblank string
  if (typeof req.prompt !== "string" || req.prompt.trim().length === 0) {
    throw new SemanticProviderError("Semantic provider request 'prompt' must be a non-blank string.");
  }

  // systemInstruction: primitive nonblank string
  if (typeof req.systemInstruction !== "string" || req.systemInstruction.trim().length === 0) {
    throw new SemanticProviderError("Semantic provider request 'systemInstruction' must be a non-blank string.");
  }

  // allowedCandidateIds: dense array of nonblank strings, no duplicates
  if (!isDenseArray(req.allowedCandidateIds) || !isDenseNonBlankStringArray(req.allowedCandidateIds)) {
    throw new SemanticProviderError("Semantic provider request 'allowedCandidateIds' must be a dense array of non-blank strings.");
  }
  if (new Set(req.allowedCandidateIds).size !== req.allowedCandidateIds.length) {
    throw new SemanticProviderError("Semantic provider request 'allowedCandidateIds' must not contain duplicates.");
  }

  // allowedEvidenceIds: dense array of nonblank strings, no duplicates
  if (!isDenseArray(req.allowedEvidenceIds) || !isDenseNonBlankStringArray(req.allowedEvidenceIds)) {
    throw new SemanticProviderError("Semantic provider request 'allowedEvidenceIds' must be a dense array of non-blank strings.");
  }
  if (new Set(req.allowedEvidenceIds).size !== req.allowedEvidenceIds.length) {
    throw new SemanticProviderError("Semantic provider request 'allowedEvidenceIds' must not contain duplicates.");
  }

  // signal: genuine AbortSignal
  if (!isGenuineAbortSignal(req.signal)) {
    throw new SemanticProviderError("Semantic provider request 'signal' must be a genuine AbortSignal instance.");
  }
}

export function scanForbiddenPropertyNames(val: unknown, path = "untrustedData"): void {
  if (val === null || typeof val !== "object") {
    return;
  }

  if (Array.isArray(val)) {
    if (!isDenseArray(val)) {
      throw new SemanticProviderError(`Sparse array hole detected in ${path}.`);
    }
    for (let i = 0; i < val.length; i++) {
      scanForbiddenPropertyNames(val[i], `${path}[${i}]`);
    }
    return;
  }

  if (Object.getOwnPropertySymbols(val).length > 0) {
    throw new SemanticProviderError(`Symbol-keyed property detected in ${path}.`);
  }

  for (const key of Object.keys(val)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (FORBIDDEN_PROPERTY_NAMES.has(normalizedKey)) {
      throw new SemanticProviderError(
        `Forbidden structural property name '${key}' detected at ${path}.${key}.`
      );
    }
    scanForbiddenPropertyNames((val as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function validatePrivacyGate(request: SemanticProviderRequest): void {
  const { untrustedData, taskKind } = request;

  if (!isPlainObject(untrustedData)) {
    throw new SemanticProviderError("Semantic provider untrustedData must be a non-null plain object.");
  }

  if (Object.getOwnPropertySymbols(untrustedData).length > 0) {
    throw new SemanticProviderError("Semantic provider untrustedData must not contain symbol-keyed properties.");
  }

  // Recursive structural property-name scan (PROPERTY NAMES ONLY, not values)
  scanForbiddenPropertyNames(untrustedData);

  // taskKind validation in untrustedData
  if (!hasOwn(untrustedData, "taskKind") || untrustedData.taskKind !== taskKind) {
    throw new SemanticProviderError(
      `UntrustedData taskKind '${String(untrustedData.taskKind)}' does not match request taskKind '${taskKind}'.`
    );
  }

  const topKeys = new Set(Object.keys(untrustedData));

  switch (taskKind) {
    case "CATEGORY_MAPPING": {
      const allowed = new Set([
        "taskKind",
        "productTitle",
        "productDescription",
        "brand",
        "categoryHints",
        "sourceCategoryPath",
        "candidates",
        "evidence",
      ]);
      for (const k of topKeys) {
        if (!allowed.has(k)) {
          throw new SemanticProviderError(`Unknown property '${k}' in CATEGORY_MAPPING untrustedData.`);
        }
      }
      if (
        !hasOwn(untrustedData, "taskKind") ||
        !hasOwn(untrustedData, "productTitle") ||
        !hasOwn(untrustedData, "candidates") ||
        !hasOwn(untrustedData, "evidence") ||
        typeof untrustedData.productTitle !== "string" ||
        untrustedData.productTitle.trim().length === 0 ||
        !isDenseArray(untrustedData.candidates) ||
        !isDenseArray(untrustedData.evidence)
      ) {
        throw new SemanticProviderError("CATEGORY_MAPPING untrustedData missing required canonical fields.");
      }
      if (
        hasOwn(untrustedData, "productDescription") &&
        typeof untrustedData.productDescription !== "string"
      ) {
        throw new SemanticProviderError("CATEGORY_MAPPING productDescription must be a string.");
      }
      if (
        hasOwn(untrustedData, "brand") &&
        (typeof untrustedData.brand !== "string" || untrustedData.brand.trim().length === 0)
      ) {
        throw new SemanticProviderError("CATEGORY_MAPPING brand must be a non-blank string.");
      }
      if (
        hasOwn(untrustedData, "sourceCategoryPath") &&
        (typeof untrustedData.sourceCategoryPath !== "string" || untrustedData.sourceCategoryPath.trim().length === 0)
      ) {
        throw new SemanticProviderError("CATEGORY_MAPPING sourceCategoryPath must be a non-blank string.");
      }
      if (
        hasOwn(untrustedData, "categoryHints") &&
        !isDenseNonBlankStringArray(untrustedData.categoryHints)
      ) {
        throw new SemanticProviderError("CATEGORY_MAPPING categoryHints must be a dense non-blank string array.");
      }
      validateCandidates(untrustedData.candidates);
      validateEvidence(untrustedData.evidence);
      break;
    }

    case "ATTRIBUTE_MAPPING": {
      const allowed = new Set([
        "taskKind",
        "sourceSpecificationKey",
        "sourceSpecificationValue",
        "brand",
        "productTitle",
        "candidates",
        "evidence",
      ]);
      for (const k of topKeys) {
        if (!allowed.has(k)) {
          throw new SemanticProviderError(`Unknown property '${k}' in ATTRIBUTE_MAPPING untrustedData.`);
        }
      }
      if (
        !hasOwn(untrustedData, "taskKind") ||
        !hasOwn(untrustedData, "sourceSpecificationKey") ||
        !hasOwn(untrustedData, "sourceSpecificationValue") ||
        !hasOwn(untrustedData, "candidates") ||
        !hasOwn(untrustedData, "evidence") ||
        typeof untrustedData.sourceSpecificationKey !== "string" ||
        untrustedData.sourceSpecificationKey.trim().length === 0 ||
        typeof untrustedData.sourceSpecificationValue !== "string" ||
        untrustedData.sourceSpecificationValue.trim().length === 0 ||
        !isDenseArray(untrustedData.candidates) ||
        !isDenseArray(untrustedData.evidence)
      ) {
        throw new SemanticProviderError("ATTRIBUTE_MAPPING untrustedData missing required canonical fields.");
      }
      if (
        hasOwn(untrustedData, "brand") &&
        (typeof untrustedData.brand !== "string" || untrustedData.brand.trim().length === 0)
      ) {
        throw new SemanticProviderError("ATTRIBUTE_MAPPING brand must be a non-blank string.");
      }
      if (
        hasOwn(untrustedData, "productTitle") &&
        (typeof untrustedData.productTitle !== "string" || untrustedData.productTitle.trim().length === 0)
      ) {
        throw new SemanticProviderError("ATTRIBUTE_MAPPING productTitle must be a non-blank string.");
      }
      validateCandidates(untrustedData.candidates);
      validateEvidence(untrustedData.evidence);
      break;
    }

    case "ANOMALY_REVIEW": {
      const allowed = new Set([
        "taskKind",
        "productTitle",
        "selectedCategoryPath",
        "sourceSpecifications",
        "variantLabels",
        "suspectedAnomalyReasons",
        "evidence",
      ]);
      for (const k of topKeys) {
        if (!allowed.has(k)) {
          throw new SemanticProviderError(`Unknown property '${k}' in ANOMALY_REVIEW untrustedData.`);
        }
      }
      if (
        !hasOwn(untrustedData, "taskKind") ||
        !hasOwn(untrustedData, "productTitle") ||
        !hasOwn(untrustedData, "selectedCategoryPath") ||
        !hasOwn(untrustedData, "evidence") ||
        typeof untrustedData.productTitle !== "string" ||
        untrustedData.productTitle.trim().length === 0 ||
        typeof untrustedData.selectedCategoryPath !== "string" ||
        untrustedData.selectedCategoryPath.trim().length === 0 ||
        !isDenseArray(untrustedData.evidence)
      ) {
        throw new SemanticProviderError("ANOMALY_REVIEW untrustedData missing required canonical fields.");
      }
      validateEvidence(untrustedData.evidence);
      if (hasOwn(untrustedData, "sourceSpecifications")) {
        validateSpecifications(untrustedData.sourceSpecifications);
      }
      if (
        hasOwn(untrustedData, "variantLabels") &&
        !isDenseNonBlankStringArray(untrustedData.variantLabels)
      ) {
        throw new SemanticProviderError("ANOMALY_REVIEW variantLabels must be a dense non-blank string array.");
      }
      if (
        hasOwn(untrustedData, "suspectedAnomalyReasons") &&
        !isDenseNonBlankStringArray(untrustedData.suspectedAnomalyReasons)
      ) {
        throw new SemanticProviderError("ANOMALY_REVIEW suspectedAnomalyReasons must be a dense non-blank string array.");
      }
      break;
    }

    case "PARSER_RECOVERY_SUGGESTION": {
      const allowed = new Set([
        "taskKind",
        "urlPath",
        "diagnosticLabels",
        "failureSignals",
        "suspectedDomMarkers",
        "evidence",
      ]);
      for (const k of topKeys) {
        if (!allowed.has(k)) {
          throw new SemanticProviderError(`Unknown property '${k}' in PARSER_RECOVERY_SUGGESTION untrustedData.`);
        }
      }
      if (
        !hasOwn(untrustedData, "taskKind") ||
        !hasOwn(untrustedData, "urlPath") ||
        !hasOwn(untrustedData, "diagnosticLabels") ||
        !hasOwn(untrustedData, "failureSignals") ||
        !hasOwn(untrustedData, "evidence") ||
        typeof untrustedData.urlPath !== "string" ||
        untrustedData.urlPath.trim().length === 0 ||
        !isDenseNonBlankStringArray(untrustedData.diagnosticLabels) ||
        !isDenseNonBlankStringArray(untrustedData.failureSignals) ||
        !isDenseArray(untrustedData.evidence)
      ) {
        throw new SemanticProviderError("PARSER_RECOVERY_SUGGESTION untrustedData missing required canonical fields.");
      }
      validateEvidence(untrustedData.evidence);
      if (
        hasOwn(untrustedData, "suspectedDomMarkers") &&
        !isDenseNonBlankStringArray(untrustedData.suspectedDomMarkers)
      ) {
        throw new SemanticProviderError("PARSER_RECOVERY_SUGGESTION suspectedDomMarkers must be a dense non-blank string array.");
      }
      break;
    }
  }

  // Allowlist Consistency Checks
  validateAllowlistConsistency(request);
}

function validateCandidates(candidates: unknown[]): void {
  if (!isDenseArray(candidates)) {
    throw new SemanticProviderError("candidates must be a dense array.");
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!isPlainObject(c)) {
      throw new SemanticProviderError(`Candidate at index ${i} must be a plain object.`);
    }
    const allowedKeys = new Set(["id", "name", "description", "parentId", "path"]);
    for (const k of Object.keys(c)) {
      if (!allowedKeys.has(k)) {
        throw new SemanticProviderError(`Candidate at index ${i} contains unknown property '${k}'.`);
      }
    }
    if (!hasOwn(c, "id") || typeof c.id !== "string" || c.id.trim().length === 0) {
      throw new SemanticProviderError(`Candidate at index ${i} missing required non-blank string 'id'.`);
    }
    if (!hasOwn(c, "name") || typeof c.name !== "string" || c.name.trim().length === 0) {
      throw new SemanticProviderError(`Candidate at index ${i} missing required non-blank string 'name'.`);
    }
    if (hasOwn(c, "description") && typeof c.description !== "string") {
      throw new SemanticProviderError(`Candidate at index ${i} 'description' must be a string.`);
    }
    if (hasOwn(c, "parentId") && (typeof c.parentId !== "string" || c.parentId.trim().length === 0)) {
      throw new SemanticProviderError(`Candidate at index ${i} 'parentId' must be a non-blank string.`);
    }
    if (hasOwn(c, "path") && (typeof c.path !== "string" || c.path.trim().length === 0)) {
      throw new SemanticProviderError(`Candidate at index ${i} 'path' must be a non-blank string.`);
    }
  }
}

function validateEvidence(evidence: unknown[]): void {
  if (!isDenseArray(evidence)) {
    throw new SemanticProviderError("evidence must be a dense array.");
  }
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    if (!isPlainObject(e)) {
      throw new SemanticProviderError(`Evidence at index ${i} must be a plain object.`);
    }
    const keys = Object.keys(e);
    if (keys.length !== 2 || !hasOwn(e, "id") || !hasOwn(e, "text")) {
      throw new SemanticProviderError(`Evidence at index ${i} must contain exactly 'id' and 'text'.`);
    }
    if (typeof e.id !== "string" || e.id.trim().length === 0) {
      throw new SemanticProviderError(`Evidence at index ${i} 'id' must be a non-blank string.`);
    }
    if (typeof e.text !== "string" || e.text.trim().length === 0) {
      throw new SemanticProviderError(`Evidence at index ${i} 'text' must be a non-blank string.`);
    }
  }
}

function validateSpecifications(specs: unknown): void {
  if (!isDenseArray(specs)) {
    throw new SemanticProviderError("sourceSpecifications must be a dense array.");
  }
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (!isPlainObject(s)) {
      throw new SemanticProviderError(`Specification at index ${i} must be a plain object.`);
    }
    const keys = Object.keys(s);
    if (keys.length !== 2 || !hasOwn(s, "key") || !hasOwn(s, "value")) {
      throw new SemanticProviderError(`Specification at index ${i} must contain exactly 'key' and 'value'.`);
    }
    if (typeof s.key !== "string" || s.key.trim().length === 0) {
      throw new SemanticProviderError(`Specification at index ${i} 'key' must be a non-blank string.`);
    }
    if (typeof s.value !== "string") {
      throw new SemanticProviderError(`Specification at index ${i} 'value' must be a string.`);
    }
  }
}

function validateAllowlistConsistency(request: SemanticProviderRequest): void {
  const { taskKind, untrustedData, allowedCandidateIds, allowedEvidenceIds } = request;

  // 1. Candidate Consistency
  if (taskKind === "CATEGORY_MAPPING" || taskKind === "ATTRIBUTE_MAPPING") {
    const candidates = untrustedData.candidates as Array<{ id: string }>;
    const untrustedCandidateIds = candidates.map((c) => c.id).sort(codeUnitCompare);
    const sortedAllowedCandidateIds = [...allowedCandidateIds].sort(codeUnitCompare);

    if (untrustedCandidateIds.length !== sortedAllowedCandidateIds.length) {
      throw new SemanticProviderError(
        `Candidate count mismatch between untrustedData (${untrustedCandidateIds.length}) and allowedCandidateIds (${sortedAllowedCandidateIds.length}).`
      );
    }
    for (let i = 0; i < untrustedCandidateIds.length; i++) {
      if (untrustedCandidateIds[i] !== sortedAllowedCandidateIds[i]) {
        throw new SemanticProviderError(
          `Candidate ID mismatch at sorted index ${i}: '${untrustedCandidateIds[i]}' vs '${sortedAllowedCandidateIds[i]}'.`
        );
      }
    }
  } else {
    // Non-mapping tasks must have empty allowedCandidateIds
    if (allowedCandidateIds.length > 0) {
      throw new SemanticProviderError(
        `Task '${taskKind}' must have empty allowedCandidateIds, received: ${allowedCandidateIds.length}.`
      );
    }
  }

  // 2. Evidence Consistency (All tasks)
  const evidence = untrustedData.evidence as Array<{ id: string }>;
  const untrustedEvidenceIds = evidence.map((e) => e.id).sort(codeUnitCompare);
  const sortedAllowedEvidenceIds = [...allowedEvidenceIds].sort(codeUnitCompare);

  if (untrustedEvidenceIds.length !== sortedAllowedEvidenceIds.length) {
    throw new SemanticProviderError(
      `Evidence count mismatch between untrustedData (${untrustedEvidenceIds.length}) and allowedEvidenceIds (${sortedAllowedEvidenceIds.length}).`
    );
  }
  for (let i = 0; i < untrustedEvidenceIds.length; i++) {
    if (untrustedEvidenceIds[i] !== sortedAllowedEvidenceIds[i]) {
      throw new SemanticProviderError(
        `Evidence ID mismatch at sorted index ${i}: '${untrustedEvidenceIds[i]}' vs '${sortedAllowedEvidenceIds[i]}'.`
      );
    }
  }
}
