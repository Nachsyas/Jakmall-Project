# PROJECT CHECKLIST

## Intelligent Product Sync Platform

Last Audit:
2026-08-30

Current Phase:
PHASE 3 — ONE-PRODUCT END-TO-END (STATE B CERTIFIED)

Overall Status:
PHASE 3 DONE [x] — STATE B: PLATFORM-ACCESS-LIMITED E2E

## EXECUTIVE SUMMARY

Total Phase 3 Items: 16
Done: 16
Partial: 0
Todo: 0
Blocked: 0

P0 Remaining: 0

Current Blocking Phase:
None.

Phase 3 is completed under State B because legitimate live Shopee publication
credentials / verified remote transport were not available during this phase.

Next Recommended Task:
Phase 4 — Persistence, job state, history, and continuous synchronization foundation.

---

## AUTHORITATIVE SOURCE PROVENANCE REGISTRY

| Fixture Key | Classification | Authoritative Source URL | Capture Timestamp | Product ID | Authoritative External SHA-256 Hash |
|---|:---:|---|:---:|:---:|---|
| `acmic.html` | `SANITIZED_REAL` | `https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118` | 2026-08-29 01:06:00 WIB | `6970238281488` | `087b8457fa2ea2128b7335493f62bf04037836d0355f6bb35c019760a1f76f5d` |
| `momo.html` | `SANITIZED_REAL` | `https://www.jakmall.com/shopping-mania/momo-celana-panjang-cargo-pria-tactical-waterproof-polyester-cotton-ap78#2715227285879` | 2026-08-29 01:06:00 WIB | `7372731614335` | `93b8039c4c438d8b87ad5dc2e73f431ac8d44d209fe38b6d0e688fbb92f67742` |
| `asv.html` | `SANITIZED_REAL` | `https://www.jakmall.com/lstore/jas-hujan-asv-versi-1-kualitas-no1-rubber-press#3813346585186` | 2026-08-29 01:06:00 WIB | `2389444540861` | `925ac2680479d0d44a605a10ff694c64c32d2b8c19aa2dc229a414f20cd4dc48` |

- **Sanitization Boundary:** Only session cookies, CSRF tokens, cart sync state, third-party analytics pixels (Facebook Pixel, Hotjar), and global site header/footer chrome were removed.
- **External Hash Rule:** Whole-file hashes live strictly externally in `tests/fixtures/README.md` and this registry; no self-referential hash comments exist inside fixture files.
- **Acceptance-Critical Value Integrity:** Product IDs, SKU IDs, merchant SKUs, display SKUs, variant names, matrix structures, prices, stock flags, `limited_stock` values, weights, and image links were preserved from literal captured JakMall HTML/SPDT state without reconstruction.

---

## REMEDIATED SOURCE ENGINE DISCREPANCIES

1. **Authoritative Source URLs**
   - ACMIC URL uses `/acmic-official-store/...#5502951494118`.
   - MOMO URL uses `/shopping-mania/...#2715227285879`.
   - ASV URL uses `/lstore/...#3813346585186`.

2. **ACMIC Literal Raw Prices & Stock**
   - SKU `5502951494118` — CPD65 PRO Only:
     `price.final = 379000`,
     `in_stock = true`,
     `is_limited_stock = true`,
     `limited_stock = 3`.
   - SKU `7340637866967` — CPD65 PRO + Kabel:
     `price.final = 449000`,
     confirmed out of stock.
   - SKU `9480799845218` — CPD65 LITE Only:
     `price.final = 299000`,
     confirmed out of stock.
   - DUO variants:
     `price.final = 399000`,
     confirmed out of stock.

3. **SKU Display Rule**
   - Artificial labels such as `CPD65-PRO` are not used.
   - Raw JakMall `sku_display` may equal the numeric source SKU ID.

4. **Unknown / Undisclosed Stock Rule**
   - `available = true`, `exact = false`, `quantity = undefined`
     means the source confirms availability but does not disclose an exact quantity.
   - Phase 2 preserves that fact without inventing a number.
   - Destination inventory decisions belong to Phase 3 policy / operator configuration.

5. **Type Safety**
   - Explicit `as any` usage was removed from source parsing / normalization logic.
   - Current audit confirms 0 explicit `any` occurrences in `src/`.

6. **JSON-LD Support**
   - Plain and namespaced schema.org forms are supported.
   - `Offer`, `AggregateOffer.lowPrice`, nested `offers[]`, and invalid price paths are tested.

7. **Image Normalization**
   - Image priority follows:
     `detail > thumbnail > icon`.
   - URL deduplication and sequential position behavior are covered by tests.

---

## PHASE 2 POST-REPAIR VALIDATION

- **Date:** 2026-08-29
- **`npm test`:** PASS — 21 tests at the Phase 2 certification point.
- **`npm run typecheck`:** PASS.
- **Explicit `any`:** 0 in `src/`.
- **ACMIC:** PASS — 9 SKUs.
- **MOMO:** PASS.
- **ASV:** PASS — 6 valid combinations.

---

## PHASE 2 TASKS

### Source Engine Repair & Validation

- [x] P0 Fix JakMall raw SKU schema & source identity
- [x] P0 Fix preorder null handling
- [x] P0 Implement real variant matrix resolution with `previous` dimension ordering
- [x] P0 Enforce strict stock semantics with UNKNOWN disambiguation
- [x] P0 Enforce strict price safety at canonical boundary
- [x] P0 Add authentic sanitized-real golden fixtures with authoritative provenance
- [x] P1 Expand JSON-LD fallback and cross-validation
- [x] P1 Implement HTML specification extraction
- [x] P1 Transform `scripts/test-jakmall.ts` into a diagnostic utility
- [x] P1 Realign documentation and project manifest
- [x] P0 Pass Phase 2 Acceptance Gate

---

## PHASE 2 ACCEPTANCE GATE AUDIT — 17/17 PASS

| # | Acceptance Gate Condition | Status | Evidence |
|---|---|:---:|---|
| 1 | `npm run typecheck` passes | PASS | 0 errors |
| 2 | Phase 2 test suite passes | PASS | 21/21 at Phase 2 certification |
| 3 | ACMIC fixture passes | PASS | Literal IDs, prices, and stock |
| 4 | MOMO fixture passes | PASS | Literal product/SKU/price data |
| 5 | ASV fixture passes | PASS | Six valid source combinations |
| 6 | ACMIC resolves exactly 9 source SKUs | PASS | `canonical.variants.length === 9` |
| 7 | ASV resolves exactly 6 combinations | PASS | Size × color matrix |
| 8 | MOMO resolves XL + Hitam | PASS | Correct dimension mapping |
| 9 | `sku = null` does not break extraction | PASS | ACMIC and ASV |
| 10 | `pre_order = null` does not break extraction | PASS | Normalized safely |
| 11 | Missing price never silently becomes zero | PASS | Strict price errors |
| 12 | Missing inventory does not silently become available | PASS | UNKNOWN preserved |
| 13 | Unknown quantity remains unknown | PASS | `quantity = undefined` |
| 14 | Image priority / deduplication tested | PASS | Normalizer tests |
| 15 | Source identity fields are distinct | PASS | source / merchant / display SKU |
| 16 | Documentation reflects implementation | PASS | Project docs and manifest |
| 17 | Checklist updated | PASS | Phase 2 evidence retained |

---

## PHASE 3 BASELINE

- **Baseline Date:** 2026-08-29
- **Phase 2 Acceptance Gate:** 17/17 PASS.
- **Baseline Tests:** 21 PASS.
- **TypeScript:** PASS.
- **`git diff --check`:** PASS.

---

# PHASE 3 — ONE-PRODUCT END-TO-END

## Mission

Implement one truthful end-to-end marketplace preparation flow:

`JakMall → CanonicalProduct → Marketplace Mapping → Deterministic Policy → ShopeeListingDraft → Validation → Human Review → Dry Run / Authorized Publish Boundary → Verification`

Phase 3 intentionally does not introduce Phase 4 persistence, queues,
continuous synchronization, dashboard state, or AI supervision.

---

## PHASE 3 TASKS

- [x] P0 Audit Shopee integration access and document external-access limitations
- [x] P0 Define source-agnostic `MarketplaceAdapter`
- [x] P0 Define internal `ShopeeListingDraft` separately from `CanonicalProduct`
- [x] P0 Implement deterministic integer-IDR pricing policy
- [x] P0 Implement strict inventory policy for exact, undisclosed, blocked, OOS, and UNKNOWN inventory
- [x] P0 Implement rule-based / manual category and attribute mapping
- [x] P0 Implement Shopee draft builder without CanonicalProduct mutation
- [x] P0 Implement human review model (`APPROVE`, `REJECT`, `EDIT_REQUIRED`)
- [x] P0 Implement dry-run and authorized publication boundary
- [x] P0 Implement read-after-write verification model
- [x] P0 Define marketplace idempotency key foundation
- [x] P0 Implement end-to-end diagnostic CLI
- [x] P0 Add comprehensive automated tests
- [x] P1 Document environment configuration without secrets
- [x] P1 Align Phase 3 docs and project status with verified truth
- [x] P0 Pass Phase 3 State B Acceptance Gate

---

## PHASE 3 INVENTORY POLICY CONTRACT

Destination inventory behavior must preserve source truth.

### Confirmed Out of Stock

```text
source:
available = false
quantity = 0

destination:
destinationQuantity = 0
policy = out_of_stock_zero
status = resolved