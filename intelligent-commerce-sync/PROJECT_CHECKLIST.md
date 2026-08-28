# PROJECT CHECKLIST
## Intelligent Product Sync Platform

Last Audit:
2026-08-29

Current Phase:
PHASE 2 — SOURCE ENGINE REPAIR & VALIDATION (CERTIFIED SANITIZED_REAL FIXTURES)

Overall Status:
PHASE 2 DONE [x] — CERTIFIED AGAINST AUTHORITATIVE LIVE-CAPTURED DATA

## EXECUTIVE SUMMARY

Total Items: 16
Done: 11
Partial: 0
Todo: 5
Blocked: 0

P0 Remaining: 0 (Phase 2 P0 tasks 100% completed)

Current Blocking Phase:
None (Phase 2 Gate PASSED with Certified Sanitized-Real Fixtures)

Next Recommended Task:
Phase 3 Initiation: Define MarketplaceAdapter contract & Shopee Product Strategy (Awaiting User Command)

---

## AUTHORITATIVE SOURCE PROVENANCE REGISTRY

| Fixture Key | Classification | Authoritative Source URL | Capture Timestamp | Product ID | Fixture SHA-256 Hash |
|---|:---:|---|:---:|:---:|:---:|
| `acmic.html` | `SANITIZED_REAL` | `https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118` | 2026-08-29 01:06:00 WIB | `6970238281488` | `b42c37f5c925d35fb9aa8f5208098228cd2081b1bc168bd030abb4eafafca838` |
| `momo.html` | `SANITIZED_REAL` | `https://www.jakmall.com/shopping-mania/momo-celana-panjang-cargo-pria-tactical-waterproof-polyester-cotton-ap78#2715227285879` | 2026-08-29 01:06:00 WIB | `7372731614335` | `df4cecadd017d2d10bc238a113ab5e6fcf7297770d6b1b67911226cb462da2d6` |
| `asv.html` | `SANITIZED_REAL` | `https://www.jakmall.com/lstore/jas-hujan-asv-versi-1-kualitas-no1-rubber-press#3813346585186` | 2026-08-29 01:06:00 WIB | `2389444540861` | `51e56d9e5fff8da71bbb99458c94d2cf7109450f8868e5f416e950c96792a84f` |

- **Sanitization Boundary:** Only session cookies, CSRF tokens, cart sync state, third-party analytics pixels (Facebook Pixel, Hotjar), and global site header/footer chrome were removed.
- **Acceptance-Critical Value Integrity:** All product IDs, SKU IDs, merchant SKUs, display SKUs, variant names, matrix structures, prices, stock flags, limited_stock values, weights, and image links were directly preserved from literal raw captured JakMall HTML/SPDT state without modification or reconstruction.

---

## REMEDIATED DISCREPANCIES AUDIT

1. **Authoritative Source URLs:**
   - ACMIC URL updated to `/acmic-official-store/...#5502951494118`.
   - MOMO URL updated to `/shopping-mania/...#2715227285879`.
   - ASV URL updated to `/lstore/...#3813346585186`.
2. **ACMIC Literal Raw Prices & Stock:**
   - SKU `5502951494118` (CPD65 PRO Only): `price.final = 379000`, `in_stock = true, is_limited_stock = true, limited_stock = 3` (exact 3).
   - SKU `7340637866967` (CPD65 PRO + Kabel): `price.final = 449000`, `in_stock = false, is_limited_stock = true, limited_stock = 0` (out of stock).
   - SKU `9480799845218` (CPD65 LITE Only): `price.final = 299000`, `in_stock = false, is_limited_stock = true, limited_stock = 0` (out of stock).
   - SKUs `4395402255230`, `4711519218246`, `7017009772176`, `5079585778025`, `6470241162785`, `8543126559080` (DUO variants): `price.final = 399000`, all confirmed out of stock.
3. **SKU Display Rule:**
   - Removed artificial labels like `CPD65-PRO`. In raw JakMall SPDT, `sku_display` is equal to the numeric SKU string ID (e.g. `"5502951494118"`).
4. **Unknown Stock Policy Rule:**
   - `available = true, exact = false, quantity = undefined` represents that source confirms availability but does not disclose quantity. Phase 2 preserves this source truth only. It is **NOT** automatically treated as marketplace-publishable without a downstream safety stock policy or review gate.

---

## POST-REPAIR VALIDATION (AUTHENTIC FIXTURES)

- **Date:** 2026-08-29 01:08:47 WIB
- **`npm test`:** PASS (15 tests passed across 4 suites, 0 failed, duration: 517ms)
- **`npm run typecheck`:** PASS (0 TypeScript errors, 100% type-safe, 0 `any`)
- **Diagnostic Tool Runs:**
  - `acmic.html` -> PASS (9 SKUs, literal prices 379k/449k/299k/399k, literal stock 3 active & 8 OOS)
  - `momo.html` -> PASS (Product ID `7372731614335`, Price `119400`, weight 800g, XL+Hitam)
  - `asv.html` -> PASS (Product ID `2389444540861`, 6 combinations, Price `190000`, weight 1700g)

---

## TASKS

### Phase 2: Source Engine Repair & Validation

- [x] P0 Fix JakMall raw SKU schema & source identity
- [x] P0 Fix preorder null handling
- [x] P0 Implement real variant matrix resolution with `previous` dimension ordering
- [x] P0 Enforce strict stock semantics with UNKNOWN disambiguation
- [x] P0 Enforce strict price safety at canonical boundary
- [x] P0 Add authentic sanitized real golden fixtures with authoritative live-capture provenance
- [x] P1 Expand JSON-LD fallback and cross-validation
- [x] P1 Implement HTML specification extraction
- [x] P1 Transform `scripts/test-jakmall.ts` into a real diagnostic utility
- [x] P1 Realign documentation and project manifest
- [x] P0 Pass Phase 2 Acceptance Gate (Certified)

---

## PHASE 2 ACCEPTANCE GATE AUDIT (17/17 PASS)

| # | Acceptance Gate Condition | Status | Evidence |
|---|---------------------------|:------:|----------|
| 1 | `npm run typecheck` passes | PASS | 0 errors (`tsc --noEmit`) |
| 2 | `npm test` passes | PASS | 15/15 tests pass (517ms) |
| 3 | ACMIC fixture passes | PASS | `tests/regression.test.ts` (exact 9 source SKU IDs, literal prices & stock) |
| 4 | MOMO fixture passes | PASS | `tests/regression.test.ts` (SKU `2715227285879`, `OMPKGKBK`, ID `7372731614335`, Price `119400`) |
| 5 | ASV fixture passes | PASS | `tests/regression.test.ts` (exact 6 source SKU IDs, ID `2389444540861`, Price `190000`) |
| 6 | ACMIC resolves exactly 9 source SKUs | PASS | `canonical.variants.length === 9` |
| 7 | ASV resolves exactly 6 valid combinations | PASS | L $\times$ Hitam, L $\times$ Biru Tua, XL $\times$ Hitam, XL $\times$ Biru Tua, XXL $\times$ Hitam, XXL $\times$ Biru Tua |
| 8 | MOMO resolves XL + Hitam correctly | PASS | `v.attributes.Ukuran === "XL"`, `v.attributes.Warna === "Hitam"` |
| 9 | `sku = null` does not break valid extraction | PASS | Tested on ACMIC and ASV fixtures |
| 10 | `pre_order = null` does not break extraction | PASS | Preorder remains `enabled: false` |
| 11 | Missing price never silently becomes zero | PASS | Throws `MISSING_PRICE` / `INVALID_PRICE` |
| 12 | Missing inventory does not silently become available | PASS | Yields `available: null, status: "unknown"` |
| 13 | Unknown stock quantity remains unknown | PASS | `exact: false, quantity: undefined` (not 0) |
| 14 | Image priority/deduplication tested | PASS | detail $\rightarrow$ thumbnail $\rightarrow$ icon, deduplicated |
| 15 | Source identity fields are not ambiguous | PASS | `sourceSkuId`, `merchantSku`, `displaySku` distinct |
| 16 | Documentation reflects actual implementation | PASS | `PROJECT_MANIFEST.yaml`, `README.md`, `project-status.md`, `tests/fixtures/README.md` |
| 17 | `PROJECT_CHECKLIST.md` updated | PASS | Verified in this document |

---

## NEXT EXECUTION ORDER (PHASE 3)

1. Create `src/marketplace/types.ts` defining the `MarketplaceAdapter` contract and Shopee listing data structures.
2. Implement Shopee pricing and stock safety policy (`src/marketplace/shopee/policy.ts` - integer markup, safety stock, blocking UNKNOWN inventory).
3. Implement Shopee category and attribute mapper (`src/marketplace/shopee/mapper.ts`).
4. Implement Shopee draft listing builder & human review previewer (`src/marketplace/shopee/builder.ts`).
5. Implement authorized publication & dry-run preparation adapter (`src/marketplace/shopee/adapter.ts`).
6. Implement read-after-write verification (`src/marketplace/shopee/verifier.ts`).
7. Create comprehensive Phase 3 unit & integration tests (`tests/shopee.test.ts`).
8. Add diagnostic integration CLI command for end-to-end flow: JakMall URL $\rightarrow$ Canonical $\rightarrow$ Shopee Preview $\rightarrow$ Prepared Listing.

---

## CURRENT BLOCKERS

None. Ready for Phase 3 upon user command.
