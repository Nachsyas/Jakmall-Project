# Phase 5B: Category & Attribute Intelligence Specification

## 1. Executive Summary & Core Boundaries

Phase 5B provides deterministic-first catalog mapping resolution for categories and attributes. It acts as an auditable domain layer sitting between deterministic verified mappings and the advisory Phase 5A Semantic Intelligence kernel.

### Strict Safety Invariants
- **Zero Mutation Authority**: Phase 5B has zero authority over source data, prices, markup, stock, SKU identity, database persistence, queue state, marketplace execution, or parser mutations.
- **Zero Database / Network Dependencies**: The verified mapping store is defined as an abstract interface (`VerifiedCatalogMappingStore`); no direct database connections or external HTTP clients exist in the module.
- **Pure In-Memory Calculations**: All operations are deterministic, in-memory evaluations.
- **No Correctness Guarantee**: Phase 5B does not guarantee universal taxonomy correctness; suggestions require human review (`reviewRequired: true`).

---

## 2. Deterministic Resolution Order

Resolution follows a strict hierarchical order:

```
                  Caller Request
                        ↓
            Input Validation & Copy
          (Caller raw objects unfrozen)
                        ↓
         Safe Deterministic Source Key?
          ├─ None (Category no path) → sourceKey = null → Skip Store → Phase 5A
          └─ Present → Deterministic Normalization (NFKC, lowercase, collapse ws)
                        ↓
          Query VerifiedCatalogMappingStore
                        ↓
       Runtime Trust Boundary Validation
          ├─ Store Throws → BLOCKED_FOR_REVIEW (VERIFIED_MAPPING_STORE_FAILURE, 0 AI)
          ├─ Malformed Record → BLOCKED_FOR_REVIEW (INVALID_VERIFIED_MAPPING_RECORD, 0 AI)
          └─ Valid Records
                 ↓
       Filter verified === true Records
          ├─ Multiple Distinct Targets → BLOCKED_FOR_REVIEW (CONFLICTING_VERIFIED_MAPPING, 0 AI)
          ├─ Single Target NOT in Candidates → BLOCKED_FOR_REVIEW (STALE_VERIFIED_TARGET, 0 AI)
          ├─ Single Target IN Candidates → RESOLVED (VERIFIED_STORE_MATCH, risk: LOW, 0 AI)
          └─ Zero Verified Records
                 ↓
          Phase 5A Semantic Intelligence Service (Fallback, max 1 call)
                 ↓
          Conservative Outcome Translation
```

---

## 3. Verified Store Trust Boundary

Records returned by `VerifiedCatalogMappingStore` are treated as external and untrusted at runtime:
1. **Response Array Invariant**: The returned result must be an array; length must not exceed `MAX_RAW_STORE_RECORDS` (50). Non-array or oversize responses fail closed immediately.
2. **Record Schema**: Every record must be a plain object with zero symbols and exact allowed property set (no `updatedAt` or extraneous properties).
3. **Canonical Candidate ID**: Both category and attribute mapping records use exclusively `targetCandidateId: string`, matching `candidate.id` in caller allowlist. Candidate IDs are never synthesized or constructed from compound identifiers.
4. **Finite Target Candidate Bound**: `targetCandidateId` length must be a finite positive string bounded by Phase 5A semantic configuration (`maxTextChars`). Oversized target candidate IDs fail closed as `INVALID_VERIFIED_MAPPING_RECORD` before any AI fallback.
5. **Key Normalization Verification**: The returned source key must normalize strictly to the queried normalized key (`normalizeLookupKey(key) === expectedNormalizedKey`). Mismatches fail closed as `INVALID_VERIFIED_MAPPING_RECORD`.
6. **Copy-Then-Freeze**: Validated records are cloned into fresh objects and recursively frozen with `deepFreeze()`. Store-owned objects are never mutated and never frozen.

---

## 4. Nullable Source Key Semantics

- In `CategoryMappingRequest`, `sourceCategoryPath` is optional.
- If omitted, `CatalogMappingResult.sourceKey` is `null`.
- The service does NOT infer or fabricate a source key from `productTitle`, `description`, `brand`, or `categoryHints`.
- Store lookup is bypassed (0 store queries).
- Execution proceeds directly to Phase 5A semantic evaluation.
- `AttributeMappingRequest` strictly requires `sourceSpecificationKey` and `sourceSpecificationValue`; its `sourceKey` is always a non-blank string.

---

## 5. Preservation of Phase 5A Failure Semantics

When falling back to Phase 5A, semantic failure codes are preserved distinctly in `CatalogMappingReasonCode`:
- `INPUT_REJECTED` → `SEMANTIC_INPUT_REJECTED`
- `PROVIDER_UNAVAILABLE` → `SEMANTIC_PROVIDER_UNAVAILABLE`
- `INVALID_PROVIDER_OUTPUT` → `SEMANTIC_INVALID_PROVIDER_OUTPUT`
- `DETERMINISTIC_RESOLVER_FAILURE` → `SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE`

When Phase 5A resolves deterministically via its local rule resolver (`RESOLVED_DETERMINISTICALLY`), Phase 5B translates this to:
- `status: "RESOLVED"`
- `reasonCode: "DETERMINISTIC_RULE_MATCH"`
- `resolutionSource: "DETERMINISTIC_RULE"`
- `risk: "LOW"`
- `reviewRequired: false`

In `translateSemanticResult()`, dependency-owned `sem.evidenceRefs` is explicitly copied before creating the frozen `CatalogMappingResult`, ensuring dependency arrays remain unfrozen and unmutated.

---

## 6. Strict Attribute productTitle Semantics

In `AttributeMappingRequest`, `productTitle` is optional and is NEVER fabricated or substituted from `sourceSpecificationKey`, `sourceSpecificationValue`, or any other field:
- **Omitted / Undefined**: If caller omits `productTitle` or supplies `productTitle: undefined`, the property is strictly omitted from the canonical semantic payload.
- **Valid String**: If caller supplies a valid non-blank string, it is passed to Phase 5A validation as-is.
- **Invalid Supplied Value**: If caller supplies an invalid value (e.g. numeric, blank whitespace string, null, object), it is passed to Phase 5A validation which fails closed with `INPUT_VALIDATION_ERROR` (0 store queries, 0 provider calls). Invalid supplied values are NEVER silently treated as absent or dropped.
