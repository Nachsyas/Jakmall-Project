# Phase 5A Architecture: AI / Semantic Intelligence Safety Foundation

## 1. Purpose
Phase 5A establishes the safe, provider-neutral, and deterministic-first semantic intelligence architecture for the Intelligent Commerce Sync platform.

It addresses semantic catalog challenges (such as marketplace category matching, specification attribute mapping, anomaly detection, and parser recovery assistance) while strictly preventing AI from assuming authority over commercial truth, pricing, inventory, database persistence, or marketplace mutation.

> [!IMPORTANT]
> **Explicit Architectural Boundaries**:
> - Phase 5A performs **ZERO** live AI network calls.
> - Phase 5A performs **ZERO** marketplace mutations.
> - Phase 5A performs **ZERO** database mutations or schema modifications.
> - Phase 5A does **NOT** implement autonomous agents, LangChain/LlamaIndex, self-healing code, or RAG vectors.

---

## 2. Why AI is Strictly Advisory
In an automated cross-border e-commerce pipeline, small hallucinations or misinterpretations produce disastrous financial and operational consequences:
- Hallucinating price or discount margins leads to catastrophic sell-at-a-loss events.
- Fabricating stock quantities leads to out-of-stock penalties and store suspension.
- Inventing SKU codes or marketplace category IDs breaks platform synchronization contracts.
- Altering idempotency records breaks deduplication guarantees and causes duplicate orders.

Therefore, AI is classified exclusively as an **advisory semantic assistant**. AI is explicitly **NOT** the authority for:
- Source truth or parsed raw data
- Source price, selling price, or markup
- Stock quantity or safety stock buffers
- Source availability
- SKU identity or variant identity
- Field ownership rules
- Idempotency guarantees
- BullMQ queue job states or retry policies
- Marketplace mutations (CREATE, UPDATE_PRICE, UPDATE_STOCK)
- Database transaction safety
- Execution payloads (`executionPayload`)
- Authentication credentials, tokens, or session state
- Publication authorization or verification truth

---

## 3. Deterministic-First Hierarchy
All semantic decisions are resolved through an uncompromising hierarchy:

```
KNOWN DETERMINISTIC RULE
        ↓
HISTORICAL / VERIFIED MAPPING (CACHE)
        ↓
AI SEMANTIC SUGGESTION (UNRESOLVED CASES ONLY)
        ↓
STRICT OUTPUT VALIDATION
        ↓
CONFIDENCE CHECK
        ↓
DETERMINISTIC RISK CLASSIFICATION
        ↓
HUMAN REVIEW (MANDATORY IN PHASE 5A)
        ↓
AUTHORIZED DOWNSTREAM ACTION
        ↓
POST-MUTATION VERIFICATION
```

### Hierarchy & Deterministic Resolver Rules
1. **Deterministic Outranks AI**: If an explicit mapping rule exists or a verified historical mapping is matched, the deterministic resolver answers immediately. The AI provider is called zero times (`providerCallCount = 0`).
2. **Deterministic Resolution Is Not Validation-Free**: Every deterministic resolver response must pass strict runtime schema and allowlist validation:
   - Allowed fields only: `resolved`, `candidateId`, `explanation`, `evidenceRefs`. Unknown fields fail closed.
   - For unresolved outcomes (`resolved === false`), it must strictly follow `{ resolved: false }` without unused semantic payloads.
   - For resolved mapping tasks, `candidateId` must be non-null and belong to the caller-supplied candidate allowlist.
   - For anomaly review and parser recovery, `candidateId` must be absent or null.
3. **Explicit Deterministic Failure Outcome**: If a deterministic resolver throws, returns an invalid structure, or violates candidate/evidence allowlists, the outcome is `DETERMINISTIC_RESOLVER_FAILURE`. The AI provider is **NOT** called, protecting against silent fallthrough to AI.

---

## 4. Provider Abstraction & Enforced Timeout
The semantic service communicates exclusively through a provider-neutral interface (`SemanticAiProvider`):

```typescript
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
```

### Service-Level Enforced Timeout
To ensure an uncooperative or hanging provider cannot block execution:
- `SemanticProviderRequest.signal: AbortSignal` is required.
- `SemanticIntelligenceService` uses `AbortController` coupled with `Promise.race`.
- If the configured timeout elapses before the provider resolves, the abort signal is triggered and the service immediately returns `PROVIDER_UNAVAILABLE` with `source = "NONE"`.
- Timeout handles are cleared in a `finally` block to prevent timer resource leaks.

---

## 5. Safe Semantic Input Contracts & Credentials Boundary
The intelligence module accepts only a strictly typed, minimized projection:
- **`CATEGORY_MAPPING`**: `productTitle`, `productDescription?`, `brand?`, `categoryHints?`, `sourceCategoryPath?`, `candidates`, `evidence?`.
- **`ATTRIBUTE_MAPPING`**: `sourceSpecificationKey`, `sourceSpecificationValue`, `brand?`, `productTitle?`, `candidates`, `evidence?`.
- **`ANOMALY_REVIEW`**: `productTitle`, `selectedCategoryPath`, `sourceSpecifications?`, `variantLabels?`, `suspectedAnomalyReasons?`, `evidence?`.
- **`PARSER_RECOVERY_SUGGESTION`**: `urlPath`, `diagnosticLabels`, `failureSignals`, `suspectedDomMarkers?`, `evidence?`.

### Credentials Boundary & Truthful Expectations
- **No Dedicated Secret Fields**: The input contract has no fields for passwords, API keys, tokens, session cookies, or authorization headers.
- **Unknown Field Rejection**: Any unexpected credential-shaped properties (e.g., `apiKey`, `password`, `authToken`) are rejected by runtime schema validation.
- **Caller Responsibility**: Strict schema validation cannot magically detect arbitrary credentials or secrets embedded inside legitimate free-text fields (such as product descriptions or titles). Callers **MUST NOT** pass secrets in free-text fields. Phase 5A does not claim arbitrary text secret-scanning capability.

---

## 6. Prompt Injection Containment
All product titles, descriptions, seller notes, variant names, and diagnostic labels originating from external websites are treated as **untrusted data**:
1. **Explicit Isolation**: The prompt builder isolates source text between strict delimiters:
   ```
   === BEGIN UNTRUSTED SOURCE DATA ===
   { ... JSON ... }
   === END UNTRUSTED SOURCE DATA ===
   ```
2. **System Instruction Precedence**: System instructions explicitly instruct the model that content within the data delimiters is external data and must never be interpreted as commands or instructions.
3. **Defense in Depth**: Security does not rely solely on prompt phrasing. Regardless of what the model outputs, strict schema validation and candidate allowlisting discard any instructions or fabricated IDs.

---

## 7. Two-Layer Strict Structured Output Validation
Model provider responses are treated as completely untrusted at two distinct runtime boundaries:

### Layer 1: Provider Response Envelope Validation
Before any JSON parsing or access to output fields, `validateSemanticProviderResponse` validates the runtime envelope returned by `provider.complete()`:
- **Envelope Structure**: Must be a non-null, non-array, plain object. Symbol-keyed properties are rejected.
- **Exact Key Set**: Exactly one property is permitted: `rawText`.
- **Zero Extraneous Properties**: Unknown properties (e.g. `metadata`, `parsed`, `output`, `result`, `usage`) are strictly rejected. No provider metadata is accepted.
- **Primitive String Type**: `rawText` must be a primitive string. Objects, numbers, booleans, or null values in `rawText` are rejected.
- **Envelope Violations**: Any envelope defect fails closed as `INVALID_PROVIDER_OUTPUT` with `source = "NONE"`. It is not classified as `PROVIDER_UNAVAILABLE` because the provider did respond, but violated its output contract.
- A newly allocated trusted object `{ rawText: obj.rawText }` is returned, preventing arbitrary object passthrough.

### Layer 2: Raw Text JSON Semantic Output Schema Validation
The validated `rawText` primitive string is passed to `validateSemanticOutput`:
- **JSON Parsing**: The raw string is parsed with `JSON.parse()`. Providers cannot bypass JSON parsing by injecting structured objects.
- **Top-Level Keys**: Must strictly match: `schemaVersion`, `taskKind`, `selectedCandidateId`, `confidence`, `explanationSummary`, `evidenceRefs`.
- **Forbidden Properties**: Unknown properties (e.g. `patch`, `code`, `sql`, `price`, `stock`, `marketplaceAction`, `executionInstruction`, `risk`, `reviewRequired`) immediately cause validation failure (`INVALID_PROVIDER_OUTPUT`).
- **Inert Explanation**: `explanationSummary` is inert display text only; it is never parsed, evaluated, or executed as code.
- **Direct Object Calls for Unit Tests Only**: Direct runtime-object calls to `validateSemanticOutput` exist solely for isolated validator testing (such as exercising `NaN`, `Infinity`, `-Infinity`, and string confidence rejection) and are never accessible via the production service provider transport path.

---

## 8. Candidate & Evidence Allowlisting
For `CATEGORY_MAPPING` and `ATTRIBUTE_MAPPING`:
- The caller supplies an explicit array of `candidates: SemanticCandidate[]`.
- The provider may choose either `null` or an exact ID from `allowedCandidateIds`.
- If the provider returns a candidate ID not present in the caller-supplied set, the result is rejected as `INVALID_PROVIDER_OUTPUT`.
- The system never fabricates, guesses, or infers unprovided marketplace category IDs.

For `ANOMALY_REVIEW` and `PARSER_RECOVERY_SUGGESTION`:
- `selectedCandidateId` must be strictly `null`.

### Evidence Allowlisting & Canonical Normalization (Always Active)
Evidence allowlisting is **never disabled**:
- If caller supplies no evidence items, `allowedEvidenceIds` is `[]`.
- In that case, any returned `evidenceRefs` (e.g. `["fake"]`) fail closed as `INVALID_PROVIDER_OUTPUT` (for AI) or `DETERMINISTIC_RESOLVER_FAILURE` (for deterministic resolver).
- Only empty `evidenceRefs: []` is permitted when no evidence was supplied.
- **Canonical Equivalence**: Omitted/undefined evidence and `evidence: []` produce the exact same canonical payload (`base.evidence = []`), the same `requestId`, the same prompt string, and identical `allowedEvidenceIds = []`.

---

## 9. Confidence Bounds
- `confidence` must be a finite floating-point number in the range `[0.0, 1.0]`.
- Non-finite numbers (`NaN`, `Infinity`, `-Infinity`), negative numbers, numbers greater than `1.0`, and string-encoded numbers fail closed as `SemanticOutputValidationError`.

---

## 10. Risk Classification
Authoritative risk is calculated purely by deterministic local policy; the AI model never decides risk.
Task risk overrides deterministic source for parser recovery and anomaly review:

| Situation / Task | Source | Deterministic Risk |
|---|---|---|
| `PARSER_RECOVERY_SUGGESTION` | Any (`AI` or `DETERMINISTIC`) | `HIGH` |
| `ANOMALY_REVIEW` | Any (`AI` or `DETERMINISTIC`) | `MEDIUM` |
| `CATEGORY_MAPPING` / `ATTRIBUTE_MAPPING` | `DETERMINISTIC` (verified) | `LOW` |
| AI Mapping: `selectedCandidateId === null` | `AI` | `HIGH` |
| AI Mapping: `confidence < 0.80` | `AI` | `HIGH` |
| AI Mapping: `confidence >= 0.80` | `AI` | `MEDIUM` |

---

## 11. Human Review Policy & Failure Source Semantics
In Phase 5A:
- **All AI-derived semantic suggestions enforce `reviewRequired = true`**, regardless of confidence or risk level. No AI result in Phase 5A can autonomously authorize downstream marketplace actions.
- **Deterministic Review Policy is Task-Specific**:
  - `CATEGORY_MAPPING` and `ATTRIBUTE_MAPPING`: Verified deterministic resolutions may have `reviewRequired = false`.
  - `ANOMALY_REVIEW`: Enforces `reviewRequired = true` even when deterministically resolved.
  - `PARSER_RECOVERY_SUGGESTION`: Enforces `reviewRequired = true` even when deterministically resolved. Parser recovery remains strictly advisory and never bypasses human review.

### Failure Semantic Sources
Failures have no trusted semantic source:
- `RESOLVED_DETERMINISTICALLY`: `source = "DETERMINISTIC"`
- `SUGGESTED` / `NEEDS_REVIEW`: `source = "AI"`
- `INPUT_REJECTED`: `source = "NONE"`
- `PROVIDER_UNAVAILABLE`: `source = "NONE"`
- `INVALID_PROVIDER_OUTPUT`: `source = "NONE"`
- `DETERMINISTIC_RESOLVER_FAILURE`: `source = "NONE"`

---

## 12. Request Identity, Canonical Ordering & Runtime Immutability
Every semantic request generates a deterministic SHA-256 identifier:
- Generated via `crypto.createHash("sha256")`. Zero `Math.random()`, zero `randomUUID()`, and zero timestamps.
- Derived from `canonicalizeSemanticPayload(input)`:
  - **Set-like Collections**: Candidates and evidence items are sorted stably by ID using a locale-independent code-unit comparator (`a < b ? -1 : a > b ? 1 : 0`). Zero locale-dependent collation.
  - **Canonical Evidence Normalization**: Omitted evidence and `evidence: []` serialize to identical canonical form.
  - **Ordered Collections**: Caller ordering of `sourceSpecifications`, `categoryHints`, and `variantLabels` is strictly preserved.
  - Object keys are recursively sorted.
  - Candidate-order differences or evidence-order differences produce the **exact same `requestId` and the exact same prompt**.
- **Runtime Immutability (`deepFreeze`)**: After validation, input data is recursively frozen before reaching the resolver or prompt builder. Resolvers cannot mutate caller input.
- **Fail-Closed Serializer**: Rejects unsupported non-JSON types (`NaN`, `Infinity`, `bigint`, `Date`, `Map`, `Set`, circular references, symbols, functions) and rejects sparse arrays (arrays with holes).

---

## 13. Input & Output Bounds
All structures and text are strictly bounded:
- `maxTextChars` (default: 12,000): Enforced across aggregate semantic text (title, description, specs, candidate fields, evidence text).
- `maxCandidates` (default: 100): Maximum candidate array length.
- `maxSpecifications` (default: 50): Maximum specifications count.
- `maxListItems` (default: 100): Bound for category hints, variant labels, diagnostic labels, and failure signals.
- `maxEvidenceItems` (default: 20): Maximum input evidence items.
- `maxEvidenceRefs` (default: 20): Maximum output evidence references.
- `maxExplanationChars` (default: 1,000): Maximum explanation string length.

---

## 14. Error Sanitization & Non-Fabrication
- Failures never leak raw secrets or connection strings. All error messages are sanitized through `sanitizeErrorMessage`, which redacts `postgresql://...`, `redis://...`, `Bearer ...`, and tokens to `[REDACTED]`.
- Failures never fabricate semantic values:
  - `INPUT_REJECTED`: `requestId: null`, `selectedCandidateId: null`, `confidence: null`, `risk: null`, `source: "NONE"`. If caller taskKind is invalid/missing, `taskKind = null`.
  - `PROVIDER_UNAVAILABLE`, `INVALID_PROVIDER_OUTPUT`, `DETERMINISTIC_RESOLVER_FAILURE`: `selectedCandidateId: null`, `confidence: null`, `risk: null`, `source: "NONE"`.

---

## 15. Parser Recovery Advisory Boundary
When HTML structure changes on the source site, `PARSER_RECOVERY_SUGGESTION` provides advisory diagnostics (e.g., missing DOM markers or script tag changes).
- AI may suggest where an engineer should investigate.
- AI cannot return a structured patch or code field because strict schema validation rejects unexpected keys (`patch`, `code`, `sql`, `command`).
- `explanationSummary` is inert display text only and is never executed.

---

## 16. Anomaly Review Advisory Boundary
`ANOMALY_REVIEW` identifies semantic mismatches (e.g., "powerbank" in the title but assigned to "Fashion Shoes").
- Output is strictly advisory.
- AI cannot override or modify numeric price, stock quantity, variant structure, or SKU identity.

---

## 17. No-Side-Effect Guarantee
Production code in `src/intelligence/**` has zero imports of:
- `PrismaClient` (zero database operations)
- `BullMQ` / `ioredis` (zero queue operations)
- `MarketplaceGateway` / `Shopee` / `JakMall` (zero marketplace API or scraping calls)
- `child_process` / `eval` / `new Function` (zero dynamic code execution)
- Filesystem writes (zero file writes)

---

## 18. Cost-Control Philosophy
1. **Deterministic-First**: Queries verified rules and cache first. Unresolved items only trigger AI.
2. **Minimized Context**: Only projected semantic fields and bounded candidates are forwarded.
3. **Deterministic Request ID**: Enables caching and deduplication across identical semantic requests.
4. **Zero AI for Deterministic Fields**: Prices, stock, markup, and SKU identity never touch AI.

---

## 19. Future Phase 5B Integration
Phase 5B will consume this foundation by:
- Connecting verified category mapping tables to the `DeterministicSemanticResolver`.
- Implementing real HTTP provider adapters (e.g., OpenAI / Gemini) conforming to `SemanticAiProvider`.
- Queueing AI suggestions for human review before updating canonical mapping rules.

---

## 20. Known Limitations
- **No Live Provider in 5A**: Provider implementations in Phase 5A are simulated/mocked for testing.
- **Human Review Mandatory**: In Phase 5A, all AI suggestions require manual approval before use in downstream execution.
