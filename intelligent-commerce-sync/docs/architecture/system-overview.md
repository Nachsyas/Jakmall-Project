# System Overview & Architecture

Technical Project Test: JakMall Product Scraper & Shopee Listing Automation.
This document defines the authoritative, implemented architecture at the certified Phase 5 implementation baseline: `778041c74e85a30e0abcd058ee8a4cfe75cde0e5`.

---

## 1. Architectural Style: Modular Monolith

The platform adopts a **Modular Monolith** pattern in TypeScript strict mode. This architecture provides bounded contexts, high cohesion, in-process modular calls between core domain modules, and is testable without distributed-service coordination.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    CURRENT IMPLEMENTED ARCHITECTURE                               │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘

  [JakMall Product URL]
           │
           ▼
  ┌─────────────────────────────────┐
  │  Source Engine (src/jakmall/)   │  • SSRF Safe Allowlist Client (Static HTTP First)
  │                                 │  • Balanced-Brace Parser for spdt (Zero eval)
  │                                 │  • Schema.org JSON-LD Fallback Extractor
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │  Canonical Model (src/canonical)│  • CanonicalProduct, Variant Matrix (Previous Ordering)
  │                                 │  • Strict Stock Semantics (OOS, Exact Limited, Undisclosed)
  │                                 │  • Strict Price Semantics (Missing/Null/Zero Rejected)
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Marketplace Policy & Review     │  • ShopeeListingDraft Preparation (Markup, IDR Rounding)
  │ (src/marketplace/shopee/)       │  • Deterministic Inventory Policy (OOS=0, Undisclosed Gate)
  │                                 │  • Human Review: applyHumanReview() in builder.ts
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Persistence & Idempotency       │  • PostgreSQL 16 via Prisma ORM
  │ (src/persistence/)              │  • Snapshots, Listings, SyncJobs, IdempotencyRecords
  │                                 │  • Append-only SyncEvents and AuditLogs
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Sync Planner & State Machine    │  • Field Diffing (Price, Inventory, Content, Variants)
  │ (src/sync/)                     │  • Snapshot-Scoped Idempotency Key Derivation
  │                                 │  • Explicit SyncJobStatus Transitions & Terminal Guards
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Queue & Worker Runtime          │  • Redis 7 + BullMQ Job Queue
  │ (src/queue/, src/runtime/)      │  • Minimal Queue Reference: { schemaVersion: 1, syncJobId }
  │                                 │  • Worker Payload Hydration, Retry Backoff, Collision Guard
  │                                 │  • Scheduler & StaleProcessingRecovery Maintenance
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Marketplace Execution Boundary  │  • State B Operating Boundary
  │ (src/marketplace/shopee/adapter.│  • Dry-Run Mode (Simulated Payload Generation)
  │  ts, src/execution/marketplace/)│  • Publish Mode (Fails closed: BLOCKED_BY_CREDENTIALS)
  └────────────────┬────────────────┘
                   │
                   ▼
  ┌─────────────────────────────────┐
  │ Read-After-Write Verifier       │  • ShopeeListingVerifier (shopee/verifier.ts)
  │ (src/marketplace/shopee/        │  • Durable Phase 4 verification:
  │  verifier.ts,                   │    src/execution/marketplace/verification.ts
  │  src/execution/marketplace/     │  • Detects VERIFY_MISMATCH / VERIFY_NOT_FOUND
  │  verification.ts)               │
  └─────────────────────────────────┘

   ▲                               ▲                               ▲
   │                               │                               │
   │ (Advisory Mapping)            │ (Advisory Review Anomaly)     │ (Advisory Recovery Guidance)
   │                               │                               │
┌──┴───────────────────────────────┴───────────────────────────────┴────────────────────────────────┐
│                           SEMANTIC INTELLIGENCE SIDECAR (OPTIONAL)                                │
│                                                                                                   │
│  ┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐          │
│  │ Catalog Intelligence    │   │ Review Intelligence     │   │ Parser Recovery         │          │
│  │ (src/intelligence/      │   │ (src/intelligence/      │   │ (src/intelligence/      │          │
│  │  catalog/)              │   │  review/)               │   │  parser-recovery/)      │          │
│  │ • Deterministic Normal. │   │ • Heuristic Anomaly Det.│   │ • Non-Semantic Blocker  │          │
│  │ • Verified Store Memory │   │ • Non-escalating INFO   │   │   Dominance (HTTP/SSRF) │          │
│  │ • AI Suggestion + Review│   │   AI Display Finding    │   │ • Structural Guidance   │          │
│  └────────────┬────────────┘   └────────────┬────────────┘   └────────────┬────────────┘          │
│               │                             │                             │                       │
│               └─────────────────────────────┼─────────────────────────────┘                       │
│                                             ▼                                                     │
│                        ┌─────────────────────────────────────────┐                                │
│                        │ SemanticIntelligenceService (Phase 5A)  │                                │
│                        │ • Canonical Request Serialization       │                                │
│                        │ • Deterministic Request ID Calculation  │                                │
│                        │ • Strict Candidate & Evidence Allowlists│                                │
│                        │ • Runtime Zod Schema Validation         │                                │
│                        └────────────────────┬────────────────────┘                                │
│                                             │                                                     │
│                                             ▼                                                     │
│                        ┌─────────────────────────────────────────┐                                │
│                        │ LiveAiProvider & Safety Gate (Phase 5E) │                                │
│                        │ • Native fetch (OpenAI Responses API)   │                                │
│                        │ • Fixed Model: gpt-5.6-luna             │                                │
│                        │ • Strict Own-Property Privacy Gate      │                                │
│                        │ • Character Request Budget (default 16k)│                                │
│                        │ • Process Call Ceiling (default 1,000)  │                                │
│                        │ • Sliding Rate Limiter (60 req / 60s)   │                                │
│                        │ • 3-State Circuit Breaker (CLOSED/OPEN) │                                │
│                        │ • Decoupled Authoritative Usage Ledger  │                                │
│                        │ • Default Mode: AI_PROVIDER_MODE=DISABLED                                │
│                        └─────────────────────────────────────────┘                                │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Domain Modules

### A. Source Engine (`src/jakmall/`)
- **`client.ts`**: Static HTTP client enforcing SSRF protection via hostname allowlisting (`jakmall.com`, `www.jakmall.com`), blocking private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.1`), and AWS metadata IP (`169.254.169.254`).
- **`parser.ts`**: Balanced-brace parser that scans string characters and braces to extract embedded `var spdt = { ... }` objects safely without invoking JavaScript `eval()` or `Function()`. Provides schema.org JSON-LD fallback for plain and namespaced product descriptions.
- **`normalizer.ts`**: Maps raw extracted payloads to `CanonicalProduct`, preserving distinct source SKU IDs, merchant SKUs, and display SKUs.
- **`adapter.ts`**: Implements the `SourceAdapter` interface (`fetchProduct`, `verifySource`).

### B. Canonical Layer (`src/canonical/`)
- **Strict Invariants**:
  - *Price Safety*: Prices must be strictly positive finite numbers. Missing, null, or non-positive prices throw errors and never default to Rp0.
  - *Stock Safety*: Distinguishes confirmed OOS (`quantity: 0, available: false`), exact limited stock (`quantity: n, available: true`), undisclosed stock (`quantity: undefined, available: true`), and inconsistent/missing stock (`available: null`, fails closed).
  - *Variant Matrix*: Multi-dimensional combinatorial variants are resolved using the source's `previous` ordering dimension without data loss.

### C. Marketplace Policy & Review (`src/marketplace/shopee/`, `src/execution/marketplace/`, `src/intelligence/review/`)
- **Shopee Preparation, Policy & Review (`src/marketplace/shopee/`)**:
  - `builder.ts`: Implements `buildShopeeDraft()` and `applyHumanReview()`, evaluating drafts and human review decision gates (`APPROVE`, `REJECT`, `EDIT_REQUIRED`) with hard blocker enforcement.
  - `policy.ts`: Applies deterministic pricing markup, fee buffers, ceiling rounding to IDR increments, and inventory allocation policies.
  - `mapper.ts`: Maps canonical products to Shopee listing drafts with attribute and variation mapping.
  - `adapter.ts`: `ShopeeMarketplaceAdapter` provides the State B marketplace adapter boundary.
  - `verifier.ts`: Phase 3 `ShopeeListingVerifier` performs read-after-write verification comparing expected canonical state with listing attributes.
- **Marketplace Durable Execution (`src/execution/marketplace/`)**:
  - `gateway.ts`, `marketplace-sync-job-executor.ts`, `types.ts`, and `verification.ts` provide durable execution and read-after-write execution verification for marketplace operations.
- **Review Intelligence (`src/intelligence/review/`)**:
  - `ReviewIntelligenceService` provides multi-signal anomaly review producing non-escalating advisory annotations (`AI_ANOMALY_ANNOTATION` INFO severity).

### D. Persistence & Idempotency (`src/persistence/`)
- **PostgreSQL 16 via Prisma**:
  - `Product` & `ProductSource`: Authoritative catalog entities.
  - `SourceSnapshot`: Point-in-time canonical product snapshot plus source/content/price/inventory/variant hashes.
  - `MarketplaceListing` & `MarketplaceListingVariant`: Durable destination listing records.
  - `SyncJob`: Durable sync execution records with attempt counts, locked version numbers, and status.
  - `IdempotencyRecord`: Enforces unique execution keys at the database level.
  - `SyncEvent` & `AuditLog`: Append-only persisted operational event history and human/system audit records; persistence models and repositories support tested `SyncEvent` and `AuditLog` history.

### E. Synchronization Domain (`src/sync/`)
- **Diff Engine**: Computes granular change sets between consecutive snapshots across four dimensions: `PRICE_CHANGED`, `INVENTORY_CHANGED`, `CONTENT_CHANGED`, and `VARIANTS_CHANGED`.
- **Sync Planner**: Plans deterministic operations (`CREATE_LISTING`, `UPDATE_PRICE`, `UPDATE_STOCK`). Enforces seller-owned field protection (e.g. seller-customized descriptions are protected from automated source overwrites).
- **Idempotency Keys**: Generates deterministic, collision-resistant keys:
  - `CREATE_LISTING`: Product-scoped (`marketplace:sellerAccount:source:sourceProductId:CREATE_LISTING`).
  - `UPDATE_PRICE` / `UPDATE_STOCK`: Snapshot-scoped (`<baseKey>:<sourceSnapshotId>`).

### F. Queue, Worker & Runtime Hardening (`src/queue/`, `src/runtime/`)
- **Redis 7 + BullMQ**: Asynchronous background execution. The queue payload contains only `{ schemaVersion: 1, syncJobId }`. The worker loads authoritative data from PostgreSQL within a transaction, ensuring durable consistency.
- **`SyncScheduler`**: Scans for unqueued `PENDING` jobs and enqueues them into BullMQ.
- **`StaleProcessingRecovery`**: Identifies jobs stuck in `PROCESSING` beyond stale timeouts (default 5 minutes) due to node/process crashes and safely recovers them to `PENDING`.
- **`PeriodicMaintenanceLoop`**: Orchestrates scheduled maintenance sweeps in the background.

---

## 3. Semantic Intelligence Sidecar Architecture

The semantic intelligence subsystem (`src/intelligence/`) is designed as an **isolated, advisory sidecar**. It cannot execute state mutations or override deterministic business decisions.

1. **Phase 5A Core Service (`SemanticIntelligenceService`)**:
   - Generates deterministic request IDs using SHA-256 over canonicalized task inputs (zero timestamps or random tokens).
   - Enforces candidate and evidence allowlists; rejects any provider output referencing unknown candidate IDs.
   - Prohibits price, stock, or execution payload mutation by schema definition.
2. **Phase 5B Catalog Intelligence (`CatalogIntelligenceService`)**:
   - Normalizes category/attribute lookup keys.
   - Checks local `VerifiedMappingStore` memory first; verified matches resolve deterministically with zero AI calls.
   - AI suggestions always require human review (`reviewRequired: true`).
3. **Phase 5C Review Intelligence (`ReviewIntelligenceService`)**:
   - Analyzes suspicious price drops or mapping anomalies.
   - Produces strictly advisory display annotations (`AI_ANOMALY_ANNOTATION` INFO severity).
   - Cannot clear, modify, or downgrade deterministic blocking findings.
4. **Phase 5D Parser Recovery (`ParserRecoveryService`)**:
   - Evaluates scraper failures. Non-semantic errors (SSRF blocked, HTTP 429, HTTP 404, timeouts) dominate and bypass AI completely.
   - Suggests structural diagnostic advice without generating executable code or selectors.
5. **Phase 5E Live AI Provider (`LiveAiProvider`)**:
   - Direct HTTP client targeting OpenAI Responses API (`gpt-5.6-luna`) at `https://api.openai.com/v1/responses`.
   - Bounded by strict own-property privacy gates rejecting forbidden secret-bearing property names, unknown keys, and provenance mismatches before network dispatch.
   - Character request budget (default 16,000 chars; bounds: 500..50,000), process request ceiling (default 1,000 calls; bounds: 1..100,000), sliding-window rate limiter (default 60 req / 60s; bounds: 1..1,000 req / 1,000..600,000 ms), and a 3-state circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`).
   - Default mode is `DISABLED`. Authoritative usage accounting is decoupled from semantic acceptance.

---

## 4. Possible Future Architecture (Hypothetical Only — Not Implemented)

The following components are recognized as potential future enhancements but are **NOT implemented** in the current codebase:

- **Operator Dashboard (Hypothetical)**: Potential future web interface for operator review queues and manual attribute overrides.
- **Multi-Marketplace Support (Hypothetical)**: Potential future expansion to additional marketplace platforms.
- **Cloud Deployment (Hypothetical)**: Potential future cloud infrastructure templates if distributed multi-node deployment is ever required. (Current architecture operates cleanly in a local Docker Compose environment without cloud dependencies).
