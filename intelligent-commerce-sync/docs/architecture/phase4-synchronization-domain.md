# Phase 4B — Synchronization Domain Architecture

## Intelligent Commerce Sync: JakMall → Canonical → Persistence → Sync Planning → Marketplace

Last Updated: 2026-08-31
Status: IMPLEMENTED — AWAITING EXTERNAL AUDIT
Authoritative Domain: `src/sync/`

---

## 1. Architectural Phasing & Segregation of Responsibilities

The synchronization architecture strictly decouples change detection, sync planning, and job execution across three independent phases:

```text
+-------------------------------------------------------------------------+
| Phase 4A: Persistence & Change Detection                                |
| Question: "What changed?"                                               |
| - Deterministic stable serialization (stableSerialize)                   |
| - Granular SHA-256 field group hashes (source/content/price/stock/var)  |
| - Snapshot diff engine (diffSnapshotHashes / diffCanonicalSnapshots)    |
| Output: SnapshotDiffResult (classification, kinds, oldHashes, newHashes)|
+-------------------------------------------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
| Phase 4B: Synchronization Domain (Current Phase)                        |
| Question: "What should happen?"                                         |
| - Pure deterministic sync planner (planSync)                            |
| - Field ownership enforcement & seller content protection               |
| - Marketplace operation intent planning (CREATE_LISTING/PRICE/STOCK)    |
| - Review & blocker propagation, deterministic risk assessment           |
| - SyncJob finite state machine & transition rules                       |
| - Pure operation-level idempotency key derivation                       |
| Output: SyncPlan (status, operations, decisions, risk, requiresReview)  |
+-------------------------------------------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
| Phase 4C: Execution Infrastructure (Next Phase - NOT STARTED)           |
| Question: "How and when do we execute it reliably?"                     |
| - Redis & BullMQ job queue integration                                  |
| - Retry policies, exponential backoff, dead-letter queue (DLQ)          |
| - Background worker runtime, scheduler, and continuous polling loops     |
| - Marketplace adapter dispatch & verified remote execution              |
+-------------------------------------------------------------------------+
```

---

## 2. Synchronization Planning Matrix

The synchronization planner (`src/sync/planner.ts`) evaluates source snapshot diff truth against field ownership rules, listing lifecycle state, and inventory safety gates.

| Source Diff Classification | Conditions & Gates | Planned Operations | Plan Status | Risk Level | Rationale & Decisions |
|---|---|---|:---:|:---:|---|
| `NO_CHANGE` | Snapshots identical | None (`[]`) | `NO_ACTION` | `LOW` | `NO_SEMANTIC_CHANGE`: No marketplace operations required. |
| `FIRST_SNAPSHOT` | `listing.exists === false` | `CREATE_LISTING` (eligibility: `REQUIRES_REVIEW`) | `NEEDS_REVIEW` | `MEDIUM` | `FIRST_SNAPSHOT_NEW_LISTING`: Listing creation draft prepared, requires human review before publish. |
| `FIRST_SNAPSHOT` | `listing.exists === true` | None (`[]`) | `NEEDS_REVIEW` | `HIGH` | `FIRST_SNAPSHOT_EXISTING_LISTING`: Pre-existing listing detected; baseline reconciliation required before mutations. |
| `PRICE_CHANGED` | Valid `remoteListingId`, listing active | `UPDATE_PRICE` (eligibility: `ELIGIBLE`) | `READY` | `LOW` | `PRICE_CHANGE_DETECTED`: Source price change ready for marketplace update. |
| `INVENTORY_CHANGED` | `gates.inventory === "RESOLVED"` | `UPDATE_STOCK` (eligibility: `ELIGIBLE`) | `READY` | `LOW` | `INVENTORY_CHANGE_DETECTED`: Source stock change resolved by policy; ready for update. |
| `INVENTORY_CHANGED` | `gates.inventory === "NEEDS_REVIEW"` | `UPDATE_STOCK` (eligibility: `REQUIRES_REVIEW`) | `NEEDS_REVIEW` | `MEDIUM` | `INVENTORY_RESOLUTION_REQUIRED`: Undisclosed/ambiguous stock requires operator review. |
| `INVENTORY_CHANGED` | `gates.inventory === "BLOCKED"` | `UPDATE_STOCK` (eligibility: `BLOCKED`) | `BLOCKED` | `HIGH` | `INVENTORY_POLICY_BLOCKED`: Source stock blocked by safety invariant (e.g. unverified stock). |
| `CONTENT_CHANGED` | Title, description, or media changed | None (`[]`) | `NEEDS_REVIEW` | `MEDIUM` | `CONTENT_CHANGE_REQUIRES_REVIEW` + `SELLER_OWNED_FIELD_PROTECTED`: No automated write. |
| `VARIANTS_CHANGED` | SKU set, attributes, dimensions changed | None (`[]`) | `NEEDS_REVIEW` | `HIGH` | `VARIANT_STRUCTURE_CHANGE_REQUIRES_REVIEW`: Matrix topology change requires review. |
| `MULTIPLE_CHANGED` (`PRICE` + `INVENTORY`) | Resolved inventory & active listing | `UPDATE_PRICE`, `UPDATE_STOCK` (both `ELIGIBLE`) | `READY` | `LOW` | `MULTIPLE_CHANGES_DETECTED`: Both price and inventory updates are execution-ready. |
| Any change | Missing `remoteListingId` on existing listing | Operations withheld (`BLOCKED`) | `BLOCKED` | `HIGH` | `REMOTE_LISTING_ID_REQUIRED`: Cannot update marketplace listing without remote ID. |
| Any change | Listing status `BLOCKED`, `REJECTED`, or `FAILED` | Operations withheld (`BLOCKED`) | `BLOCKED` | `HIGH` | `LISTING_BLOCKED`: Inactive/blocked listing cannot receive updates. |
| Any change | Listing status `READY_FOR_REVIEW` or `DRAFT` | Operations withheld (`REQUIRES_REVIEW`) | `NEEDS_REVIEW` | `MEDIUM` | `LISTING_REVIEW_REQUIRED`: Unapproved listing draft cannot receive automatic updates. |

### 2.1 Listing Status Policy Specification

The synchronization planner enforces an explicit finite policy mapping for existing marketplace listings (`listing.exists === true`):

- **UPDATE-CAPABLE:**
  - `PUBLISHED`
  - `VERIFIED`
  *(Permits immediate execution of price and stock operations when inputs and gates are satisfied)*

- **REQUIRES REVIEW:**
  - `DRAFT`
  - `DRAFT_VALID`
  - `READY_FOR_REVIEW`
  - `EDIT_REQUIRED`
  - `NEEDS_REVIEW`
  - `APPROVED_FOR_PUBLISH`
  - `READY`
  *(Operations receive eligibility `REQUIRES_REVIEW`; plan status is `NEEDS_REVIEW`)*

- **BLOCKED:**
  - `BLOCKED`
  - `REJECTED`
  - `FAILED`
  - `PUBLISHING`
  - `VERIFYING`
  *(Operations receive eligibility `BLOCKED`; plan status is `BLOCKED`)*

- **No Listing (`listing.exists === false`):**
  - `status` MUST be absent (undefined).
  - `remoteListingId` MUST be absent or empty.
  - Supplying any `status` when `exists === false` is an inconsistent input and throws `SyncPlanningInputError`.

- **Missing Status on Existing Listing:**
  - If `listing.exists === true` and `listing.status` is absent, the planner emits structured decision `LISTING_STATUS_REQUIRED` and resolves to `BLOCKED`.

- **Unknown Runtime Status:**
  - Any unrecognized string throws `SyncPlanningInputError`.

---

## 3. Precedence and Atomic Safety Policy

### 3.1 Decision Precedence
When evaluating complex or multiple changes, status precedence resolves strictly as:

$$\text{BLOCKED} > \text{NEEDS\_REVIEW} > \text{READY} > \text{NO\_ACTION}$$

Risk precedence resolves strictly as:

$$\text{CRITICAL} > \text{HIGH} > \text{MEDIUM} > \text{LOW}$$

- If any single component or prerequisite is **BLOCKED**, the entire plan status is **`BLOCKED`**.
- If no blocker exists but any component requires review, the entire plan status is **`NEEDS_REVIEW`**.
- Only plans where all changes are safe and validated resolve to **`READY`**.

### 3.2 Atomic Execution Eligibility
In multi-change plans (such as `PRICE_CHANGED` + `CONTENT_CHANGED` or `PRICE_CHANGED` + blocked `INVENTORY_CHANGED`):
- If the overall plan is not execution-ready (`BLOCKED` or `NEEDS_REVIEW`), individual operations (such as `UPDATE_PRICE`) have their execution eligibility downgraded from `ELIGIBLE` to `BLOCKED` or `REQUIRES_REVIEW`.
- The Phase 4B plan marks all operations non-executable when the overall plan is blocked or requires review. Phase 4C must honor this eligibility contract before dispatch.

---

## 4. Field Ownership and Seller Protection

In accordance with [docs/product/field-ownership.md](docs/product/field-ownership.md), field ownership is partitioned into three discrete domains:

1. **Source-Owned (`SOURCE`):**
   - `SOURCE_PRICE` (`price.final`, `price.normal`, `price.list`)
   - `SOURCE_INVENTORY` (stock counts, availability flags)
   - `SOURCE_VARIANTS` (raw SKU combinations, attributes)
   - `SOURCE_WEIGHT`, `SOURCE_IMAGES`
   - *Policy:* System updates internal source representations automatically. Price and inventory changes generate sync operations if safe. Structural variant/image changes require review.

2. **System-Owned (`SYSTEM`):**
   - `SELLING_PRICE` (calculated via margin/markup rules)
   - `MARKUP_POLICY`, `SAFETY_STOCK`, `CATEGORY_MAPPING`, `ATTRIBUTE_MAPPING`, `SYNC_POLICY`, `RISK_DECISION`
   - *Policy:* Calculated deterministically by internal business rules. Never overwritten by external sources.

3. **Seller-Owned (`SELLER`):**
   - `MARKETING_TITLE` (custom SEO titles)
   - `CUSTOM_DESCRIPTION` (store terms, warranty notes, custom marketing copy)
   - `MANUAL_CATEGORY_OVERRIDE`, `PROMOTIONAL_CONTENT`, `SELLER_METADATA`
   - *Policy:* **STRICTLY FORBIDDEN** from being automatically overwritten by source synchronization. When `CONTENT_CHANGED` is detected, the planner records `SELLER_OWNED_FIELD_PROTECTED` and withholds automated marketplace writes.

---

## 5. Operation Intent vs. Execution Boundary

### 5.1 Strictly Supported Operations
Phase 4B defines operation intents that map strictly to existing Phase 3 marketplace capabilities:
- `CREATE_LISTING`
- `UPDATE_PRICE`
- `UPDATE_STOCK`

### 5.2 Explicitly Forbidden Operations
Phase 4B strictly does **NOT** invent non-existent marketplace operations:
- No `UPDATE_CONTENT`
- No `UPDATE_VARIANTS`
- No `UPDATE_DESCRIPTION`
- No `UPDATE_TITLE`

Content and variant matrix changes require human operator review, drafting, and explicit approval before any destination update can be scheduled.

### 5.3 Zero Remote Side Effects
Phase 4B produces pure data structures (`SyncPlan`, `SyncPlannedOperation`). It:
- Does NOT invoke `MarketplaceAdapter`
- Does NOT construct Shopee HTTP/REST payloads
- Does NOT fabricate remote IDs (`remoteListingId`, `remoteVariantId`)
- Does NOT execute network requests or database writes

---

## 6. Deterministic Operation Identity and Execution Idempotency

Phase 4B establishes a two-tiered identity model for planned marketplace operations:

1. **Base Operation Family Identity (`baseOperationKey`):**
   Derived directly from the Phase 3 `formatIdempotencyKey` contract to identify the product-level operation family:
   $$\text{baseOperationKey} = \text{marketplace} : \text{sellerAccountKey} : \text{source} : \text{sourceProductId} : \text{operationType}$$

2. **Execution Idempotency Key (`idempotencyKey`):**
   - **`CREATE_LISTING` (Product-Scoped):**
     $$\text{idempotencyKey} = \text{marketplace} : \text{sellerAccountKey} : \text{source} : \text{sourceProductId} : \text{CREATE\_LISTING}$$
     A source product has exactly one logical listing creation lifecycle across its history.
   - **`UPDATE_PRICE` / `UPDATE_STOCK` (Snapshot-Scoped):**
     $$\text{idempotencyKey} = \text{baseOperationKey} : \text{sourceSnapshotId}$$
     $$\text{idempotencyKey} = \text{marketplace} : \text{sellerAccountKey} : \text{source} : \text{sourceProductId} : \text{operationType} : \text{sourceSnapshotId}$$
     Execution idempotency is scoped to the persisted source snapshot identity (`sourceSnapshotId`). This allows multiple legitimate synchronization changes over time across successive snapshots, while strictly deduplicating retries, duplicate worker deliveries, and replanning for the same snapshot without violating Phase 4A unique constraint invariants.

**Properties:**
- **Deterministic:** Identical inputs yield identical keys across runs and restarts.
- **Differentiated:** Different supported operation types and different source snapshots produce distinct deterministic keys for the same validated marketplace, seller account, source, and product identity.
- **Separator-Safe:** Phase 4B validates non-empty components and rejects `:` separators across all keys and `sourceSnapshotId`. Therefore keys are deterministic, separator-safe under validated Phase 4B inputs, and compatible with Phase 3 formatting.
- **Pure:** Strictly contains no timestamps (`Date.now()`), random values (`randomUUID()`), or machine-specific tokens. Snapshot identity is supplied externally by the persistence layer and is never fabricated inside the sync planner.
- **Semantic:** An idempotency key represents operation intent identity, not proof of remote execution.

---

## 7. SyncJob State Machine Lifecycle

The `SyncJob` state machine (`src/sync/state-machine.ts`) governs the domain lifecycle of synchronization jobs using the locked Phase 4A `SyncJobStatus` enum:

```text
       +------------------+
       |     PENDING      |<------------------+
       +------------------+                   |
         |        |     \                     |
         |        |      +----------------+   |
         v        v                       v   |
   +----------+ +--------------+   +---------+|
   |PROCESSING| | NEEDS_REVIEW |   | BLOCKED ||
   +----------+ +--------------+   +---------+|
    /    |   \         |       \        |     |
   v     v    v        |        +-------+     |
+----+ +----+ +----+   |                |     |
|COMP| |FAIL| |CANC|   +----------------+     |
+----+ +----+ +----+            |             |
                                v             |
                           +---------+        |
                           | PENDING |--------+ (Re-plan / Re-queue)
                           +---------+
```

### 7.1 Transition Rules
- **Terminal States:** `COMPLETED` and `CANCELLED` have zero outgoing transitions.
- **Re-queuing States:** `FAILED`, `BLOCKED`, and `NEEDS_REVIEW` can transition back to `PENDING` when an operator approves or re-triggers synchronization.
- **Initial Mapping:**
  - `NO_ACTION` $\rightarrow$ `COMPLETED` (work already satisfied)
  - `READY` $\rightarrow$ `PENDING` (ready for worker pickup in Phase 4C)
  - `NEEDS_REVIEW` $\rightarrow$ `NEEDS_REVIEW` (operator review required)
  - `BLOCKED` $\rightarrow$ `BLOCKED` (safety invariant inhibited)

---

## 8. Truthful Environment & Status Declaration

In accordance with project evidence-first guidelines:

| Subsystem | Status | Verified Truth |
|---|:---:|---|
| **Database Engine** | PostgreSQL | Declared in `prisma/schema.prisma` |
| **PostgreSQL Connected** | **NO** | Pure domain layer; no database connection required |
| **Database Migrations Applied** | **NO** | `prisma migrate` / `db push` deferred to execution phase |
| **Prisma Client Runtime** | **NO** | No runtime queries, repositories, or transactions instantiated |
| **Job Queue (BullMQ / Redis)** | **NOT STARTED** | Execution infrastructure deferred to Phase 4C |
| **Worker / Scheduler Runtime** | **NOT STARTED** | Background polling runtime deferred to Phase 4C |
| **Continuous Sync Loops** | **NOT STARTED** | Background scheduler deferred to Phase 4C |
| **Remote Marketplace Mutations** | **NONE** | Zero live remote calls or payload constructions performed |
| **Shopee API Wire Protocol** | **UNVERIFIED** | Phase 3 State B limitations strictly preserved |
| **Phase 4A Contracts** | **LOCKED** | Hashing, diffing, and schema remain 100% intact |
| **PROJECT_CHECKLIST.md** | **UNCHANGED** | Phase 4A certification locked; awaiting Phase 4B external audit |
