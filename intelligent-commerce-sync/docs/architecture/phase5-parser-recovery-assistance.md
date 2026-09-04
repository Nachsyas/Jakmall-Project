# Phase 5D: Parser Recovery Assistance Architecture

## 1. Overview & Purpose

Phase 5D provides bounded, deterministic-first diagnostic and advisory recovery assistance when JakMall product extraction degrades or fails due to source page layout or structural schema changes.

### Core Non-Goals & Invariants
- **NOT an auto-fixing parser**: Never self-modifies or alters source parser code.
- **NOT an execution engine**: Never applies CSS selectors, executes JavaScript, or runs shell/Git commands.
- **NOT a marketplace or database mutator**: Has zero write authority over prices, stock, database rows, or marketplace listings.
- **Strictly human-in-the-loop**: Every Phase 5D result carries immutable `risk: "HIGH"` and `reviewRequired: true`.
- **Zero source-engine modification**: Sits entirely outside `src/jakmall/` without modifying locked source components.

---

## 2. Source-Engine Failure Model

Phase 5D distinguishes real externally surfaced source errors from lower-level helper errors that are caught and swallowed by `parseJakmallHtml()`:

### A. Externally Surfaced Source Failures
1. **From `src/jakmall/client.ts`**:
   - `INVALID_SOURCE_URL`: URL parsing failed.
   - `SSRF_BLOCKED`: Foreign host or disallowed protocol.
   - `SOURCE_RATE_LIMITED`: HTTP 429 response.
   - `PRODUCT_NOT_FOUND`: HTTP 404 response.
   - `SOURCE_FETCH_FAILED`: Network transport errors or timeouts.
2. **From `src/jakmall/parser.ts`**:
   - `TITLE_NOT_FOUND`: Missing title in HTML.
   - `EXTRACTION_VALIDATION_FAILED`: `spdt` script failed Zod schema validation.
   - `EXTRACTION_FAILED`: Both `spdt` and JSON-LD fallback failed.
3. **From `src/jakmall/normalizer.ts`**:
   - `MISSING_PRICE`: Authoritative `price.final` is missing.
   - `INVALID_PRICE`: Authoritative `price.final` is non-positive or not a number.

### B. Internal Parser Helper Errors Swallowed by `parseJakmallHtml()`
Inside `parseJakmallHtml()`, the script extraction loop catches lower-level helper errors:
- `VARIABLE_NOT_FOUND`
- `ASSIGNMENT_NOT_FOUND`
- `OBJECT_BRACE_NOT_FOUND`
- `UNBALANCED_OBJECT`
- `JSON_PARSE_ERROR`

These helper errors are caught internally and suppress the current script element to fall back to JSON-LD. Therefore, they are **never surfaced externally** during standard ingestion and are rejected by Phase 5D input validation.

---

## 3. Finite Domain Contracts

### A. Status Set (`ParserRecoveryStatus`)
```typescript
export type ParserRecoveryStatus =
  | "RECOVERY_GUIDANCE_AVAILABLE"
  | "BLOCKED_FOR_REVIEW";
```

### B. Reason Codes (`ParserRecoveryReasonCode`)
```typescript
export type ParserRecoveryReasonCode =
  | "INPUT_VALIDATION_ERROR"
  | "NON_SEMANTIC_SOURCE_FAILURE"
  | "DETERMINISTIC_GUIDANCE_AVAILABLE"
  | "SEMANTIC_DETERMINISTIC_GUIDANCE"
  | "AI_RECOVERY_SUGGESTION"
  | "SEMANTIC_INPUT_REJECTED"
  | "SEMANTIC_PROVIDER_UNAVAILABLE"
  | "SEMANTIC_INVALID_PROVIDER_OUTPUT"
  | "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE";
```

### C. Primary Failure Codes (`ParserRecoveryFailureCode`)
```typescript
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
```

### D. Finite Observations (`ParserRecoveryObservation`)
```typescript
export type ParserRecoveryObservation =
  | "SPDT_SCRIPT_MISSING_OBSERVED"
  | "SPDT_SYNTAX_FAILURE_OBSERVED"
  | "JSON_LD_PRODUCT_MISSING_OBSERVED"
  | "JSON_LD_PRICE_INVALID_OBSERVED"
  | "SKU_RECORD_EMPTY_OBSERVED"
  | "FETCH_TIMEOUT_OBSERVED";
```

---

## 4. Non-Semantic Blocker Dominance

If **ANY** authoritative non-semantic source blocker is present:
- Failure code: `INVALID_SOURCE_URL`, `SSRF_BLOCKED`, `SOURCE_RATE_LIMITED`, `PRODUCT_NOT_FOUND`, `SOURCE_FETCH_FAILED`
- OR Observation: `FETCH_TIMEOUT_OBSERVED`

Then semantic escalation is strictly prohibited:
- `SemanticIntelligenceService.executeTask()` calls: **0**
- `SemanticAiProvider.complete()` calls: **0**
- `reasonCode`: `"NON_SEMANTIC_SOURCE_FAILURE"`
- `status`: `"BLOCKED_FOR_REVIEW"`
- All applicable deterministic findings are retained.

---

## 5. Structural Semantic Eligibility Gate

Semantic escalation occurs **ONLY IF ALL** of the following criteria are met:
1. Canonical `urlPath` is valid, non-null, and sanitized.
2. At least one structural/extraction failure or observation is present.
3. At least one contextual item (`suspectedDomMarkers` or `evidence`) is provided.
4. No non-semantic source blocker is present.
5. Constructed semantic payload respects active Phase 5A config bounds without silent truncation.

If contextual items are absent:
- AI call is bypassed.
- Returns local deterministic guidance (`status: "RECOVERY_GUIDANCE_AVAILABLE"`, `reasonCode: "DETERMINISTIC_GUIDANCE_AVAILABLE"`).

---

## 6. Active Phase 5A Config Integration & Zero-Truncation Safety

Before invoking `executeTask()`, Phase 5D inspects `semanticService.getConfig()`:
- Validates total character count against `config.maxTextChars`.
- Validates evidence count against `config.maxEvidenceItems`.
- Validates marker and signal counts against `config.maxListItems`.

If the constructed payload exceeds active config bounds:
- **Zero Silent Truncation**: Evidence or markers are never silently dropped or truncated.
- **Safe Fallback**: Phase 5D safely bypasses the AI provider, returning local deterministic guidance (`DETERMINISTIC_GUIDANCE_AVAILABLE`).

---

## 7. Data Privacy & Minimization

- **URL Sanitization**: Raw ASCII control characters (`code < 32 || code === 127`, including `\n`, `\r`, `\t`) are strictly rejected on raw input before any trimming or canonical normalization, preventing silent normalization of invalid paths. Query strings, hash fragments, foreign hostnames, and credentials are completely rejected or stripped. Output `urlPath` is normalized to pathname only.
- **`failureMessage` Isolation**: Raw `failureMessage` strings are strictly used for in-memory prefix/equality matching. They are **never** forwarded to AI prompts, semantic payloads, diagnostic details, or recovery guidance.
- **Zero External Ingestion**: Phase 5D never fetches HTML, reads cookies, inspects browser storage, or parses source JavaScript blobs.

---

## 8. Immutability & Determinism

- **Caller Object Protection**: Caller input objects, arrays, and evidence items are never mutated and never frozen.
- **Trusted Internal Snapshot**: `validateRawInput()` creates defensive copies of input arrays and evidence objects and deeply freezes the resulting `ValidatedInputSnapshot`.
- **Deep-Frozen Snapshot**: Returned `ParserRecoveryResult` instances are deeply frozen prior to return.
- **Deterministic Ordering**: Diagnostics, signals, and markers are sorted using UTF-16 code-unit comparators.
- **Zero Temporal / Random Dependencies**: Prohibits `Date.now()`, `new Date()`, `Math.random()`, and `randomUUID()`.

---

## 9. Authoritative Diagnostic Fact Precision

- **Deterministic Local Truth**: `ParserDiagnosticFinding` reflects only facts directly established by input evidence.
- **`DIAG_INVALID_SOURCE_URL`**: Factually describes captured URL parsing or format validation failure without conflating with SSRF host restrictions.
- **Observation Semantics**:
  - `JSON_LD_PRODUCT_MISSING_OBSERVED` alone strictly reports missing fallback JSON-LD Product schema without asserting spdt absence.
  - `JSON_LD_PRICE_INVALID_OBSERVED` alone strictly reports missing valid positive price in fallback JSON-LD Product schema.
  - The stronger assertion regarding both spdt and JSON-LD is emitted only when `EXTRACTION_FAILED` carries the exact certified failure message.
