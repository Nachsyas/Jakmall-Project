# Phase 4A — Persistence Foundation Architecture

## 1. Executive Summary

Phase 4A transitions the Intelligent Product Sync Platform from an in-memory single-run preparation pipeline into a durable, auditable persistence and synchronization foundation.

This phase establishes the relational schema, deterministic stable serialization, granular cryptographic change detection, and snapshot diffing necessary for continuous synchronization without premature infrastructure coupling.

### Operational State Matrix
| Dimension | State | Description |
|-----------|:-----:|-------------|
| **Database Engine** | `POSTGRESQL` | Declared authoritative database engine |
| **ORM** | `PRISMA 6.19.3` | Schema defined and validated via `prisma validate` |
| **Schema Status** | `SCHEMA_DEFINED` | Schema file established at `prisma/schema.prisma` |
| **Schema Validation** | `SCHEMA_VALIDATED` | Verified syntactically valid with enums and relations |
| **Live Database Connection** | `DATABASE_NOT_CONNECTED` | No live PostgreSQL server required for pure domain logic |
| **Database Migrations** | `MIGRATION_NOT_APPLIED` | `prisma migrate` / `db push` intentionally deferred |
| **Redis / BullMQ Queue** | `NOT_STARTED` | No queue dependencies or background workers in Phase 4A |
| **Continuous Sync Runtime** | `NOT_STARTED` | Scheduler and polling runtime deferred to Phase 4C |
| **Remote Marketplace Writes**| `NOT_TOUCHED` | Zero remote marketplace mutation in Phase 4A |

---

## 2. Relational Schema Architecture (`prisma/schema.prisma`)

The database architecture is designed with strict relational boundaries and identity decoupling:

```
[Product] (Internal UUID PK)
   ├── 1:N ──> [ProductSource] (Supplier identity: source + sourceProductId)
   │               ├── 1:N ──> [SourceVariant] (Canonical source variants: sourceSkuId, merchantSku, displaySku)
   │               ├── 1:N ──> [SourceSnapshot] (Historical captures with cryptographic hashes)
   │               ├── 1:N ──> [SyncJob] (Durable sync execution intentions)
   │               ├── 1:N ──> [SyncEvent] (Operational events linked to source)
   │               └── 1:N ──> [IdempotencyRecord] (Idempotency records linked to source)
   │
   └── 1:N ──> [MarketplaceListing] (Marketplace relation: marketplace + sellerAccountKey)
                   ├── 1:N ──> [MarketplaceListingVariant] (Linkage to sourceSkuId and destinationSku)
                   ├── 1:N ──> [SyncJob]
                   └── 1:N ──> [SyncEvent]
```

### Key Schema Design Invariants

1. **Decoupled Internal Identity:**
   - `Product.id` uses generated UUID primary keys.
   - JakMall numeric product IDs (e.g. `6970238281488`) are never database primary keys; they reside in `ProductSource.sourceProductId`.
   - `ProductSource` enforces a composite unique constraint `@@unique([source, sourceProductId])`.

2. **Distinct Source SKU Identities:**
   - `SourceVariant` preserves the three distinct source SKU concepts established in Phase 2:
     - `sourceSkuId`: Authoritative primary identifier from supplier state.
     - `merchantSku`: Optional merchant-assigned code.
     - `displaySku`: Optional public-facing SKU string.
   - Enforces `@@unique([productSourceId, sourceSkuId])`.

3. **Historical Source Snapshot Preservation:**
   - `SourceSnapshot` preserves historical captures and stores complete `canonicalPayload` along with 5 independent cryptographic hashes.
   - Does **NOT** enforce a unique constraint on `[productSourceId, sourceHash]` because source products may legitimately revert to previous states over time, and full transition history must be preserved.

4. **Nullable Remote Identifiers:**
   - `MarketplaceListing.remoteListingId` and `MarketplaceListingVariant.remoteVariantId` are strictly nullable (`String?`).
   - The absence of a remote ID signifies a draft or unsubmitted listing. Remote IDs are never fabricated.

5. **Operational Audit and Idempotency:**
   - `SyncJob`: Tracks synchronization lifecycle state using finite Prisma enums (`SyncJobStatus`: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `NEEDS_REVIEW`, `BLOCKED`, `CANCELLED`; `SyncJobType`: `SOURCE_SYNC`, `PRICE_UPDATE`, `STOCK_UPDATE`, `CONTENT_UPDATE`, `FULL_SYNC`).
   - `SyncEvent`: Append-only event history recording operational occurrences using `SyncEventType` (`SOURCE_CAPTURED`, `PRICE_CHANGED`, `INVENTORY_CHANGED`, `SYNC_PLANNED`, etc.). Optional foreign keys link directly to `productSource`, `marketplaceListing`, and `syncJob`.
   - `AuditLog`: Append-only application contract and intended audit trail tracking actor, action, entity, before/after snapshots, and metadata.
   - `IdempotencyRecord`: `IdempotencyRecord.key` has a Prisma `@unique` constraint and tracks `IdempotencyStatus` (`STARTED`, `COMPLETED`, `FAILED`), providing a persistence-level uniqueness foundation for future duplicate-operation prevention.

6. **Conservative Lifecycle Retention:**
   - Relations between parents and historical audit/snapshot records use `onDelete: Restrict` to ensure historical evidence is never inadvertently destroyed by cascading deletes.

---

## 3. Deterministic Stable Serialization (`src/persistence/stable-serialize.ts`)

Semantically equivalent JavaScript objects can have different property insertion order. To compute invariant cryptographic hashes, `stableSerialize` provides a pure, zero-dependency serialization engine with the following guarantees:

1. **Recursive Alphabetical Sorting:** All object keys are sorted alphabetically at every level of nesting, regardless of insertion order.
2. **Preserved Array Ordering:** Array elements are preserved in their natural order (array order is semantically significant for breadcrumbs, images, and attribute lists).
3. **Deterministic Array Hole Handling:** Explicitly handles sparse array slots and `undefined` items by serializing them to `"null"`.
4. **Deterministic Date Representation:** All `Date` objects are serialized into ISO 8601 UTC strings.
5. **Consistent Undefined Handling:** Undefined object properties are omitted from object serialization, matching standard JSON semantics.
6. **Strict Value Validation:** Rejects non-finite numbers (`NaN`, `Infinity`, `-Infinity`), unsupported types (`bigint`, `symbol`, `function`), non-plain objects (`Map`, `Set`, `RegExp`, class instances), objects with Symbol keys, and circular references with explicit `SerializationError` exceptions.

---

## 4. Cryptographic Hashing Engine (`src/persistence/hash.ts`)

To avoid blindly diffing entire payloads or triggering false-positive synchronizations on volatile metadata (such as `fetchedAt`), the platform partitions the source product into five independent SHA-256 hash groups:

| Hash Identifier | Scope / Content | Excluded Fields |
|-----------------|-----------------|-----------------|
| `contentHash` | `title`, `description`, `brand`, `categoryPath`, `specifications`, `seller`, `images` | `fetchedAt`, parser metadata |
| `priceHash` | Variants sorted lexically by `sourceSkuId`: `final`, `normal`, `list` prices | Inventory, attributes, metadata |
| `inventoryHash` | Variants sorted lexically by `sourceSkuId`: `available`, `exact`, `quantity`, `status` | Price, attributes, metadata |
| `variantHash` | Variants sorted lexically by `sourceSkuId`: `sourceSkuId`, `merchantSku`, `displaySku`, `attributes`, `weightGrams`, `volume`, `preorder`, and variant `images` | Price, inventory, sourceMetadata |
| `sourceHash` | Composite: `source`, `sourceProductId`, `contentHash`, `priceHash`, `inventoryHash`, `variantHash` | Transient parser metadata |

### Invariant Rules
- **Lexical Order-Independence:** Variants are sorted lexically by `sourceSkuId` prior to serialization, ensuring variant order permutations in source HTML do not alter hashes across host locales.
- **Variant Definition Scope:** `variantHash` represents complete variant identity, attributes, and non-price/non-inventory source-owned definition state (including volume, variant images, weight, and preorder).
- **Null vs Zero Disambiguation:** Undefined quantities serialize as `null` while zero quantities serialize as `0`, preventing conflation between missing stock and confirmed out-of-stock.
- **Zero Source Mutation:** Hashing functions treat `CanonicalProduct` as strictly read-only and never mutate input objects.

---

## 5. Field-Level Deterministic Diff (`src/persistence/diff.ts`)

The diff engine compares snapshot hash breakdowns to classify the nature of the change without executing remote side effects:

```
Snapshot Comparison
       ├── Different source / sourceProductId ─> SnapshotIdentityMismatchError
       ├── Inconsistent group vs sourceHash ───> SnapshotIntegrityError
       ├── No Previous Hashes ─────────────────> FIRST_SNAPSHOT (changed: true)
       ├── All Group Hashes Match ─────────────> NO_CHANGE (changed: false)
       ├── Exactly One Group Hash Differs ─────> Single Change:
       │                                           ├── priceHash differs      ──> PRICE_CHANGED
       │                                           ├── inventoryHash differs  ──> INVENTORY_CHANGED
       │                                           ├── contentHash differs    ──> CONTENT_CHANGED
       │                                           └── variantHash differs    ──> VARIANTS_CHANGED
       └── Two or More Group Hashes Differ ────> MULTIPLE_CHANGED (kinds: [...all specific kinds])
```

### Architectural Principle: Granular Actionability
A change in `sourceHash` indicates *that* something changed, but the synchronization engine inspects `kinds` and `fields` to determine *what* to synchronize. For example, a `PRICE_CHANGED` event can be mapped by the Phase 4B planner to `UPDATE_PRICE` rather than overwriting custom descriptions or resetting listing state.
