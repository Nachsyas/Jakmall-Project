# Phase 4C.3 Architecture: Marketplace Execution Coordinator

## Overview

Phase 4C.3 introduces the **Marketplace Execution Coordinator** (`MarketplaceSyncJobExecutor`), connecting the durable BullMQ worker infrastructure established in Phase 4C.2 to an operation-aware marketplace execution layer supporting:

- `CREATE_LISTING` (with publication persistence, transactional variant mapping reconciliation, and normalized read-after-write target verification of title when supplied by the normalized read gateway, variant count, destination SKU, price, and resolved stock)
- `UPDATE_PRICE` (with target price mutations and read-after-write price verification)
- `UPDATE_STOCK` (with exact target stock mutations, preserving zero without re-applying safety stock policies)

> **Important Boundary Note**: Marketplace execution coordinator is **VERIFIED AGAINST A DETERMINISTIC INJECTED GATEWAY**. No live Shopee network wire protocol or unverified remote endpoints were invented or executed. Explicitly: **no live Shopee publication or read has been performed**. External network transport remains fail-closed.

---

## Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                               BullMQ Queue                              |
|                   (Payload: { schemaVersion: 1, syncJobId })            |
+------------------------------------+------------------------------------+
                                     |
                                     v
+------------------------------------+------------------------------------+
|                         SyncExecutionWorker                             |
|  - Status-conditional atomic claim (PENDING/FAILED -> PROCESSING)       |
|  - Authoritative executionPayload loaded from PostgreSQL                |
+------------------------------------+------------------------------------+
                                     |
                                     v
+------------------------------------+------------------------------------+
|                      MarketplaceSyncJobExecutor                         |
|  1. Asserts operationType alignment and execution-readiness            |
|  2. Validates authoritative DB relations (ProductSource, Listings)      |
|  3. Runs local target preflight BEFORE remote mutation (for CREATE)     |
|  4. Constructs Normalized Marketplace Command                           |
|  5. Dispatches mutation via MarketplaceExecutionGateway                 |
|  6. Reconciles local publication records & variants transactionally     |
|  7. Performs Read-After-Write verification via readListingState         |
|  8. On mismatch: emits VERIFY_MISMATCH event, sets NEEDS_REVIEW,        |
|     throws MARKETPLACE_VERIFY_MISMATCH error                            |
|  9. On success: updates local MarketplaceListing/Variant state          |
+-------------------------------------------------------------------------+
```

---

## Key Design Decisions & Invariants

### 1. Normalized Internal Execution Contract
All marketplace commands and verification structures are defined in `src/execution/marketplace/types.ts` as an **internal normalized contract** (not official wire payloads):
- `CreateListingCommand`: Contains frozen reviewed content, categories, attributes, destination SKUs, prices, and resolved stock. Contains zero credentials, partner keys, or access tokens.
- `UpdatePriceCommand`: Contains `remoteListingId` and per-variant absolute `targetPriceIdr`.
- `UpdateStockCommand`: Contains `remoteListingId` and per-variant absolute `targetQuantity` (preserving `0` as exact quantity).
- `NormalizedRemoteListingState`: Adapter-normalized read representation for verification (`remoteListingId`, `title`, `variants` with `destinationSku`, `priceIdr`, `stock`).

### 2. PostgreSQL Authoritative Durable Payload
The execution payload stored in `SyncJob.executionPayload` is the single source of truth for execution intent:
- BullMQ holds only `{ schemaVersion: 1, syncJobId }`.
- No marketplace business payloads or secrets exist in Redis.
- The durable payload is never modified, re-markuped, or re-evaluated against environment policy at execution time.

### 3. Distributed Transaction Boundary & Gateway Idempotency
- Remote marketplace mutations cannot participate in local PostgreSQL ACID transactions.
- The executor forwards the durable `job.idempotencyKey` inside each normalized mutation command.
- In this phase, the deterministic TEST gateway deduplicates `marketplace + sellerAccountKey + idempotencyKey` to simulate idempotency safely in test environments.
- Do NOT assume live marketplace platforms (such as Shopee) natively provide automatic idempotency keys for all endpoints. A future authorized live gateway must implement and prove an equivalent safe idempotency strategy before live CREATE is enabled.
- Upon retry, the executor checks `job.marketplaceListingId` or searches by `(marketplace, sellerAccountKey, remoteListingId)` to reuse existing local records without creating duplicate listing rows.

### 4. Read-After-Write Verification & Mismatch Handling
- Every mutation is followed by `gateway.readListingState(remoteListingId)`.
- If the remote listing is not found, `MarketplaceVerifyNotFoundError` (`MARKETPLACE_VERIFY_NOT_FOUND`) is thrown.
- If remote values differ from durable intent (or remote listing ID does not match expected):
  1. A `SyncEvent` (`VERIFY_MISMATCH`) is persisted with structured mismatch details (`field`, `expected`, `actual`, `sourceSkuId`).
  2. `MarketplaceListing.status` is set to `NEEDS_REVIEW` and `lastVerifiedAt` is updated.
  3. `MarketplaceVerifyMismatchError` (`MARKETPLACE_VERIFY_MISMATCH`) is thrown.
  4. The queue worker catches the error, transitions `SyncJob` from `PROCESSING -> FAILED`, writes sanitized failure metadata, and records a `SYNC_FAILED` event.
  5. The job is **NEVER** marked `COMPLETED`.

### 5. Fail-Closed Live Marketplace Transport
- `UnavailableMarketplaceExecutionGateway` is provided for unconfigured or unsupported marketplaces.
- It unconditionally throws `MarketplaceExecutionUnavailableError` (`MARKETPLACE_LIVE_PROTOCOL_UNAVAILABLE`) with **zero network calls**.
- Live Shopee integration requires official verified protocol specifications in future phases.

---

## Verification Summary

All 18 integration test cases (`ME-01` through `ME-18`) pass against real PostgreSQL, real Redis/BullMQ, and the deterministic test-only simulated gateway:
- `ME-01`: Fail-closed without gateway.
- `ME-02`: CREATE command mapping integrity.
- `ME-03`: Full CREATE lifecycle with read-after-write verification.
- `ME-04`: CREATE retry idempotency.
- `ME-05`: CREATE verification mismatch.
- `ME-06`: CREATE verify not found.
- `ME-07`: UPDATE_PRICE success and partial field update.
- `ME-08`: UPDATE_STOCK success including zero stock preservation.
- `ME-09`: Comprehensive UPDATE target and runtime source identity fail-closed checks (14 individual invariants).
- `ME-10`: UPDATE_PRICE verification mismatch.
- `ME-11`: UPDATE_STOCK verification mismatch.
- `ME-12`: Absolute assignment idempotency for updates.
- `ME-13`: Minimal transport payload verification.
- `ME-14`: Zero credential leakage in commands and events.
- `ME-15`: Safe redaction of gateway error messages.
- `ME-16`: Durable execution payload immutability.
- `ME-17`: Source records zero mutation.
- `ME-18`: Integration namespace cleanup.

---

## Remaining Work for Phase 4C.4+

1. Periodic reconciliation & drift detection worker.
2. Official verified Shopee Open Platform v2 adapter implementation when live API protocol documentation and sandbox credentials are provided.
3. Automated dead-letter queue (DLQ) inspection and administrative recovery tooling.
