# PROJECT STATUS

Current Phase:
PHASE 2 — Source Engine Repair & Validation (CERTIFIED REAL GOLDEN FIXTURES)

Last Verified:
2026-08-29

## CORE FLOW

- [x] URL accepted (SSRF safe allowlist: jakmall.com, www.jakmall.com)
- [x] Product fetched (Static HTTP First)
- [x] Product extracted (spdt embedded state via balanced-brace JSON extraction, specifications extraction)
- [x] Fallback supported (JSON-LD Product/Offer/AggregateOffer without unsafe Rp0 default)
- [x] Variants extracted (generic recursive multi-dimensional matrix resolution with previous ordering)
- [x] Canonical normalization (Source -> CanonicalProduct contract with sourceSkuId, merchantSku, displaySku)
- [x] Strict stock semantics verified (cases 1-3, inconsistent, and missing stock with explicit `available: boolean | null`)
- [x] Price safety verified (missing/null/non-positive price rejected, never Rp0)
- [x] Real-world regression verified against literal raw captured data:
  - ACMIC CPD65 (`6970238281488`, SHA-256: `7b962f...`): 9 exact SKUs, SKU `5502951494118` limited stock 3, 8 out-of-stock variants.
  - MOMO Cargo (`7372731614335`, SHA-256: `0eb603...`): SKU `2715227285879`, merchant SKU `OMPKGKBK`, final price 119400, weight 800g.
  - ASV Raincoat (`2389444540861`, SHA-256: `9d3f6c...`): 6 exact combinations, final price 190000, weight 1700g.
- [ ] Preview
- [ ] Shopee mapping
- [ ] Listing prepared/published
- [ ] Verification

## ADVANCED

- [ ] Batch
- [ ] Persistence
- [ ] Idempotency
- [ ] Queue
- [ ] Retry
- [ ] Sync
- [ ] AI mapping
- [ ] Review workflow
- [ ] Audit history
- [ ] AI Supervisor

## Known Blockers

None. Phase 2 acceptance gate is fully satisfied with certified raw fixture provenance. Awaiting user command to proceed to Phase 3.

## Next Priority

PHASE 3 — ONE-PRODUCT END-TO-END (MarketplaceAdapter contract, Shopee strategy & payload model, category/attribute mapping, preview, review, publish/authorized preparation, and verification).
