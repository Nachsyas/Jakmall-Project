# Phase 5C: Anomaly & Review Intelligence Specification

## 1. Executive Summary & Core Boundaries

Phase 5C provides deterministic anomaly detection and gated semantic review for catalog listings. It evaluates structural integrity across catalog mappings and product variant configurations.

### Strict Safety Invariants
- **Zero Mutation Authority**: Phase 5C has zero authority over listing publication, stock adjustments, pricing rules, SKU identity, database persistence, queue state, marketplace execution, or parser mutations.
- **Monotonic Review Safety**: AI output is strictly advisory and cannot authoritatively alter review severity. AI cannot create a hard block (`BLOCKED_FOR_REVIEW`) and cannot clear an existing `NEEDS_REVIEW`.
- **Pure In-Memory Evaluation**: Zero timestamps, zero `Date.now()`, zero `new Date()`, zero `evaluatedAtIso`.
- **No Self-Healing / Auto-Approval**: Anomaly review provides findings for human operators; it never automatically approves or fixes data.

---

## 2. Review Architecture & Minimized Trust Surface

```
                     Caller ProductReviewInput
                                ↓
                 Input Trust Boundary Validation
               (Exact field allowlist, bounded arrays)
                                ↓
                 Copy to Fresh Trusted Snapshot
                   (Caller objects unfrozen)
                                ↓
                 Deterministic Anomaly Detector
                                ↓
                     Deterministic Status:
          ├─ NO_REVIEW_TRIGGERED → Return (0 AI calls)
          ├─ BLOCKED_FOR_REVIEW → Return (0 AI calls)
          └─ NEEDS_REVIEW
                 ↓
          Eligible Semantic Trigger Present?
          ├─ No (Structural only: Duplicate/Blank Label) → Preserve NEEDS_REVIEW (0 AI calls)
          └─ Yes (SUSPECTED_ANOMALY, MAPPING_REVIEW, LOW_CONFIDENCE)
                 ↓
          Semantic Context Present? (productTitle + selectedCategoryPath)
          ├─ Missing/Blank → Preserve NEEDS_REVIEW, No Fabrication (0 AI calls)
          └─ Available → Dispatch at most 1 ANOMALY_REVIEW call
                 ↓
          Attach Inert Advisory Summary & Optional Fixed INFO Finding
          Status Remains NEEDS_REVIEW (Monotonic Invariant)
```

---

## 3. Minimized Review Mapping Snapshot

To minimize trust surface, `ProductReviewInput.mappingResults` validates against an exact minimized projection (`ReviewMappingSnapshot`):
- `taskKind`: `"CATEGORY" | "ATTRIBUTE"`
- `sourceKey`: `string | null`
- `status`: `CatalogMappingStatus`
- `selectedCandidateId`: `string | null`
- `resolutionSource`: `"VERIFIED_STORE" | "DETERMINISTIC_RULE" | "AI" | "NONE"`
- `confidence`: `number | null` (finite number in `[0, 1]`)
- `risk`: `"LOW" | "MEDIUM" | "HIGH" | null`
- `reviewRequired`: `boolean`
- `reasonCode`: `CatalogMappingReasonCode`

### Cross-Field State Coherence & Invariants
Review mapping snapshots validate strictly against one of 7 legitimate Phase 5B state families:
- **Family A (Verified Store Match)**: `RESOLVED` + `VERIFIED_STORE` + `VERIFIED_STORE_MATCH` + candidate + `confidence: 1.0` + `risk: LOW` + `reviewRequired: false`
- **Family B (Deterministic Rule Match)**: `RESOLVED` + `DETERMINISTIC_RULE` + `DETERMINISTIC_RULE_MATCH` + candidate + `confidence: 1.0` + `risk: LOW` + `reviewRequired: false`
- **Family C (AI Suggestion)**: `SUGGESTED` + `AI` + `AI_SUGGESTION` + candidate + finite confidence + exact authoritative risk + `reviewRequired: true`
- **Family D (Unresolved AI Mapping)**: `NEEDS_REVIEW` + `AI` + `UNRESOLVED_NO_CANDIDATE` + `candidate: null` + finite confidence + exact authoritative risk + `reviewRequired: true`
- **Family E (Verified Store Blocks)**: `BLOCKED_FOR_REVIEW` + `VERIFIED_STORE` + (`CONFLICTING_VERIFIED_MAPPING` | `STALE_VERIFIED_TARGET`) + `candidate: null` + `confidence: null` + `risk: HIGH` + `reviewRequired: true`
- **Family F (Store Failure / Input Blocks)**: `BLOCKED_FOR_REVIEW` + `NONE` + (`VERIFIED_MAPPING_STORE_FAILURE` | `INVALID_VERIFIED_MAPPING_RECORD` | `INPUT_VALIDATION_ERROR`) + `candidate: null` + `confidence: null` + `risk: HIGH` + `reviewRequired: true`
- **Family G (Phase 5A Failure Blocks)**: `BLOCKED_FOR_REVIEW` + `NONE` + (`SEMANTIC_INPUT_REJECTED` | `SEMANTIC_PROVIDER_UNAVAILABLE` | `SEMANTIC_INVALID_PROVIDER_OUTPUT` | `SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE`) + `candidate: null` + `confidence: null` + `risk: null` + `reviewRequired: true`

#### Exact Source-Key State Coherence
1. **Verified Store Requires Source Key**: Any mapping with `resolutionSource === "VERIFIED_STORE"` MUST have non-null `sourceKey`.
2. **Store Failures Require Source Key**: Mappings with reason codes `VERIFIED_MAPPING_STORE_FAILURE` or `INVALID_VERIFIED_MAPPING_RECORD` require non-null `sourceKey` because the store is only queried when a deterministic source key exists.
3. **Attribute Non-Input Results Require Source Key**: For `taskKind === "ATTRIBUTE"`, `sourceKey` may be `null` ONLY for `INPUT_VALIDATION_ERROR`. All other legitimate Attribute results MUST have a non-null `sourceKey`.

#### Exact AI Risk / Confidence Coherence
For AI mapping snapshots (Families C and D), `risk` is evaluated against Phase 5A's authoritative deterministic policy `computeDeterministicRisk(semanticTaskKind, confidence, selectedCandidateId, "AI")`. The snapshot `risk` must match this expected risk exactly. Incoherent risk levels (e.g. `confidence: 0.70` with `risk: MEDIUM` or `confidence: 0.90` with `risk: HIGH`) fail closed.

#### Finite Candidate ID & Context Bounds
- `selectedCandidateId` if non-null must not exceed `semConfig.maxTextChars` from Phase 5A configuration.
- Individual text fields in semantic context (`sourceSpecifications` key/value, `evidence` id/text) are also bounded by `semConfig.maxTextChars`.
- Domain fields retain explicit safety bounds: `sourceKey` (500), `variantLabel` (500), finding message (1000), suspected anomaly reason (1000).

---

## 4. Bounded Execution & Cost Invariants

- **MAX_FINDINGS**: Maximum 100 findings enforced before return. If baseline findings already reach 100, semantic AI review is skipped (cost boundary).
- **MAX_REASON_MESSAGE_LENGTH**: 1000 characters enforced on all finding messages and suspected anomaly reasons.
- **Copy-Then-Freeze**: Caller raw input objects and arrays remain untouched and unfrozen. Internal trusted snapshots and return results are deeply frozen.

---

## 5. Deterministic Finding Identity & Conflict Grouping

### Structured Finding Identity
- **Base Identity**: `${code}:${field ?? ""}`
- **Extended Identity**: `${code}:${field ?? ""}:${deterministicSubject}` where a structured subject (e.g. candidate ID, reason code, or duplicate value) is appended for cases where two logically distinct findings on the same code and field would otherwise collide.
- Deduplication retains the first occurrence of each distinct identity key.
- Findings are stably sorted using UTF-16 code-unit comparisons (`a < b ? -1 : a > b ? 1 : 0`). Zero `localeCompare`.

### Mapping Conflict Grouping
- Mapping conflict detection groups by composite tuple: `(taskKind, sourceKey)`.
- Mappings with `sourceKey: null` are excluded from deterministic-key conflict grouping.
- Category and Attribute mappings sharing the same textual key do NOT conflict.

---

## 6. Blank Variant Label Semantics

- If `variantLabels` is supplied, each item must be a string.
- Blank and whitespace-only strings are explicitly permitted through structural parsing so that `DeterministicAnomalyDetector` can emit `BLANK_VARIANT_LABEL` (severity: `REVIEW`).
- Non-string items fail input validation.
- Missing `variantLabels` emits no finding.
- Blank variant label findings are structural-only and trigger 0 AI calls.

---

## 7. Monotonic Safety & Inert AI Text

- AI anomaly evaluation cannot author:
  - Severity (`BLOCK`, `REVIEW`)
  - Status transitions
  - Reason codes
  - Publishing commands
- On successful semantic anomaly review, Phase 5C attaches at most one local informational finding:
  - `code: "AI_ANOMALY_ANNOTATION"`
  - `severity: "INFO"`
  - `message`: Inert text copied from `explanationSummary`.
- If the AI provider fails, times out, or returns invalid output, the review status remains `NEEDS_REVIEW` with `advisorySummary: null`.
