# Known Limitations & Mitigations

Certified Phase 5 implementation baseline: `778041c74e85a30e0abcd058ee8a4cfe75cde0e5`

Technical Project Test: JakMall Product Scraper & Shopee Listing Automation.
This document provides an honest, comprehensive audit of current platform boundaries, operational constraints, and implemented mitigations.

---

## 1. Upstream Source Limitations (JakMall)

| Limitation ID | Description | Impact | Current Implemented Mitigation | Future Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **LIM-001** | **JakMall HTML Structure Mutation** | Scraper breaks if `spdt` variable name, attribute keys, or container DOM selectors mutate. | Custom balanced-brace parser with zero `eval()`, schema.org JSON-LD fallback parser, strict Zod schema validation at canonical boundary, and Phase 5D parser recovery diagnostics. | Headless browser fallback (Playwright) for dynamically rendered client-side DOM. |
| **LIM-002** | **Undisclosed Source Stock Quantities** | JakMall discloses boolean availability but not integer quantities for non-limited items. | Strict stock semantics: preserves `available: true, exact: false, quantity: undefined` without inventing fake numbers. Configurable deterministic inventory policy (needs_review or safety stock cap). Inconsistent/missing stock fails closed as `available: null`. | Warehouse inventory velocity modeling and dynamic safety buffer calculations. |
| **LIM-003** | **Upstream Rate Limits (HTTP 429)** | High-frequency fetching from JakMall may trigger HTTP 429 or IP throttling. | Polite User-Agent, SSRF allowlist (`jakmall.com`, `www.jakmall.com`), 15s timeout, diagnostic classification in Phase 5D. *(Note: Distinguish source-fetch limits from AI provider rate/circuit controls)*. | Bounded exponential backoff, jitter, request pacing, caching, and adaptive refresh intervals. |

---

## 2. Marketplace & Execution Limitations (Shopee State B)

| Limitation ID | Description | Impact | Current Implemented Mitigation | Future Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **LIM-004** | **Category & Attribute Taxonomy Mismatch** | JakMall breadcrumbs and attributes do not map 1:1 to Shopee category IDs and attributes. | Deterministic mapping rules, manual override support, local `VerifiedMappingStore` memory cache (Phase 5B), and bounded AI suggestion fallback strictly requiring human review (`reviewRequired: true`). | Automated taxonomy synchronization via periodic Shopee Open Platform category tree downloads. |
| **LIM-005** | **State B: Live Shopee Credentials Unavailable** | Official Shopee Open Platform partner credentials were not available in this test environment. | Operates in State B: complete local draft preparation, deterministic pricing/inventory calculation, dry-run simulation mode generating locally validated simulated marketplace payloads under the current internal adapter contract, and authorized execution gate returning `BLOCKED_BY_CREDENTIALS`. Remote Shopee wire protocol compatibility remains unverified. | Onboard an authorized official Shopee Open Platform developer account and configure legitimate credentials for the authorized target environment. |
| **LIM-006** | **Unverified Shopee Remote Protocol Details** | Specific Shopee REST API request/response wire formats reflect public documentation without live endpoint validation. | An isolated, unit-tested adapter boundary (`ShopeeMarketplaceAdapter` in `src/marketplace/shopee/adapter.ts`) with strict payload mapping that keeps remote protocol details outside the core synchronization domain. Remote Shopee wire protocol compatibility remains unverified. | End-to-end verification against an authorized official Shopee Open Platform environment. |
| **LIM-007** | **Live Publication & Read-Back Not Performed** | Live remote publication and remote read-after-write verification calls were not executed against live servers. | Read-after-write verification is implemented and tested against simulated mock readers in `src/marketplace/shopee/verifier.ts` (`ShopeeListingVerifier`) and `src/execution/marketplace/verification.ts`, validating title, variant count, price, and stock mismatches. Live remote publication and read-back remain NOT PERFORMED. | Live remote smoke testing upon provisioning authorized platform credentials. |

---

## 3. Semantic Intelligence & AI Safety Limitations

| Limitation ID | Description | Impact | Current Implemented Mitigation | Future Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **LIM-008** | **AI Provider Requires Explicit Enablement & Valid Key** | Provider defaults to `AI_PROVIDER_MODE=DISABLED`. `LIVE` mode requires legitimate `OPENAI_API_KEY`. | Core deterministic extraction, pricing, inventory, persistence, sync, and execution-safety logic does not require AI. Semantic-eligible tasks remain review-required or fail closed when AI is disabled/unavailable. | Multi-provider failover (Anthropic, Google Gemini, Azure OpenAI). |
| **LIM-009** | **AI Output is Strictly Advisory** | AI cannot possess autonomous write authority over pricing, inventory, or publication. | Phase 5A-5E safety boundary: strict candidate/evidence allowlists, prompt isolation, prohibition of price/stock output, non-escalating display findings (`AI_ANOMALY_ANNOTATION`), and mandatory human review. | Confidence calibration, review prioritization, human-verified mapping promotion into deterministic VerifiedMappingStore, and better evaluation datasets (no autonomous AI approval). |
| **LIM-010** | **Process-Local AI Controls & Circuit State** | Sliding-window rate limiter, process budget, and circuit breaker states (`CLOSED`, `OPEN`, `HALF_OPEN`) are in-memory. | Process ceiling (default 1,000 calls; bounds: 1..100,000) and sliding-window rate limit (default 60 req / 60s; bounds: 1..1,000 req / 1,000..600,000 ms) protect each individual Node.js process. | Distributed rate limiting and circuit state persistence via Redis. |

---

## 4. Operational & Deployment Limitations

| Limitation ID | Description | Impact | Current Implemented Mitigation | Future Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **LIM-011** | **No Web Dashboard Implemented** | No graphical user interface is present in the repository. | Automated backend engine driven by CLI diagnostic scripts (`scripts/test-jakmall.ts`, `scripts/test-shopee-draft.ts`), scheduled workers, library-level TypeScript modules, and structured logging. | Hypothetical future operator dashboard for review queue management. |
| **LIM-012** | **No Live Production Cloud Deployment** | System is containerized and validated in local development/test environments; no cloud cluster is deployed. | Reproducible Docker Compose environment (PostgreSQL 16, Redis 7) and latest certified local regression evidence: 588 / 588 PASS, 0 FAIL. | Hypothetical cloud deployment infrastructure manifests if distributed multi-node hosting is required. |
