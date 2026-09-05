# Intelligent Commerce Sync

### JakMall Product Scraper & Shopee Listing Preparation

A working Proof of Concept that discovers products from a configured public JakMall catalog, imports and normalizes product data, stores the catalog locally, and prepares products for Shopee using deterministic pricing, inventory, category mapping, and human-review safety gates.

> **Note**: No individual product URL is required for the normal demo flow.

---

## Demo Snapshot

| Metric / Endpoint | Certified Result |
|---|---:|
| **Products Discovered** | 20 |
| **Products Imported** | 20 |
| **Failed Imports** | 0 |
| **Automated Tests** | 643 / 643 PASS |
| **Web UI** | [http://localhost:3000](http://localhost:3000) |
| **API Health** | [http://localhost:3001/api/health](http://localhost:3001/api/health) |

[Quick Start](#quick-start) · [Demo Flow](#demo-flow) · [Reviewer Demo](#5-minute-reviewer-demo) · [Architecture](#architecture) · [API](#api) · [Known Limitations](#known-limitations)

---

## Screenshots

Real screenshots from the final Phase 6 web application.

| Overview | Product Catalog |
|---|---|
| <img src="docs/screenshots/home.png" alt="Intelligent Commerce Sync overview" width="100%"> | <img src="docs/screenshots/products.png" alt="Imported JakMall product catalog" width="100%"> |

| Catalog Sync | Shopee Preparation |
|---|---|
| <img src="docs/screenshots/sync.png" alt="JakMall catalog discovery and sync" width="100%"> | <img src="docs/screenshots/product-detail.png" alt="Product detail and Shopee listing preparation" width="100%"> |

- **Overview** — application summary and current catalog state.
- **Product Catalog** — normalized products imported from the configured public JakMall catalog.
- **Catalog Sync** — bounded automatic catalog discovery/import workflow.
- **Shopee Preparation** — deterministic listing preparation with pricing, inventory, category, and review safeguards.

---

## What This Project Solves

Transferring product catalogs manually from JakMall into Shopee is error-prone and labor-intensive:
- Copying titles, descriptions, and media across browser tabs.
- Flattening multi-dimensional variant combinations (color, size) while preserving unique SKUs.
- Recalculating commercial margins (+20% markup with IDR 1.000 ceiling rounding).
- Handling inventory truth: preventing undisclosed stock from being fabricated as numeric quantities.
- Mapping third-party categories and attributes into Shopee-compliant taxonomies.

This PoC turns that manual workload into a controlled automated and semi-automated pipeline with built-in operator review gates.

---

## Demo Flow

```mermaid
flowchart TD
    A[JakMall Public Catalog] --> B[Automatic Product Discovery]
    B --> C[Controlled Batch Import]
    C --> D[JakMall Parser / Source-Shape Validation]
    D --> E[CanonicalProduct]
    E --> F[PostgreSQL]
    F --> G[Thin HTTP API]
    G --> H[React Web Application]
    H --> I[Product Detail]
    I --> J[Prepare for Shopee]
    J --> K[Pricing + Inventory + Category Mapping]
    K --> L[Human Review if Required]
    L --> M[Dry Run / Credential-Gated Boundary]
```

Normal demo usage does **not** require individual product URLs. Products are discovered automatically from the configured public catalog/store, subject to safety limits and available public catalog pages.

---

## What Works

| Capability | Status | Notes |
| :--- | :---: | :--- |
| **Automatic Catalog Discovery** | ✅ Implemented | Discovers product links from public store pages with crawl limits. |
| **Batch Catalog Import** | ✅ Implemented | Sequential parsing, failure isolation, and transactional DB persistence. |
| **Product Extraction** | ✅ Implemented | Static HTTP client + Cheerio DOM parsing + custom balanced-brace parser (zero `eval`). |
| **Canonical Normalization** | ✅ Implemented | Normalizes to `CanonicalProduct` with source, merchant, and display SKUs. |
| **Images / Variants / SKU** | ✅ Implemented | Full gallery extraction and multi-dimensional variant matrix resolution. |
| **Strict Stock Semantics** | ✅ Implemented | Exact stock preserved; confirmed out-of-stock = 0; undisclosed stock = `undefined` (never 0). |
| **Pricing Policy** | ✅ Implemented | Non-positive prices fail closed; deterministic +20% margin with IDR 1.000 rounding. |
| **Shopee Draft Preparation** | ✅ Implemented | Evaluates listing properties, pricing rules, and category mapping. |
| **Human Review Gate** | ✅ Implemented | Unverified categories/attributes transition to `NEEDS_REVIEW` with `canPublish: false`. |
| **PostgreSQL Persistence** | ✅ Implemented | Prisma ORM storing products, point-in-time snapshots, sync events, and audit logs. |
| **Redis / BullMQ Runtime** | ✅ Implemented | Durable asynchronous queue with idempotency keys and retry handling. |
| **React Web UI** | ✅ Implemented | Responsive Apple-inspired interface across desktop, tablet, and mobile. |
| **Status / Error Handling** | ✅ Implemented | Sanitized API errors (no stack trace leaks); SSRF domain allowlisting (`jakmall.com`). |
| **Live Shopee Publication** | ⚠️ Not claimed | Authenticated remote API write is not performed due to unavailable partner credentials. |

*Certified live run result: **20 discovered / 20 imported / 0 failed**.*

### Cross-Store Compatibility

The source adapter was live-validated across multiple public JakMall stores and source shapes:

| Public Catalog | Discovered | Imported | Failed |
|---|---:|---:|---:|
| ACMIC Official Store | 20 | 20 | 0 |
| Freedom Store | 30 | 30 | 0 |
| LStore | 10 | 10 | 0 |

The Freedom Store validation exposed a legitimate single-SKU source shape where:
- `variants = []`
- `matrix = null`

The parser now explicitly supports both:
- Object-based multi-variant product structures
- Observed single-SKU no-matrix structures

while unsupported malformed primitive shapes still fail closed.

> **Note**: This pipeline is live-validated across three public JakMall catalogs and supports observed legitimate source shapes. It does not claim universal compatibility with every arbitrary future page format on JakMall.

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
> - Default `DATABASE_URL` and `REDIS_URL` in `.env.example` point to the local Docker services.
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

1. **Open the Web UI**: Visit `http://localhost:3000` to see the live catalog overview and metrics.
2. **Open Products**: Navigate to `/products`. Browse persisted items or search using `"PowerBank"`.
3. **Open Sync JakMall**: Navigate to `/sync` (pre-filled with `https://www.jakmall.com/acmic-official-store`).
4. **Preview Discovery**: Click **Preview Discovery** to inspect extracted product URLs and page depth.
5. **Batch Import**: Click **Import Discovered Products** once. Watch the single-flight concurrency lock and live progress (*Certified run: 20 discovered, 20 imported, 0 failed*).
6. **Inspect Product Detail**: Return to `/products` and select `PreorderACMIC C8 8000mAh PowerBank`.
7. **Verify Stock & Variants**: Review the variants table. Confirm stock semantics: both variants indicate `"Out of stock"` (`quantity: 0`) rather than fabricated numbers.
8. **Prepare for Shopee**: Click **Prepare for Shopee**.
   - Selling price: `Rp 348.000` (+20% margin from `Rp 289.900`).
   - Category suggestion: `Aksesoris Handphone > Charger & Kabel > Kepala Charger`.
   - Review state: `NEEDS_REVIEW (rule)` — flagged because numeric Shopee ID requires operator lookup.
   - Publishable: `False (Gated)` — strictly prevents unverified publication.
9. **Review & Activity**: Visit `/reviews` and `/activity` to view the operator queue and job execution logs.
10. **Shopee Credential Boundary**: Note that the marketplace dry-run protects the boundary when live credentials are absent.

*(Public JakMall page content may change over time; the 20-product count reflects the certified benchmark run).*

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
    CATALOG[Catalog / Product / Shopee Services]
    DISCOVERY[Catalog Discovery]
    SOURCE[JakMall Source Adapter]
    PARSER[Parser + Normalizer]
    CANONICAL[CanonicalProduct]
    DB[(PostgreSQL)]
    POLICY[Shopee Policy Engine]
    REVIEW[Review Gate]
    REDIS[(Redis / BullMQ)]
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

> [!NOTE]
> **Advisory Sidecar Isolation**: Runtime AI is strictly optional and advisory. It **cannot** override authoritative prices, mutate inventory truth, bypass human review gates, or directly write to the database.

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

The local HTTP API runs on port `3001` with strict Zod request validation:

| Method | Endpoint | Purpose | Validation Bounds |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Health check & connectivity status | None |
| `GET` | `/api/products` | Paginated product catalog | `limit <= 100`, `offset >= 0` |
| `GET` | `/api/products/:id` | Detailed product record with variants | Valid UUID |
| `POST` | `/api/catalog/discover` | Discovers product URLs from store | `maxProducts <= 100`, `maxPages <= 10` |
| `POST` | `/api/catalog/import` | Ingests and persists store products | `maxProducts <= 50`, `maxPages <= 5` |
| `POST` | `/api/products/:id/prepare-shopee` | Evaluates Shopee preparation rules | Dry-run gated |
| `GET` | `/api/reviews` | Operator review queue | None |
| `GET` | `/api/jobs` | Background sync job history | None |

<details>
<summary><strong>Catalog Import Request Example</strong></summary>

```http
POST /api/catalog/import HTTP/1.1
Host: localhost:3001
Content-Type: application/json

{
  "url": "https://www.jakmall.com/acmic-official-store",
  "maxProducts": 20,
  "maxPages": 2,
  "persist": true
}
```
</details>

---

## Shopee Preparation & Safety Boundary

| Implemented & Verified Locally | Not Claimed / Boundary Guarded |
| :--- | :--- |
| ✔ Normalized Shopee listing draft generation | ✖ Successful live Shopee listing creation |
| ✔ Deterministic pricing (+20% margin, commercial rounding) | ✖ Verified production Shopee API network write |
| ✔ Strict inventory mapping (0 preserved, undisclosed gated) | ✖ Live remote read-after-write verification |
| ✔ Category mapping & attribute suggestion engine | ✖ Automatic unverified numeric category publishing |
| ✔ Blocker and warning evaluation (weight, brand, review) | ✖ Credential or 2FA/CAPTCHA bypass |
| ✔ Dry-run execution boundary with credential guard | ✖ Remote marketplace success without credentials |

> [!IMPORTANT]
> **Category Review Rule**: If a numeric Shopee category ID cannot be verified, the product enters `NEEDS_REVIEW` instead of receiving a fabricated category ID. Live Shopee publication was not executed because authorized official Open Platform credentials were unavailable for this assessment environment.

---

## Reliability & Security

- **SSRF Defense**: Strict allowlisting (`jakmall.com`, `www.jakmall.com`) blocking private IPs, loopback, and metadata endpoints.
- **Zero Eval Execution**: Static HTTP client + Cheerio DOM parsing + custom balanced-brace object extraction (zero `eval`).
- **Fail-Closed Pricing**: Missing or non-positive prices immediately throw normalization errors (no Rp0 listings).
- **Strict Stock Semantics**: Undisclosed stock remains `undefined`; confirmed out-of-stock is preserved as `0`.
- **Bounded Ingestion**: Enforced limits on request bodies, crawl depth, and pagination scans.
- **Idempotency**: Deterministic hash-based operation keys prevent duplicate listing creations or updates.
- **Queue Fault Tolerance**: Redis 7 and BullMQ provide exponential backoff retry and stale-job recovery.
- **Information Protection**: API errors suppress stack traces; local development CORS allowlist enforced; `.env` excluded from version control.

---

## Testing

Final certified regression status: **643 / 643 PASS, 0 FAIL**

| Test Suite | Command / Scope | Tests |
| :--- | :--- | :---: |
| **Root / API / UI** | `npm test` (`tests/*.test.ts`) | 264 |
| **Intelligence Subdirectories** | `npm run test:intelligence` (`tests/intelligence/**/*.test.ts`) | 224 |
| **Standalone Semantic Intelligence** | `npx tsx --test tests/intelligence/semantic-intelligence.test.ts` | 82 |
| **PostgreSQL Integration** | `npm run test:integration:db` | 14 |
| **Queue Integration** | `npm run test:integration:queue` | 21 |
| **Marketplace Integration** | `npm run test:integration:marketplace` | 18 |
| **Runtime Integration** | `npm run test:integration:runtime` | 20 |
| **Total Unique Tests** | | **643** |

```bash
# Verify backend types
npm run typecheck

# Verify frontend types and production build (runs tsc -b && vite build)
npm run build:web

# Run core flat test suite
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

> **No paid third-party service is required for the certified local demo.**

| Component | Local Demo | Production Considerations |
| :--- | :--- | :--- |
| **Node.js / TypeScript** | Free / OSS | Standard container hosting |
| **React / Vite** | Free / OSS | Static CDN hosting |
| **PostgreSQL** | Local Docker | Managed DB (e.g., AWS RDS) |
| **Redis** | Local Docker | Managed cache (e.g., AWS ElastiCache) |
| **JakMall Access** | Public page access | Egress bandwidth & rate limiting |
| **Shopee Preparation** | Local dry-run | Official API partnership |
| **Runtime AI** | Disabled / Optional | Token usage cost if enabled |

*(Normal local workstation hardware, electricity, and network connections are excluded).*

---

## Known Limitations

1. **No Live Shopee API Publishing**: Executed in local dry-run simulation mode due to lack of authorized partner credentials.
2. **Unverified Shopee Wire Compatibility**: Schemas follow public developer documentation; live remote wire protocol is unverified.
3. **Numeric Category ID Lookup**: Semantic category suggestions are generated, but numeric Shopee IDs require operator confirmation.
4. **Read-Only Review Queue**: The web UI visualizes flagged items; mutation endpoints for approving/rejecting are not exposed in the UI.
5. **Activity Record Dependency**: The activity page displays persisted `SyncJob` records and is truthfully empty before background jobs are queued.
6. **External Image Hosting**: Image URLs reference source JakMall CDN endpoints rather than independent cloud storage.
7. **Bounded Catalog Discovery**: Operates on configured store URLs with crawl limits; it does **not** crawl the entire JakMall marketplace.
8. **Scraper Maintenance Sensitivity**: Changes to upstream JakMall HTML layouts or JSON variable structures may require parser maintenance.
9. **No Production Cloud Deployment**: Validated in containerized local environments; no cloud deployment is claimed.

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

- **Walkthrough**: `<ADD VIDEO LINK BEFORE SUBMISSION>`
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
- **Application Implementation Baseline**: `da72ae1adcec6e13a3352b972dfeae2267c163e8`

---

## Additional Documentation

- [Project Status & Implementation Log](docs/project-status.md)
- [Project Checklist & Verification Records](PROJECT_CHECKLIST.md)
- [System Architecture Overview](docs/architecture/system-overview.md)
- [Known Limitations & Risk Mitigations](docs/known-limitations.md)
- [Shopee Integration Specification & State B Boundary](docs/marketplace/shopee-integration.md)
- [Phase 5E AI Integration Safety Gate](docs/architecture/phase5-ai-integration-safety-gate.md)
