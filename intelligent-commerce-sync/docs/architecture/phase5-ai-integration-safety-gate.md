# Phase 5E: Semantic AI Integration & Safety Gate Architecture

## 1. Overview & Architectural Role

Phase 5E establishes a controlled, cost-bounded, and privacy-hardened live integration adapter to OpenAI for semantic intelligence tasks within the Intelligent Commerce Sync platform.

```
┌─────────────────────────────────────────────────────────┐
│     Phase 5B / 5C / 5D Domain Services                  │
│  (Catalog Intelligence / Anomaly Review / Recovery)     │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 5A: SemanticIntelligenceService                  │
│  - Deterministic Resolver First                         │
│  - Request Builder & SHA-256 Canonicalization           │
│  - Service-Level Timeout & AbortController              │
│  - Strict Layer 1 Envelope Validation ({ rawText })     │
│  - Strict Layer 2 JSON Schema & Allowlist Enforcement   │
│  - Deterministic Risk & Outcome Classification          │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  SemanticAiProvider (Standard Phase 5A Interface)       │
│  complete(request): Promise<{ rawText: string }>        │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Phase 5E: LiveAiProvider Adapter                       │
│  - Defense-in-Depth Request Envelope Validation         │
│  - Task Privacy Gate (Top-Level & Property Name Scan)   │
│  - Outbound Request Text Budget (Character Count)       │
│  - Operational Modes (DISABLED, DRY_RUN, LIVE)          │
│  - Process Request Budget & Sliding-Window Rate Limiter │
│  - Circuit Breaker with Single-Probe Concurrency Lock   │
│  - Fixed Endpoint: POST api.openai.com/v1/responses     │
│  - Responses Structured Output Schema (Strict JSON)     │
│  - Single Raw Responses Array Output Parser             │
│  - Usage Subtotal Ledger (Reported vs Missing)          │
│  - Zero Real Network / Transport Injection for Testing  │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Fixed Responses API Protocol & Model Selection

### 2.1 Fixed Production Endpoint
Live network requests are sent strictly to:
```
POST https://api.openai.com/v1/responses
```
- The production endpoint is immutable and fixed in code.
- No `baseUrl` runtime configuration or endpoint environment variables exist, reducing the application-level arbitrary-target / SSRF surface.
- Native `fetch` enforces `redirect: "error"` to reject redirection attempts.

### 2.2 Model Selection & Constraints
- **Provider**: `"OPENAI"`
- **Model**: `"gpt-5.6-luna"` exclusively.
- **Model Rationale**: `gpt-5.6-luna` is selected as the cost-sensitive current production model for this Phase 5E V1 workload. With `reasoning: { effort: "none" }`, it provides low overhead for structured e-commerce catalog categorization, attribute mapping, anomaly review, and parser diagnostic advisory tasks.
- **Explicit Non-Claims**:
  - Does NOT claim lowest-cost OpenAI model across all tiers.
  - Does NOT claim sub-second guaranteed latency.
  - Does NOT claim AI output determinism.
  - Does NOT claim fixed URL prevents DNS poisoning.

### 2.3 Responses Request Payload
The request payload conforms strictly to the OpenAI Responses API specification:
```json
{
  "model": "gpt-5.6-luna",
  "instructions": "<request.systemInstruction>",
  "input": "<request.prompt>",
  "store": false,
  "max_output_tokens": 800,
  "truncation": "disabled",
  "reasoning": {
    "effort": "none"
  },
  "text": {
    "format": {
      "type": "json_schema",
      "name": "semantic_intelligence_response",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "schemaVersion": { "type": "integer", "enum": [1] },
          "taskKind": { "type": "string", "enum": ["<request.taskKind>"] },
          "selectedCandidateId": { "type": ["string", "null"] },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "explanationSummary": { "type": "string" },
          "evidenceRefs": { "type": "array", "items": { "type": "string" } }
        },
        "required": [
          "schemaVersion",
          "taskKind",
          "selectedCandidateId",
          "confidence",
          "explanationSummary",
          "evidenceRefs"
        ],
        "additionalProperties": false
      }
    }
  }
}
```
- `store: false`: `store: false` instructs the Responses API not to store the response object for later retrieval/stateful continuation. It does not independently redefine all OpenAI platform retention, abuse-monitoring, or prompt-caching policies.
- Excluded primitives: No `messages`, no `response_format`, no `max_tokens`, no `temperature`, no `tools`, no `previous_response_id`, no `conversation`, and no metadata containing source or product details.

---

## 3. Operational Modes & Lifecycle

| Mode | Complete Calls | Dry Run Checks | Network Dispatches | Process Budget | Rate Limiter | Circuit State | Request & Privacy Validation | Network Dispatch |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`DISABLED`** (Default) | Increments | 0 | 0 | 0 | Unaffected | Unaffected | Skipped (Immediate Short-Circuit) | None (Throws safe error) |
| **`DRY_RUN`** | Increments | Increments | 0 | 0 | Unaffected | Unaffected | Full Validation | None (Throws safe dry-run error) |
| **`LIVE`** | Increments | 0 | Increments | Consumes 1 slot | Consumes 1 slot | Health-tracked | Full Validation | Dispatches to Responses API |

- **`DISABLED` Short-Circuit**: In `DISABLED` mode, `completeCalls` increments first, and then the provider immediately throws a fixed safe error. No request envelope parsing, privacy scanning, or text budget checking is performed, and no budget, rate limiter, or circuit states are mutated.
- **`DRY_RUN` Execution**: Performs complete request envelope validation, canonical privacy checks, and request text budget bounds without consuming live rate limits, process budgets, or network dispatches.
- **Safe Enablement**: Setting `OPENAI_API_KEY` in the environment never enables `LIVE` mode automatically. `AI_PROVIDER_MODE=LIVE` must be set explicitly.

---

## 4. Secret Credential & Config Separation

1. **Public Configuration & Resolver (`resolveLiveProviderConfig`, `resolveLiveProviderConfigFromEnv`)**:
   - `resolveLiveProviderConfigFromEnv(env)` returns strictly `LiveProviderConfig`. It never returns `OPENAI_API_KEY`.
   - Contains: `mode`, `provider`, `model`, `maxOutputTokens`, `maxRequestTextChars`, `maxRequestsPerWindow`, `windowMs`, `maxRequestsPerProcess`, `failureThreshold`, `cooldownMs`.
   - Immutable and deep-frozen upon resolution.
   - Exposed via `getConfig()`. Never contains credentials.
   - `getUsageSnapshot()` contains zero credentials, prompts, or untrusted payload data.
2. **Private Credential Isolation**:
   - The factory `createLiveAiProviderFromEnv(env, dependencies?)` acquires `env.OPENAI_API_KEY` privately and passes it to the `LiveAiProvider` constructor.
   - In `LIVE` mode, the constructor enforces a non-null, non-blank string key, throwing a fixed `SemanticConfigurationError` without echoing the key. `DISABLED` and `DRY_RUN` modes permit a null key.
   - Credential is stored in a private class field (`#apiKey`).
   - Never exposed in configuration snapshots, usage snapshots, error messages, or logs.

---

## 5. Defense-in-Depth Privacy Gate

The `LiveAiProvider` enforces strict runtime checks on `request.untrustedData` before any network or mode processing in `DRY_RUN` and `LIVE` modes:
1. **Request Envelope Integrity**: Verifies non-null plain object, absence of symbol keys, exact required Phase 5A keys, non-blank strings, 64-char lowercase hex `requestId`, genuine `AbortSignal` instance, and dense ID arrays without duplicates.
2. **Task Kind Binding**: `untrustedData.taskKind` must strictly equal `request.taskKind`.
3. **Canonical Required Fields**:
   - `CATEGORY_MAPPING`: `taskKind`, `productTitle`, `candidates`, `evidence`.
   - `ATTRIBUTE_MAPPING`: `taskKind`, `sourceSpecificationKey`, `sourceSpecificationValue`, `candidates`, `evidence`.
   - `ANOMALY_REVIEW`: `taskKind`, `productTitle`, `selectedCategoryPath`, `evidence`.
   - `PARSER_RECOVERY_SUGGESTION`: `taskKind`, `urlPath`, `diagnosticLabels`, `failureSignals`, `evidence`.
4. **Nested Shapes**: Enforces dense arrays and exact allowed property shapes on `candidates`, `evidence`, and `sourceSpecifications`.
5. **Structural Property-Name Scanner**:
   - Recursively inspects **property keys** for forbidden names (`password`, `token`, `cookie`, `authorization`, `auth`, `secret`, `apikey`, `session`, `rawhtml`, `html`, `browserstorage`, `executionpayload`, `privatekey`).
   - Distinguishes keys from values: a string value such as `productTitle: "Security Token Dispenser"` is valid and accepted.
6. **Allowlist Consistency**:
   - For mapping tasks: candidate IDs in `untrustedData.candidates` must match `request.allowedCandidateIds` in canonical code-unit order.
   - For non-mapping tasks: `request.allowedCandidateIds` must be empty.
   - For all tasks: evidence IDs in `untrustedData.evidence` must match `request.allowedEvidenceIds` in canonical code-unit order.

---

## 6. Budget, Rate Limiting & Circuit Protection

1. **Request Text Budget**:
   - Compares `request.systemInstruction.length + request.prompt.length` against `maxRequestTextChars` (default: 16,000 chars; bounds: 500..50,000).
   - This is a deterministic character bound, not an exact token count.
   - Fails fast before network if exceeded.
2. **Process Request Budget**:
   - Finite ceiling (`maxRequestsPerProcess`, bounds: 1..100,000; default: 1,000).
   - Once reached, subsequent calls fail fast without network.
3. **Sliding-Window Rate Limiter**:
   - Tracks live network dispatch attempts over `windowMs` (default: 60,000 ms, limit: 60).
   - Uses an injected `Clock` (`Date.now()` in production, `FakeClock` in tests).
   - Slots are reserved synchronously immediately before `fetch`.
4. **Circuit Breaker**:
   - States: `CLOSED`, `OPEN`, `HALF_OPEN`.
   - Health failures that trip the circuit: transport failures, DNS errors, connection drops, `request.signal` aborts/timeouts after dispatch, HTTP 429, and HTTP 5xx.
   - Local validation failures and HTTP 4xx (e.g. 400, 401, 403) fail safely but do not trip the circuit.
   - `HALF_OPEN` permits strictly **one concurrent probe** via `halfOpenProbeInFlight`. Secondary requests while the probe is in flight fail fast.
   - All state is process-local and in-memory; process restart resets controls.

---

## 7. Raw Responses Envelope & Output Extraction Contract

1. **HTTP Status Handling**:
   - HTTP 429 and 5xx increment health failures and circuit counters.
   - HTTP 4xx client errors fail closed safely without tripping the circuit.
2. **Sequential Root Validation Order**:
   - **Step A (Raw Record)**: Validates raw JSON is a strict plain object.
   - **Step B (Identity Validation)**: Verifies minimum Responses resource identity (`root.object === "response"` and own `status` field). Does not reject non-null `error` before usage accounting.
   - **Step C (Authoritative Usage Accounting)**: Validates and records authoritative `usage` tokens (`recordUsage`) or records missing usage (`recordMissingUsage`) exactly once before evaluating semantic error or status. Malformed usage fails immediately with `"OpenAI provider usage response was malformed."` without mutating token counters.
   - **Step D (Response Error Inspection)**: Evaluates own `error` field after usage accounting. If `root.error != null`, fails closed with fixed message `"OpenAI provider response contained an error."`. The error object itself remains untrusted and is never exposed (no `code`, `message`, or raw error body).
   - **Step E (Status Evaluation)**: Requires `status === "completed"`. Status `incomplete` (including `max_output_tokens` reason) and statuses `failed`, `cancelled`, `queued`, `in_progress` fail closed safely.
3. **One Exact Output Extraction Algorithm**:
   - Inspects `root.output` dense array.
   - Ignores support items with `type === "reasoning"`.
   - Rejects tool or search output items.
   - Requires exactly ONE assistant message (`type === "message"`, `role === "assistant"`, `status === "completed"`).
   - In assistant message content: rejects refusals; requires exactly ONE `output_text` content item with primitive non-blank string.
   - Returns strictly `{ rawText: extractedText }` to Phase 5A.

---

## 8. Usage Accounting Subtotal Semantics

1. **Decoupled Telemetry**:
   - Accessible via `provider.getUsageSnapshot()`.
   - Never exposed through `SemanticProviderResponse`.
2. **Subtotal vs Missing Distinction**:
   - `reportedInputTokens`, `reportedOutputTokens`, and `reportedTotalTokens` are subtotals strictly representing requests that returned authoritative OpenAI `usage` objects.
   - Responses with missing or null `usage` increment `usageMissingRequests`. Missing tokens are never fabricated as 0.
   - Malformed usage fails the response to prevent ledger contamination.
   - No local heuristic token estimation is performed.
3. **Usage Accounting Independent of Semantic Acceptance**:
   - Usage accounting occurs after identifying a valid Responses resource (`object === "response"` with `status` field) and before semantic/status acceptance.
   - A provider Response that contains a valid authoritative `usage` object may contribute usage even when:
     - `error` is non-null
     - `status` is failed/incomplete
     - output is later rejected
     because provider consumption may already have occurred.
   - The error object itself remains untrusted and is never exposed.
   - `successfulNetworkResponses` increments only for fully accepted completed output.
   - `failedNetworkResponses` covers dispatched responses that fail adapter acceptance (incremented exactly once per failure).

---

## 9. Own-Property Trust Boundaries & Prototype Defense

To prevent prototype pollution and unauthorized property inheritance from satisfying security contracts, Phase 5E enforces strict own-property boundaries using `hasOwn(obj, key)` (`Object.prototype.hasOwnProperty.call`) across all data layers:

1. **Request Envelope Ownership**:
   - `validateRequestEnvelope` verifies that the own enumerable key set matches exactly: `requestId`, `taskKind`, `prompt`, `systemInstruction`, `untrustedData`, `allowedCandidateIds`, `allowedEvidenceIds`, `signal`.
   - Inherited properties cannot satisfy required envelope fields.
   - Unknown own property substitutions are strictly rejected.
2. **Configuration Own-Property Resolution**:
   - `resolveLiveProviderConfig` inspects own properties on caller config objects.
   - Inherited configuration properties do not override defaults.
   - Unknown own configuration keys trigger descriptive errors.
3. **Canonical untrustedData Ownership**:
   - Required canonical fields (`productTitle`, `candidates`, `evidence`, etc.) must be own properties of `untrustedData`.
   - Candidate required fields (`id`, `name`) and optional fields (`description`, `parentId`, `path`) are read only when owned.
   - Evidence required fields (`id`, `text`) must be own properties, with no extra properties allowed.
   - Source specifications (`key`, `value`) must be exact own properties.
4. **Response Envelope & Output Ownership**:
   - Response root required fields (`object`, `status`, `output`) must be own properties.
   - Optional fields (`error`, `usage`, `incomplete_details`) are evaluated strictly from own properties.
   - Authoritative usage tokens (`input_tokens`, `output_tokens`, `total_tokens`) must be own properties with finite non-negative integers.
   - Assistant message items (`type`, `role`, `status`, `content`) and output text items (`type`, `text`) must have own property authority.
5. **Safe Error Regression**:
   - Upstream response body, error messages, API keys, prompt text, and raw HTTP status codes are never echoed in thrown error messages.
