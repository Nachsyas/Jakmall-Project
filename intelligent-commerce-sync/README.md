# Intelligent Product Sync Platform
### JakMall → Shopee Intelligent Synchronization Engine

Technical Project Test: JakMall Product Scraper & Shopee Listing Automation.
Engineered as a modular TypeScript engine with strict stock/price semantics, deterministic marketplace policies, durable PostgreSQL/Redis execution infrastructure, and an optional bounded semantic intelligence sidecar.

---

## 1. Project Purpose

This platform implements a fail-closed synchronization workflow from **JakMall** toward **Shopee Indonesia**. Local preparation, persistence, execution safety, and verification behavior are tested; remote Shopee publication remains constrained by the State B boundary described below:

```
JakMall Product URL
  │
  ▼ [Static HTTP Fetch + SSRF Allowlist Gate]
Raw HTML / SPDT Extraction (Balanced-brace JSON parser + JSON-LD fallback, zero eval)
  │
  ▼ [Normalization & Invariant Enforcement]
Canonical Product Model (Source/Merchant/Display SKUs, Strict Stock & Price Semantics)
  │
  ▼ [Marketplace Adaptation & Policy Engine]
Shopee Listing Draft (Deterministic Markup/Rounding, Inventory Gate, Category/Attribute Mapping)
  │
  ▼ [Human-in-the-Loop Review Gate]
Review Assessment (APPROVE / REJECT / EDIT_REQUIRED, Blocker Protection)
  │
  ▼ [Persistence & Change Detection]
PostgreSQL Snapshots & Sync Planner (Field Diffing, Risk Evaluation, Idempotent Job Planning)
  │
  ▼ [Durable Execution Queue]
Redis / BullMQ Worker (Durable Payloads, Exponential Backoff, Idempotency Record)
  │
  ▼ [Marketplace Boundary & State B Guard]
Marketplace Execution Boundary (Dry-run Simulation / Credential-Gated Remote Boundary)
  │
  ▼ [Post-Execution Safety]
Read-After-Write Verification Model (Title, Variant Count, Price, and Stock Verification)
```

---

## 2. Current Certified Status

Certified Phase 5 implementation baseline: `778041c74e85a30e0abcd058ee8a4cfe75cde0e5`

| Phase | Description | Status |
|---|---|:---:|
| **Phase 2** | Source Engine & Canonical Model (JakMall Parser, Strict Semantics) | **CERTIFIED** |
| **Phase 3** | Marketplace Abstraction & Shopee Draft Engine (State B E2E) | **CERTIFIED** |
| **Phase 4A** | Persistence Foundation (PostgreSQL 16 Schema, Prisma, Repositories) | **CERTIFIED** |
| **Phase 4B** | Synchronization Domain (Diff Engine, Planner, State Machine) | **CERTIFIED** |
| **Phase 4C** | Execution Infrastructure (BullMQ Queue, Worker, Scheduler, Runtime Hardening) | **CERTIFIED** |
| **Phase 5A** | Semantic Intelligence Safety Foundation (Deterministic Contracts, Strict Output) | **CERTIFIED** |
| **Phase 5B** | Catalog Intelligence (Deterministic Matching, Verified Store Memory, AI Suggestion) | **CERTIFIED** |
| **Phase 5C** | Review Intelligence (Anomaly Detection, Non-escalating Advisory Annotations) | **CERTIFIED** |
| **Phase 5D** | Parser Recovery Assistance (Deterministic Diagnostics, Recovery Advice) | **CERTIFIED** |
| **Phase 5E** | Live AI Provider Safety Gate (Responses API, Rate Limits, Circuit Breaker, Privacy Gate) | **CERTIFIED** |
| **Final Gate** | Documentation & Submission Alignment | **IN PROGRESS** |

> [!IMPORTANT]
> **State B Operating Boundary (Platform-Access-Limited E2E):**
> Live remote publication to Shopee was **NOT performed** because legitimate official Shopee Open Platform partner credentials (`SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID`, `SHOPEE_ACCESS_TOKEN`) and an independently verified remote wire protocol were not available in this test environment.
> The platform implements and locally tests: local listing draft preparation, deterministic pricing/inventory policies, locally validated simulated marketplace payloads under the current internal adapter contract, authorized boundary rejection (`BLOCKED_BY_CREDENTIALS`), persistence, queuing, runtime scheduling, and the read-after-write verification model. Remote Shopee wire protocol compatibility remains unverified. Live Shopee write success is never fabricated.

---

## 3. What Works (Implemented & Tested)

- **JakMall Source Extraction (`src/jakmall/`)**: Static HTTP client with strict domain allowlisting (`jakmall.com`, `www.jakmall.com`), SSRF blocking, custom balanced-brace parser for `var spdt = {...}` (zero `eval`), and schema.org JSON-LD fallback.
- **Canonical Product Model (`src/canonical/`)**: Disambiguates `sourceSkuId`, `merchantSku`, and `displaySku`. Enforces recursive variant matrix extraction across arbitrary dimensions.
- **Strict Stock Semantics**: Differentiates confirmed out-of-stock (0), exact limited stock, undisclosed available stock (quantity undefined, not fabricated), and inconsistent/missing stock (`available: null`, fails closed).
- **Strict Price Semantics**: Missing, null, or non-positive source prices fail closed and never default to Rp0.
- **Shopee Marketplace Draft (`src/marketplace/shopee/builder.ts`, `policy.ts`, `mapper.ts`)**: Transforms canonical products into Shopee drafts with ceiling rounding to IDR increments, fee buffers, and minimum margins.
- **Review Decision Gate (`src/marketplace/shopee/builder.ts` via `applyHumanReview()`)**: Explicit human review workflows (`APPROVE`, `REJECT`, `EDIT_REQUIRED`) preventing any unapproved or blocked draft from publication.
- **Marketplace Execution Boundary (`src/marketplace/shopee/adapter.ts`, `src/execution/marketplace/`)**: Locally validated dry-run payload generation under the current internal adapter contract and authorized execution gate returning `BLOCKED_BY_CREDENTIALS` when credentials are absent.
- **Read-After-Write Verifier (`src/marketplace/shopee/verifier.ts`, `src/execution/marketplace/verification.ts`)**: Compares expected listing state with listing-reader results for price, stock, title, and variant-count mismatches; current certified evidence uses simulated mock readers rather than live Shopee reads.
- **Relational Persistence (`src/persistence/`)**: PostgreSQL 16 schema via Prisma storing products, point-in-time canonical product snapshots with hashes, listing mappings, sync jobs, idempotency records, sync events, and audit logs.
- **Sync Planner & State Machine (`src/sync/`)**: Deterministic change detection (diff kinds: price, inventory, content, variants), snapshot-scoped idempotency keys, and explicit job state machine transitions.
- **Queue & Worker Runtime (`src/queue/`, `src/runtime/`)**: Redis 7 + BullMQ job queues, isolated worker execution, exponential backoff, concurrency collision recovery, scheduler, and stale processing recovery.
- **Semantic Intelligence Sidecar (`src/intelligence/`)**:
  - *Phase 5A*: Type-safe prompt contracts, strict candidate/evidence allowlists, deterministic request IDs.
  - *Phase 5B*: Deterministic category/attribute matching with local verified store memory fallback before AI suggestion.
  - *Phase 5C*: Multi-signal anomaly review producing inert display annotations without mutating deterministic truth.
  - *Phase 5D*: Parser recovery diagnostics prioritizing non-semantic network/HTTP errors before consulting AI.
  - *Phase 5E*: Native fetch OpenAI Responses adapter (`gpt-5.6-luna`), strict privacy gate, sliding-window rate limiter (default 60 req / 60s), three-state circuit breaker, process request budget (default 1,000 calls), decoupled usage accounting, and `DISABLED` default mode.

---

## 4. What Does NOT Work / Is Not Claimed

To preserve strict technical-test integrity, the following limitations are explicitly documented:
1. **No Live Shopee Publication Evidence**: Live network writes to Shopee Open Platform APIs were not conducted; credentials were not available.
2. **No Live Shopee Read-After-Write Verification Evidence**: The verification engine is tested against simulated mock readers, not live remote Shopee GET calls.
3. **Unverified Shopee Wire Protocol Details**: Specific Shopee API field schemas reflect best-effort public documentation and have not been validated against live endpoints.
4. **No Credential or 2FA/CAPTCHA Bypass**: The scraper does not attempt session hijacking, CAPTCHA bypass, or headless browser automation against anti-bot defenses.
5. **No Stock Fabrication**: Undisclosed JakMall inventory is never converted into an arbitrary numeric quantity.
6. **No Autonomous AI Authority**: AI components act strictly as an advisory sidecar; they cannot override prices, invent stock, auto-approve review blocks, or mutate database state directly.
7. **No Web Dashboard**: The application is an automated backend engine driven by CLI diagnostic scripts, scheduled workers, and library-level TypeScript modules. No UI dashboard is implemented.
8. **No Live Production Deployment**: All verification was executed in local containerized and test environments; no production cloud cluster deployment is claimed.

---

## 5. Architecture

### Current Implemented Architecture

```
                       ┌──────────────────────────────┐
                       │  JakMall Source (HTTP GET)   │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────┐
                       │   Source Client & Parser     │
                       │ (Balanced-brace / JSON-LD)   │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────┐
                       │    Canonical Product Model   │
                       │  (Strict Stock/Price Rules)  │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────┐
                       │ Marketplace Policy & Review  │◄──────┐
                       │ (src/marketplace/shopee/)    │       │ (Advisory)
                       └──────────────┬───────────────┘       │
                                      │                       │
                                      ▼                       │
                       ┌──────────────────────────────┐       │
                       │ PostgreSQL 16 (Prisma ORM)   │       │
                       │ Snapshots, Jobs, Idempotency │       │
                       └──────────────┬───────────────┘       │
                                      │                       │
                                      ▼                       │
                       ┌──────────────────────────────┐       │
                       │   Sync Planner & State Mach. │       │
                       │  (Diffing & Operation Keys)  │       │
                       └──────────────┬───────────────┘       │
                                      │                       │
                                      ▼                       │
                       ┌──────────────────────────────┐       │
                       │  Redis 7 / BullMQ Queue      │       │
                       │   (Background Workers)       │       │
                       └──────────────┬───────────────┘       │
                                      │                       │
                                      ▼                       │
                       ┌──────────────────────────────┐       │
                       │ Marketplace Execution Guard  │       │
                       │ (src/marketplace/shopee/     │       │
                       │  adapter.ts,                 │       │
                       │  src/execution/marketplace/) │       │
                       └──────────────┬───────────────┘       │
                                      │                       │
                                      ▼                       │
                       ┌──────────────────────────────┐       │
                       │ Read-After-Write Verifier    │       │
                       │ (src/marketplace/shopee/     │       │
                       │  verifier.ts,                │       │
                       │  src/execution/marketplace/  │       │
                       │  verification.ts)            │       │
                       └──────────────────────────────┘       │
                                                              │
   ┌──────────────────────────────────────────────────────────┴─────┐
   │                Semantic Intelligence Sidecar (Optional)        │
   │  Catalog Memory (5B) │ Review Anomaly (5C) │ Parser Recovery (5D)│
   │  ───────────────────────────────────────────────────────────── │
   │   SemanticIntelligenceService (5A)                             │
   │   └── LiveAiProvider (5E: Privacy Gate, Rate/Circuit Controls) │
   └────────────────────────────────────────────────────────────────┘
```

### Possible Future Architecture (Not Implemented)
- Web Dashboard for human review queue and job inspection.
- Multi-marketplace adapter expansion (Tokopedia, Lazada, TikTok Shop).
- Cloud deployment with managed database and cache instances.

---

## 6. Quickstart

### Prerequisites
- **Node.js**: `v20+`
- **Docker & Docker Compose**: For local PostgreSQL and Redis

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Environment
Copy the environment template:
```bash
cp .env.example .env
```

> [!NOTE]
> - The local `DATABASE_URL` in `.env.example` targets the local Docker PostgreSQL container (`postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public`).
> - Leave Shopee API credentials blank unless legitimately authorized partner keys are available.
> - `OPENAI_API_KEY` may remain blank; `AI_PROVIDER_MODE` defaults to `DISABLED`.
> - Do **not** commit `.env` to version control.

### Step 3: Start Local Infrastructure
Start PostgreSQL 16 and Redis 7 containers:
```bash
docker compose up -d
```
Verify containers are healthy:
```bash
docker compose ps
```

### Step 4: Apply Database Migrations
Deploy Prisma schema to local PostgreSQL:
```bash
npx prisma migrate deploy
```

### Step 5: Run Baseline Verification
```bash
# Type check with zero errors
npm run typecheck

# Run 211 core unit & regression tests
npm test
```

---

## 7. Demo / Reviewer Walkthrough (5-Minute Path)

The repository provides standalone diagnostic scripts in `scripts/` using authentic sanitized-real golden fixtures from `tests/fixtures/`:

### 1. JakMall Extraction & Semantic Parsing
```bash
# ACMIC Golden Fixture: 9 SKUs, variant pricing, limited stock
npx tsx scripts/test-jakmall.ts tests/fixtures/acmic.html

# MOMO Golden Fixture: Multi-dimension (XL + Hitam), merchant SKU OMPKGKBK, 800g
npx tsx scripts/test-jakmall.ts tests/fixtures/momo.html

# ASV Golden Fixture: 6 combinations (Size x Color), null SKU tolerance, 1700g
npx tsx scripts/test-jakmall.ts tests/fixtures/asv.html
```

### 2. Shopee Listing Preparation & Policy Dry-Run
```bash
# Prepare draft, calculate deterministic markup/rounding, apply inventory policy
npx tsx scripts/test-shopee-draft.ts tests/fixtures/acmic.html
npx tsx scripts/test-shopee-draft.ts tests/fixtures/momo.html
npx tsx scripts/test-shopee-draft.ts tests/fixtures/asv.html
```

### What Each Fixture Demonstrates
- **`acmic.html` (`ACMIC CPD65`)**: Demonstrates multi-SKU pricing resolution (Rp379k, Rp449k, Rp299k, Rp399k), confirmed out-of-stock handling across 8 SKUs, and exact limited stock (3) for SKU `5502951494118`.
- **`momo.html` (`MOMO Cargo`)**: Demonstrates multi-dimensional matrix resolution (`Ukuran: XL`, `Warna: Hitam`), merchant SKU mapping, and weight extraction.
- **`asv.html` (`ASV Raincoat`)**: Demonstrates $2 \times 3$ matrix combinations, resilience to null source SKUs and null preorder fields, and heavy item weight handling (1,700g).

---

## 8. Test Suites & Verification Commands

Latest certified local regression evidence: **588 / 588 PASS, 0 FAIL**

### Core Unit & Domain Tests
```bash
# Run 211 core tests (parser, canonical, pricing, inventory, sync planning, state machine)
npm test
```

### Phase 5 Semantic Intelligence Tests
```bash
# Phase 5A: Semantic Intelligence Safety Foundation (82 tests)
npx tsx --test tests/intelligence/semantic-intelligence.test.ts

# Phase 5B: Catalog Intelligence & Verified Mapping Store (47 tests)
npm run test:intelligence:catalog

# Phase 5C: Review Intelligence & Anomaly Annotation (75 tests)
npm run test:intelligence:review

# Phase 5D: Parser Recovery Assistance (46 tests)
npm run test:intelligence:parser

# Phase 5E: Live AI Provider Safety Gate (56 tests)
npm run test:intelligence:live-provider

# Run all Phase 5 subdirectories combined (224 tests across 5B + 5C + 5D + 5E)
npm run test:intelligence
```

### Integration Test Suites (Requires Docker Infrastructure)
Ensure `docker compose up -d` is running, then execute:
```bash
# PostgreSQL Persistence & Idempotency Integration (12 tests)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" \
REDIS_URL="redis://localhost:6379" \
npm run test:integration:db

# Redis / BullMQ Queue & Worker Integration (21 tests)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" \
REDIS_URL="redis://localhost:6379" \
npm run test:integration:queue

# Marketplace Execution Boundary Integration (18 tests)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" \
REDIS_URL="redis://localhost:6379" \
npm run test:integration:marketplace

# Runtime Hardening, Scheduler & Stale Recovery Integration (20 tests)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" \
REDIS_URL="redis://localhost:6379" \
npm run test:integration:runtime
```

### Test Count Summary
$$\begin{aligned}
\text{Core Unit Tests (npm test)} &: 211 \\
\text{Phase 5A Semantic Foundation} &: 82 \\
\text{Phase 5B Catalog Intelligence} &: 47 \\
\text{Phase 5C Review Intelligence} &: 75 \\
\text{Phase 5D Parser Recovery} &: 46 \\
\text{Phase 5E Live AI Provider} &: 56 \\
\text{Phase 4 Integration: Database} &: 12 \\
\text{Phase 4 Integration: Queue} &: 21 \\
\text{Phase 4 Integration: Marketplace} &: 18 \\
\text{Phase 4 Integration: Runtime} &: 20 \\
\hline
\mathbf{Total\ Unique\ Automated\ Tests} &: \mathbf{588}\ \text{(588 PASS, 0 FAIL)}
\end{aligned}$$

*Note on Subdirectory Intelligence Runner:* `npm run test:intelligence` executes test files in subdirectories ($47 + 75 + 46 + 56 = 224$ tests across 13 suites) and excludes top-level `tests/intelligence/semantic-intelligence.test.ts` (82 tests), which is run directly.

---

## 9. Technology Stack & Dependencies

- **Runtime & Language**: Node.js `v20+`, TypeScript `v5+` with strict compiler settings
- **HTML Parsing**: `cheerio` (fast server-side DOM traversing)
- **Validation**: `zod` (runtime validation at source/canonical and selected semantic boundaries)
- **Persistence**: `prisma` ORM with PostgreSQL 16
- **Asynchronous Queuing**: `bullmq` and `ioredis` with Redis 7
- **AI Integration**: Native `fetch` against OpenAI Responses API (`gpt-5.6-luna`), strictly gated and `DISABLED` by default (zero vendor SDK dependencies)

---

## 10. Cost & Simplicity Analysis

- **Zero Heavy Orchestration**: Designed as a clean modular monolith with in-process modular calls; testable without distributed-service coordination, Kubernetes, Kafka, or microservice mesh overhead.
- **Local Open-Source Infrastructure**: PostgreSQL and Redis run locally via standard Alpine Docker containers with zero external SaaS requirements for development.
- **Controlled Scraping Cost**: Primary extraction relies on static HTTP requests without mandatory paid proxy networks or headless browser overhead.
- **Controlled AI Cost Profiles**:
  - `AI_PROVIDER_MODE=DISABLED` (default): Zero provider network dispatch and zero provider API cost.
  - `DRY_RUN` mode: Performs request envelope, privacy gate, and character budget validation locally; zero provider network dispatch, consumes zero process budget slots, consumes zero live rate slots, and incurs zero OpenAI cost.
  - `LIVE` mode: Requires a legitimate API key; bounded by request text budget (default 16,000 chars; bounds: 500..50,000), process request budget (default 1,000 calls; bounds: 1..100,000), sliding-window rate limiter (default 60 req / 60s; bounds: 1..1,000 req / 1,000..600,000 ms), three-state circuit breaker, and usage telemetry.
- **Realistic Production Boundary**: Total production cost is not claimed to be $0. Production deployment would require appropriate application, PostgreSQL, and Redis hosting. Managed cloud services such as RDS or ElastiCache are optional deployment choices, not architectural requirements. Valid marketplace developer credentials would also be required for remote marketplace operations.

---

## 11. Security, Reliability & Fail-Closed Safety

- **SSRF Defense**: Strict allowlist validation (`jakmall.com`, `www.jakmall.com`), blocking localhost, loopback, private IPv4/IPv6 ranges, and AWS metadata IP (`169.254.169.254`).
- **Zero Eval Execution**: Custom character-by-character balanced-brace parser extracts embedded JavaScript objects without invoking `eval()` or `Function()`.
- **Zero Token Invention**: Undisclosed inventory remains explicit `quantity: undefined`, preventing phantom stock listing.
- **Zero Rp0 Pricing**: Missing or non-positive source prices throw errors at the canonical boundary, preventing disastrous zero-price listings.
- **Idempotency Safeguards**: Product-level keys for listing creation, snapshot-scoped keys for price/inventory updates, and database unique constraints preventing duplicate dispatch.
- **AI Safety Controls**: Process request ceilings (default 1,000 calls), sliding-window rate limiters (default 60 req / 60s), three-state circuit breakers (`CLOSED`, `OPEN`, `HALF_OPEN`), and structural privacy gates:
  - Forbidden secret-bearing property names and unknown fields are rejected before network dispatch.
  - Candidate and evidence provenance is enforced.
  - API keys are never exposed through public config or usage snapshots.
  - Raw provider error payloads and status values are not echoed by the adapter.
  - *(Comprehensive PII detection is not claimed).*
- **Persistence Safety**: Persistence models and repositories support tested `SyncEvent` and `AuditLog` history.

---

## 12. AI-Assisted Development Disclosure

- **Development Tooling**: Architecture, implementation, and test suites were developed with the pair-programming assistance of Google Antigravity, strictly governed by rigorous phased verification gates.
- **Runtime System Independence**: All deterministic business logic (parsing, pricing, inventory safety, idempotency, state transitions) operates strictly independently of AI. Runtime AI features exist exclusively as an optional, bounded, advisory sidecar.

---

## 13. Documentation Cross-References

- [Project Status](docs/project-status.md)
- [Project Checklist & Certification History](PROJECT_CHECKLIST.md)
- [Known Limitations & Mitigations](docs/known-limitations.md)
- [System Architecture Overview](docs/architecture/system-overview.md)
- [Shopee Integration Specification & State B Boundary](docs/marketplace/shopee-integration.md)
- [Phase 5E AI Integration Safety Gate](docs/architecture/phase5-ai-integration-safety-gate.md)
