# PROJECT STATUS

Current Phase:
PHASE 3 — ONE-PRODUCT END-TO-END (CERTIFIED STATE B: VALIDATED DRAFT, DRY-RUN & AUTHORIZED ADAPTER READY)

Last Verified:
2026-08-29

## CORE FLOW

- [x] URL accepted (SSRF safe allowlist: jakmall.com, www.jakmall.com)
- [x] Product fetched (Static HTTP First)
- [x] Product extracted (spdt embedded state via balanced-brace JSON extraction, specifications extraction)
- [x] Fallback supported (JSON-LD Product/Offer/AggregateOffer plain & namespaced without unsafe Rp0 default)
- [x] Variants extracted (generic recursive multi-dimensional matrix resolution with previous ordering)
- [x] Canonical normalization (Source -> CanonicalProduct contract with sourceSkuId, merchantSku, displaySku)
- [x] Strict stock semantics verified (cases 1-3, inconsistent, and missing stock with explicit `available: boolean | null`)
- [x] Price safety verified (missing/null/non-positive price rejected, never Rp0)
- [x] Image normalization & deduplication verified (detail > thumbnail > icon, sequential position)
- [x] Real-world regression verified against literal raw captured data:
  - ACMIC CPD65 (`6970238281488`, External SHA-256: `087b8457fa2ea2128b7335493f62bf04037836d0355f6bb35c019760a1f76f5d`): 9 exact SKUs, SKU `5502951494118` limited stock 3, 8 out-of-stock variants.
  - MOMO Cargo (`7372731614335`, External SHA-256: `93b8039c4c438d8b87ad5dc2e73f431ac8d44d209fe38b6d0e688fbb92f67742`): SKU `2715227285879`, merchant SKU `OMPKGKBK`, final price 119400, weight 800g.
  - ASV Raincoat (`2389444540861`, External SHA-256: `925ac2680479d0d44a605a10ff694c64c32d2b8c19aa2dc229a414f20cd4dc48`): 6 exact combinations, final price 190000, weight 1700g.
- [x] Preview (CLI diagnostic tool `scripts/test-shopee-draft.ts` displaying source, pricing, stock, attributes, and validation issues)
- [x] Shopee mapping (Deterministic rule-based and manual override category mapping, attribute mapping)
- [ ] Listing prepared/published (Dry-run preparation verified; live remote publication NOT PERFORMED, gated by `BLOCKED_BY_CREDENTIALS` in State B)
- [ ] Verification (ShopeeListingVerifier read-after-write engine implemented and unit tested with mock reader; live remote verification NOT PERFORMED)

## ADVANCED

- [ ] Batch
- [ ] Persistence (PostgreSQL schema & repositories scheduled for Phase 4)
- [x] Idempotency (Deterministic idempotency key contract: `marketplace:sellerAccount:source:sourceProductId:operation`)
- [ ] Queue (Redis/BullMQ scheduled for Phase 4)
- [ ] Retry
- [ ] Sync
- [ ] AI mapping (Optional enhancement, rule-based mapping is primary)
- [x] Review workflow (Human review decision gate: APPROVE, REJECT, EDIT_REQUIRED)
- [ ] Audit history
- [ ] AI Supervisor

## Known Blockers & Limitations

- **Shopee Open Platform API Access:** Official partner credentials (`SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID`, `SHOPEE_ACCESS_TOKEN`) are not configured in this test environment. The platform truthfully returns `BLOCKED_BY_CREDENTIALS` in publish mode and executes complete payload generation in `dry_run` mode (State B: Platform-Access-Limited E2E).

## Next Priority

PHASE 4 — PERSISTENCE & QUEUE FOUNDATION (PostgreSQL schema, database migrations, Redis/BullMQ background worker, idempotent job processing).
