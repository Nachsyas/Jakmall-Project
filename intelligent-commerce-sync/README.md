# Intelligent Commerce Sync

### JakMall Product Scraper & Shopee Listing Preparation

A working Proof of Concept that discovers products from a configured public JakMall catalog, imports and normalizes product data, stores the catalog, and prepares products for Shopee using deterministic pricing, inventory, category mapping, and human-review safety gates.

> **Live Public PoC**: [https://jakmall-project-two.vercel.app](https://jakmall-project-two.vercel.app)
>
> **Note**: No individual product URL is required for the normal demo flow.

---

## Live Demo & Snapshot

| Metric / Endpoint | Certified Result / Location |
|---|---:|
| **Live Public PoC** | [https://jakmall-project-two.vercel.app](https://jakmall-project-two.vercel.app) |
| **Production API Health** | [https://jakmall-project-two.vercel.app/api/health](https://jakmall-project-two.vercel.app/api/health) |
| **Products Discovered (Controlled)** | 10 / 10 |
| **Products Imported (Controlled)** | 10 / 10 (0 failed) |
| **Automated Tests** | **659 / 659 PASS (0 FAIL)** |
| **Local Web UI** | [http://localhost:3000](http://localhost:3000) |
| **Local API Health** | [http://localhost:3001/api/health](http://localhost:3001/api/health) |

[Live Demo](#live-demo--snapshot) · [Quick Start](#quick-start) · [Reviewer Demo](#5-minute-reviewer-demo) · [Production Deployment](#production-deployment) · [Architecture](#architecture) · [API](#api) · [Known Limitations](#known-limitations)

---

## Screenshots

Real screenshots from the Phase 6 web application.

| Overview | Product Catalog |
|---|---|
| <img src="docs/screenshots/home.png" alt="Intelligent Commerce Sync overview" width="100%"> | <img src="docs/screenshots/products.png" alt="Imported JakMall product catalog" width="100%"> |

| Catalog Sync | Shopee Preparation |
|---|---|
| <img src="docs/screenshots/sync.png" alt="JakMall catalog discovery and sync" width="100%"> | <img src="docs/screenshots/product-detail.png" alt="Product detail and Shopee listing preparation" width="100%"> |

- **Overview** — application summary and current catalog state.
- **Product Catalog** — normalized products imported from the configured public JakMall catalog.
- **Catalog Sync** — bounded automatic catalog discovery and batch import workflow.
- **Shopee Preparation** — deterministic listing preparation with pricing, inventory, category, and review safeguards.

---

## What This Project Solves

Transferring product catalogs manually from JakMall into Shopee is error-prone and labor-intensive:
- Copying titles, descriptions, and media across browser tabs.
- Flattening multi-dimensional variant combinations (color, size) while preserving unique SKUs.
- Recalculating commercial margins (+20% markup with IDR 1.000 ceiling rounding).
- Handling inventory truth: preventing undisclosed stock from being fabricated as numeric quantities.
- Mapping third-party categories and attributes into Shopee-compliant taxonomies.

This PoC turns that manual workload into a controlled automated pipeline with built-in operator review gates.

---

## Demo Flow

```mermaid
flowchart TD
    A[JakMall Public Catalog] --> B[Automatic Product Discovery]
    B --> C[Controlled Batch Import]
    C --> D[JakMall Parser / Source-Shape Validation]
    D --> E[CanonicalProduct]
    E --> F[PostgreSQL / Supabase]
    F --> G[Thin HTTP API]
    G --> H[React Web Application]
    H --> I[Product Detail]
    I --> J[Prepare for Shopee]
    J --> K[Pricing + Inventory + Category Mapping]
    K --> L[Human Review Gate]
    L --> M[Dry Run / Credential-Gated Boundary]
```

Normal demo usage does **not** require individual product URLs. Products are discovered automatically from the configured public catalog/store, subject to safety limits and available public catalog pages.

---

## Project Status

- **Core PoC Complete**: Fully functional pipeline from catalog discovery through normalization, persistence, and Shopee preparation.
- **Catalog Ingestion**: JakMall catalog discovery and batch import supported across multi-variant and single-SKU stores.
- **Normalization Pipeline**: Strict `CanonicalProduct` normalization preserving source SKUs, merchant SKUs, dimensions, and images.
- **Persistence Layer**: Relational PostgreSQL schema storing products, variants, point-in-time snapshots, sync events, and audit logs.
- **Commercial Logic**: Deterministic +20% markup with IDR 1.000 ceiling rounding; undisclosed stock preserved as `undefined` (never 0).
- **Shopee Preparation & Review**: Generates compliant listing payloads; flags unmapped categories as `NEEDS_REVIEW` (`canPublish: false`).
- **Shopee Safety Boundary**: Live remote marketplace write remains strictly credential-gated. No CAPTCHA, OTP, 2FA, or access-control bypass is attempted or claimed.

---

## What Works

| Capability | Status | Notes |
| :--- | :---: | :--- |
| **Automatic Catalog Discovery** | ✅ Implemented | Discovers product links from public store pages with crawl depth limits. |
| **Batch Catalog Import** | ✅ Implemented | Sequential parsing, failure isolation, and transactional DB persistence. |
| **Product Extraction** | ✅ Implemented | Static HTTP client + Cheerio DOM parsing + custom balanced-brace parser (zero `eval`). |
| **Canonical Normalization** | ✅ Implemented | Normalizes to `CanonicalProduct` with source, merchant, and display SKUs. |
| **Images / Variants / SKU** | ✅ Implemented | Full gallery extraction and multi-dimensional variant matrix resolution. |
| **Strict Stock Semantics** | ✅ Implemented | Exact stock preserved; confirmed out-of-stock = 0; undisclosed stock = `undefined` (never 0). |
| **Pricing Policy** | ✅ Implemented | Non-positive prices fail closed; deterministic +20% margin with IDR 1.000 rounding. |
| **Shopee Draft Preparation** | ✅ Implemented | Evaluates listing properties, pricing rules, and category mapping. |
| **Human Review Gate** | ✅ Implemented | Unverified categories/attributes transition to `NEEDS_REVIEW` with `canPublish: false`. |
| **PostgreSQL Persistence** | ✅ Implemented | Prisma ORM storing products, point-in-time snapshots, sync events, and audit logs. |
| **Redis / BullMQ Runtime** | ✅ Implemented | Asynchronous queue with idempotency keys, retry handling, and authenticated health PING. |
| **React Web UI** | ✅ Implemented | Responsive Apple-inspired interface across desktop, tablet, and mobile. |
| **Status / Error Handling** | ✅ Implemented | Sanitized API errors (no stack trace leaks); SSRF domain allowlisting (`jakmall.com`). |
| **Live Shopee Publication** | ⚠️ Not claimed | Remote API write is intentionally guarded when partner credentials are absent. |

### Cross-Store Validation

The source parser has been live-validated against three distinct public JakMall catalog and source shapes:

| Public Catalog | Discovered | Imported | Failed | Source Shape |
|---|---:|---:|---:|:---|
| **ACMIC Official Store** | 20 | 20 | 0 | Multi-variant matrix structure |
| **Freedom Store** | 30 | 30 | 0 | Single-SKU, no-matrix structure (`variants = []`, `matrix = null`) |
| **LStore** | 10 | 10 | 0 | Multi-variant accessory structure |

The parser explicitly supports both multi-variant matrix structures and single-SKU layouts, while malformed primitive shapes fail closed safely.

> **Note**: This pipeline is validated against these three JakMall catalog/source shapes. It does not claim universal compatibility with every arbitrary future layout variation on JakMall.

---

## Production Deployment

The public Proof of Concept is deployed and verified in cloud production:

- **Frontend & API**: Hosted on **Vercel Hobby** (Serverless functions routing same-origin `/api/*` requests).
- **Database**: **Supabase PostgreSQL** connected through the Supabase **Transaction Pooler** (port `6543`, `pgbouncer=true`, `connection_limit=1`).
- **Redis Cache & Health**: **Upstash Redis** running over TLS, actively probed by `checkRedisHealth` with authenticated PING.

### Final Production Acceptance Verification

The production deployment at [https://jakmall-project-two.vercel.app](https://jakmall-project-two.vercel.app) has passed sequential automated cloud validation:

| Verification Target | Certified Result | Status |
|:---|:---|:---:|
| **Database Connectivity** | 3 / 3 sequential `/api/health` probes connected | **PASS** |
| **Redis Connectivity** | 3 / 3 sequential `/api/health` probes connected (authenticated PING) | **PASS** |
| **Products Query API** | 5 / 5 sequential `/api/products?limit=5` requests return HTTP 200 JSON | **PASS** |
| **Postgres Error `42P05`** | Prepared statement collisions | **ABSENT** |
| **Postgres Error `26000`** | Missing prepared statement errors | **ABSENT** |
| **Supabase Connection Errors** | `EMAXCONNSESSION` and `P2028` pool timeouts | **ABSENT** |
| **Frontend Public Routing** | `/`, `/products`, `/sync`, `/reviews`, `/activity` return HTTP 200 anonymously | **PASS** |
| **Controlled Ingestion Proof** | Live ACMIC cloud batch import | **10 / 10 PASS (0 fail)** |

---

## Quick Start

### 1. Clone & Checkout
```bash
git clone https://github.com/Nachsyas/Jakmall-Project.git
cd Jakmall-Project
git checkout phase6/web-catalog-ui
cd intelligent-commerce-sync
```

### 2. Install Dependencies
```bash
npm install
npm --prefix web install
```

### 3. Configure Environment
```bash
cp .env.example .env
```
> [!NOTE]
> - Default `DATABASE_URL` and `REDIS_URL` in `.env.example` point to local Docker services.
> - Shopee credentials remain blank for the local dry-run demo.
> - `OPENAI_API_KEY` is optional; `AI_PROVIDER_MODE` defaults to `DISABLED`.
> - Never commit `.env` to version control.

### 4. Start Infrastructure Containers
```bash
docker compose up -d
docker compose ps
```

### 5. Initialize Database
```bash
npx prisma generate
npx prisma migrate deploy
```

### 6. Run Application
Open two terminal windows:

**Terminal A (Backend API):**
```bash
npm run dev:api
```

**Terminal B (Frontend Web UI):**
```bash
npm run dev:web
```

Access:
- **Web UI**: [http://localhost:3000](http://localhost:3000)
- **API Health**: [http://localhost:3001/api/health](http://localhost:3001/api/health)

---

## 5-Minute Reviewer Demo

1. **Open the Web UI**: Visit `http://localhost:3000` (or [https://jakmall-project-two.vercel.app](https://jakmall-project-two.vercel.app)) to see the live catalog overview.
2. **Open Products**: Navigate to `/products`. Browse persisted items or search using `"PowerBank"`.
3. **Open Sync JakMall**: Navigate to `/sync` (pre-filled with `https://www.jakmall.com/acmic-official-store`).
4. **Preview Discovery**: Click **Preview Discovery** to inspect extracted product URLs and page depth.
5. **Batch Import**: Click **Import Discovered Products** once. Watch the single-flight concurrency lock and live progress.
6. **Inspect Product Detail**: Return to `/products` and select `PreorderACMIC C8 8000mAh PowerBank`.
7. **Verify Stock & Variants**: Review the variants table. Confirm stock semantics: out-of-stock variants indicate `"Out of stock"` (`quantity: 0`) rather than fabricated numbers.
8. **Prepare for Shopee**: Click **Prepare for Shopee**.
   - Selling price: `Rp 348.000` (+20% margin from `Rp 289.900`).
   - Category suggestion: `Aksesoris Handphone > Charger & Kabel > Kepala Charger`.
   - Review state: `NEEDS_REVIEW (rule)` — flagged because numeric Shopee ID requires operator confirmation.
   - Publishable: `False (Gated)` — strictly prevents unverified publication.
9. **Review & Activity**: Visit `/reviews` and `/activity` to view the operator queue and job execution logs.
10. **Shopee Credential Boundary**: Confirm that the marketplace dry-run protects the boundary when live credentials are absent.

---

## Web Application

Built with **React 19, TypeScript, and Vite**, styled using vanilla CSS following Apple Human Interface Guidelines:

| Route | Purpose |
| :--- | :--- |
| `/` | System overview, live inventory metrics, and recent catalog highlights. |
| `/products` | Persisted product catalog with real-time text search and IDR pricing. |
| `/products/:id` | Full product detail, multi-dimensional variants table, and Shopee preparation. |
| `/sync` | Interactive catalog discovery preview and single-click batch import. |
| `/reviews` | Operator review queue for items requiring manual mapping or approval. |
| `/activity` | Background synchronization job execution history and audit log. |

---

## Architecture

```mermaid
flowchart TD
    UI[React Web UI]
    API[Thin Node HTTP API]
    CATALOG[Catalog Services]
    DISCOVERY[Discovery Service]
    SOURCE[JakMall Source Adapter]
    PARSER[Parser + Normalizer]
    CANONICAL[CanonicalProduct]
    DB[(PostgreSQL / Supabase)]
    POLICY[Shopee Policy Engine]
    REVIEW[Review Gate]
    REDIS[(Redis / Upstash)]
    AI[Optional Advisory AI Sidecar]

    UI --> API
    API --> CATALOG
    CATALOG --> DISCOVERY
    DISCOVERY --> SOURCE
    SOURCE --> PARSER
    PARSER --> CANONICAL
    CANONICAL --> DB
    CANONICAL --> POLICY
    POLICY --> REVIEW
    DB --> REDIS
    AI -. advisory only .-> CATALOG
```

The pipeline flows through explicit, deterministic layers:
1. **JakMall Public Source** → Crawled via static HTTP without headless browser overhead.
2. **Discovery & Parser** → Discovers product URLs and extracts data using balanced-brace parsing (zero `eval`).
3. **CanonicalProduct** → Strict normalized contract decoupling source data from target marketplaces.
4. **Persistence** → Transactional storage of products, snapshots, and audit events.
5. **Pricing & Inventory** → Applies commercial rules (+20% margin, IDR 1.000 ceiling, exact stock semantics).
6. **Shopee Draft Mapping** → Translates canonical data into Shopee product structures.
7. **Review & Safety Gate** → Flags unverified categories/attributes as `NEEDS_REVIEW`.
8. **Execution Guard & Verification** → Enforces dry-run simulation mode when live credentials are absent.

---

## Data Extracted

- **Identity**: Product title, brand, full description, and canonical URL.
- **Pricing**: Source selling price and original price (fails closed on non-positive values).
- **Media**: Primary cover image and secondary gallery images.
- **Variants & SKUs**: Multi-option combinations (color, size), variant names, and display SKUs.
- **Inventory Semantics**: Exact quantity when specified, out-of-stock indicators, and undisclosed stock.
- **Specifications & Taxonomy**: Technical attributes, warranty info, and source breadcrumb category.
- **Dimensions**: Weight and package dimensions where available in source data.

*Not all JakMall fields map 1:1 to Shopee. Unverified fields transition to `NEEDS_REVIEW` rather than being fabricated.*

---

## API

The HTTP API provides full catalog and lifecycle operations with strict Zod schema validation:

| Method | Endpoint | Purpose | Validation Bounds |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Health check & connectivity status (DB + Redis PING) | None |
| `GET` | `/api/products` | Paginated product catalog | `limit <= 100`, `offset >= 0` |
| `GET` | `/api/products/:id` | Detailed product record with variants | Valid UUID |
| `POST` | `/api/catalog/discover` | Discovers product URLs from store | `maxProducts <= 100`, `maxPages <= 10` |
| `POST` | `/api/catalog/import` | Ingests and persists store products | `maxProducts <= 50`, `maxPages <= 5` |
| `POST` | `/api/products/:id/prepare-shopee` | Evaluates Shopee preparation rules | Dry-run gated |
| `GET` | `/api/reviews` | Operator review queue | None |
| `GET` | `/api/jobs` | Background sync job history | None |

---

## Shopee Preparation & Safety Boundary

| Implemented & Verified | Not Claimed / Boundary Guarded |
| :--- | :--- |
| ✔ Normalized Shopee listing draft generation | ✖ Successful live Shopee listing creation |
| ✔ Deterministic pricing (+20% margin, commercial rounding) | ✖ Verified production Shopee API network write |
| ✔ Strict inventory mapping (0 preserved, undisclosed gated) | ✖ Live remote read-after-write verification |
| ✔ Category mapping & attribute suggestion engine | ✖ Automatic unverified numeric category publishing |
| ✔ Blocker and warning evaluation (weight, brand, review) | ✖ Credential or 2FA/CAPTCHA bypass |
| ✔ Dry-run execution boundary with credential guard | ✖ Remote marketplace success without credentials |

> [!IMPORTANT]
> **Category Review Rule**: If a numeric Shopee category ID cannot be verified, the product enters `NEEDS_REVIEW` instead of receiving a fabricated category ID. Live Shopee publication is not claimed because authorized official Open Platform credentials were unavailable for this assessment environment.

---

## Reliability & Security

- **SSRF Defense**: Strict allowlisting (`jakmall.com`, `www.jakmall.com`) blocking private IPs, loopback, and cloud metadata endpoints.
- **Zero Eval Execution**: Static HTTP client + Cheerio DOM parsing + custom balanced-brace object extraction (zero `eval`).
- **Fail-Closed Pricing**: Missing or non-positive prices immediately throw normalization errors (no Rp0 listings).
- **Strict Stock Semantics**: Undisclosed stock remains `undefined`; confirmed out-of-stock is preserved as `0`.
- **Bounded Ingestion**: Enforced limits on request bodies, crawl depth, and pagination scans.
- **Idempotency**: Deterministic hash-based operation keys prevent duplicate listing creations or updates.
- **Queue Fault Tolerance**: Redis 7 and BullMQ provide exponential backoff retry and stale-job recovery.
- **Truthful Health Probes**: Redis health checks perform authenticated PING operations; database checks execute live queries.
- **Information Protection**: API errors suppress stack traces; CORS allowlisting enforced; `.env` excluded from version control.

---

## Testing

Final certified regression status: **659 / 659 PASS, 0 FAIL**

| Test Suite | Command / Scope | Tests |
| :--- | :--- | :---: |
| **Root / API / UI / Health** | `npm test` (`tests/*.test.ts`) | 280 |
| **Intelligence Subdirectories** | `npm run test:intelligence` (`tests/intelligence/**/*.test.ts`) | 224 |
| **Standalone Semantic Intelligence** | `npx tsx --test tests/intelligence/semantic-intelligence.test.ts` | 82 |
| **PostgreSQL Integration** | `npm run test:integration:db` | 14 |
| **Queue Integration** | `npm run test:integration:queue` | 21 |
| **Marketplace Integration** | `npm run test:integration:marketplace` | 18 |
| **Runtime Integration** | `npm run test:integration:runtime` | 20 |
| **Total Unique Tests** | | **659** |

```bash
# Verify backend types
npm run typecheck

# Verify frontend types and production build (runs tsc -b && vite build)
npm run build:web

# Run core test suite (including deterministic API health tests)
npm test
```

<details>
<summary><strong>Full Integration & Intelligence Test Commands</strong></summary>

```bash
# Semantic intelligence suites
npx tsx --test tests/intelligence/semantic-intelligence.test.ts
npm run test:intelligence

# Docker integration suites
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" npm run test:integration:db
REDIS_URL="redis://localhost:6379" DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" npm run test:integration:queue
REDIS_URL="redis://localhost:6379" DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" npm run test:integration:marketplace
REDIS_URL="redis://localhost:6379" DATABASE_URL="postgresql://postgres:postgres@localhost:5432/commerce_sync?schema=public" npm run test:integration:runtime
```
</details>

---

## Dependencies

Only dependencies directly present in `package.json` and `web/package.json`:

- **Backend Core**: Node.js, TypeScript, `cheerio` (DOM parsing), `zod` (validation)
- **Data & Queue**: `@prisma/client`, `prisma`, PostgreSQL 16, `bullmq`, `ioredis`, Redis 7
- **Frontend**: `react` 19, `react-dom`, `react-router-dom`, `vite`
- **Optional Runtime**: OpenAI Responses API integration (disabled by default)

---

## Operating Cost

The demonstration stack can operate entirely within free and Hobby tiers where available:

| Component | Local Demo | Production Demonstration |
| :--- | :--- | :--- |
| **Compute & API** | Local Node.js (Free / OSS) | Vercel Hobby (Free tier) |
| **Database** | Local Docker PostgreSQL (Free / OSS) | Supabase PostgreSQL Free Tier |
| **Queue & Cache** | Local Docker Redis 7 (Free / OSS) | Upstash Redis Free Tier |
| **Frontend CDN** | Local Vite Dev Server | Vercel Edge Network |
| **JakMall Access** | Public page access | Standard egress bandwidth |
| **Shopee API** | Local dry-run | Official API partnership |
| **Runtime AI** | Disabled by default | Optional token usage |

*(Note: Free and Hobby tiers are subject to provider terms and rate limits; permanent free pricing is not guaranteed).*

---

## Known Limitations

1. **No Live Shopee API Publishing**: Executed in local and cloud dry-run simulation mode due to lack of authorized partner credentials.
2. **Unverified Shopee Wire Compatibility**: Schemas follow public developer documentation; live remote wire protocol is unverified.
3. **Numeric Category ID Lookup**: Semantic category suggestions are generated, but numeric Shopee IDs require operator confirmation.
4. **Read-Only Review Queue**: The web UI visualizes flagged items; mutation endpoints for approving/rejecting are not exposed in the UI.
5. **Activity Record Dependency**: The activity page displays persisted `SyncJob` records and is truthfully empty before background jobs are queued.
6. **External Image Hosting**: Image URLs reference source JakMall CDN endpoints rather than independent cloud storage.
7. **Bounded Catalog Discovery**: Operates on configured store URLs with crawl limits; it does **not** crawl the entire JakMall marketplace.
8. **Scraper Maintenance Sensitivity**: Changes to upstream JakMall HTML layouts or JSON variable structures may require parser maintenance.
9. **Serverless Background Processing**: On Vercel serverless functions, background tasks execute within serverless invocation limits rather than an always-on BullMQ worker daemon. The persistent worker architecture remains fully represented in source (`src/queue/*`) and verified in local/container integration testing.

---

## Future Improvements

- **Official Shopee API**: Authenticate live Open Platform partner credentials.
- **Taxonomy Synchronization**: Ingest Shopee's official category tree into PostgreSQL for automatic numeric category resolution.
- **Remote Image Re-hosting**: Upload product images to Amazon S3 / Cloudflare R2 before marketplace creation.
- **Interactive Review UI**: Provide web-based approve, edit, and reject buttons for `NEEDS_REVIEW` items.
- **Background Synchronization**: Introduce scheduled incremental crawlers to detect supplier price/stock updates automatically.
- **Enterprise Observability**: Add OpenTelemetry distributed tracing and Prometheus metrics.

---

## AI Disclosure

### Development AI Assistance
Google Antigravity / AI coding assistants were used during development for:
- Boilerplate scaffolding and refactoring.
- Debugging and test case generation.
- Code reviews and documentation drafting.

*The candidate directed the architecture, established domain invariants, validated stock/pricing semantics, conducted code reviews, and verified all test results.*

### Runtime AI Sidecar
The repository contains an optional, bounded **Semantic Intelligence Sidecar**:
- Disabled by default (`AI_PROVIDER_MODE=DISABLED`).
- Functions strictly as an advisory sidecar (category hints, structural diagnostics).
- Cannot invent stock, modify authoritative prices, auto-approve review blockers, or mutate database state.

---

## Video Demo

- **Walkthrough**: `https://drive.google.com/file/d/1ms25l5jggzj3PpD0JTcStt_LbLA03l6c/view?usp=sharing`
- **Suggested Coverage**:
  1. JakMall catalog discovery on `https://www.jakmall.com/acmic-official-store`.
  2. Batch catalog import into PostgreSQL.
  3. Browsing products in the React Web UI.
  4. Inspecting product variants, SKU, and out-of-stock semantics.
  5. Generating Shopee listing draft with +20% markup.
  6. Reviewing `NEEDS_REVIEW` category gating and credential-protected safety boundary.

---

## Submission Details

- **GitHub Repository**: [https://github.com/Nachsyas/Jakmall-Project](https://github.com/Nachsyas/Jakmall-Project)
- **Submission Branch**: `phase6/web-catalog-ui`
- **Application Implementation Baseline**: `414b53402f3053a4f3ae8bd694d8a5e120060a3b`

---

## Additional Documentation

- [Project Status & Implementation Log](docs/project-status.md)
- [Project Checklist & Verification Records](PROJECT_CHECKLIST.md)
- [System Architecture Overview](docs/architecture/system-overview.md)
- [Known Limitations & Risk Mitigations](docs/known-limitations.md)
- [Shopee Integration Specification & State B Boundary](docs/marketplace/shopee-integration.md)
- [Phase 5E AI Integration Safety Gate](docs/architecture/phase5-ai-integration-safety-gate.md)
