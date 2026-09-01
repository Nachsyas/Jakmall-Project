import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSyncBaseOperationKey,
  generateSyncOperationIdempotencyKey,
} from "../src/sync/idempotency.js";
import { SyncIdempotencyKeyInputError } from "../src/sync/types.js";
import { formatIdempotencyKey } from "../src/marketplace/types.js";

test("generateSyncBaseOperationKey produces deterministic Phase 3 compatible product-level base key", () => {
  const params = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE" as const,
  };

  const baseKey = generateSyncBaseOperationKey(params);
  assert.equal(baseKey, "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE");

  const phase3Key = formatIdempotencyKey({
    marketplace: "shopee",
    sellerAccount: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE",
  });
  assert.equal(baseKey, phase3Key);
});

test("generateSyncOperationIdempotencyKey: CREATE_LISTING remains stable product-level identity", () => {
  const params1 = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "CREATE_LISTING" as const,
    sourceSnapshotId: "snap-001",
  };

  const params2 = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "CREATE_LISTING" as const,
    sourceSnapshotId: "snap-002",
  };

  const key1 = generateSyncOperationIdempotencyKey(params1);
  const key2 = generateSyncOperationIdempotencyKey(params2);

  // Listing creation must remain product-level
  assert.equal(key1, "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING");
  assert.equal(key2, "shopee:seller_main:jakmall:6970238281488:CREATE_LISTING");
  assert.equal(key1, key2);
});

test("generateSyncOperationIdempotencyKey: same UPDATE_PRICE + same snapshot produces identical key", () => {
  const params = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE" as const,
    sourceSnapshotId: "snapshot-001",
  };

  const key1 = generateSyncOperationIdempotencyKey(params);
  const key2 = generateSyncOperationIdempotencyKey(params);

  assert.equal(key1, key2);
  assert.equal(key1, "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snapshot-001");
});

test("generateSyncOperationIdempotencyKey: same UPDATE_PRICE + different snapshot produces different key", () => {
  const base = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE" as const,
  };

  const keySnap1 = generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "snap-001" });
  const keySnap2 = generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "snap-002" });

  assert.notEqual(keySnap1, keySnap2);
  assert.equal(keySnap1, "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-001");
  assert.equal(keySnap2, "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snap-002");
});

test("generateSyncOperationIdempotencyKey: same UPDATE_STOCK + different snapshot produces different key", () => {
  const base = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_STOCK" as const,
  };

  const keySnap1 = generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "snap-100" });
  const keySnap2 = generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "snap-200" });

  assert.notEqual(keySnap1, keySnap2);
  assert.equal(keySnap1, "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-100");
  assert.equal(keySnap2, "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snap-200");
});

test("generateSyncOperationIdempotencyKey: UPDATE_PRICE vs UPDATE_STOCK on same snapshot produces different key", () => {
  const base = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    sourceSnapshotId: "snapshot-001",
  };

  const priceKey = generateSyncOperationIdempotencyKey({ ...base, operationType: "UPDATE_PRICE" });
  const stockKey = generateSyncOperationIdempotencyKey({ ...base, operationType: "UPDATE_STOCK" });

  assert.notEqual(priceKey, stockKey);
  assert.equal(priceKey, "shopee:seller_main:jakmall:6970238281488:UPDATE_PRICE:snapshot-001");
  assert.equal(stockKey, "shopee:seller_main:jakmall:6970238281488:UPDATE_STOCK:snapshot-001");
});

test("generateSyncOperationIdempotencyKey differentiates seller accounts and source products", () => {
  const keyAccount1 = generateSyncOperationIdempotencyKey({
    marketplace: "shopee",
    sellerAccountKey: "seller_alpha",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: "snap-01",
  });

  const keyAccount2 = generateSyncOperationIdempotencyKey({
    marketplace: "shopee",
    sellerAccountKey: "seller_beta",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: "snap-01",
  });

  const keyProduct2 = generateSyncOperationIdempotencyKey({
    marketplace: "shopee",
    sellerAccountKey: "seller_alpha",
    source: "jakmall",
    sourceProductId: "7372731614335",
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: "snap-01",
  });

  assert.notEqual(keyAccount1, keyAccount2);
  assert.notEqual(keyAccount1, keyProduct2);
});

test("generateSyncOperationIdempotencyKey contains strictly no timestamp, random data, or non-deterministic values", () => {
  const key = generateSyncOperationIdempotencyKey({
    marketplace: "shopee",
    sellerAccountKey: "store_fixed",
    source: "jakmall",
    sourceProductId: "5502951494118",
    operationType: "UPDATE_PRICE",
    sourceSnapshotId: "snap-fixed",
  });

  assert.equal(key, "shopee:store_fixed:jakmall:5502951494118:UPDATE_PRICE:snap-fixed");
  assert.match(key, /^shopee:store_fixed:jakmall:5502951494118:UPDATE_PRICE:snap-fixed$/);
});

test("generateSyncOperationIdempotencyKey rejects components containing colon ':' delimiter", () => {
  const base = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE" as const,
    sourceSnapshotId: "snap-001",
  };

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, marketplace: "shopee:sg" }),
    (err: unknown) => {
      assert(err instanceof SyncIdempotencyKeyInputError);
      assert.match(err.message, /separator ':'/);
      return true;
    }
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sellerAccountKey: "seller:subaccount" }),
    (err: unknown) => {
      assert(err instanceof SyncIdempotencyKeyInputError);
      assert.match(err.message, /separator ':'/);
      return true;
    }
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, source: "jakmall:direct" }),
    (err: unknown) => {
      assert(err instanceof SyncIdempotencyKeyInputError);
      assert.match(err.message, /separator ':'/);
      return true;
    }
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sourceProductId: "sku:123:abc" }),
    (err: unknown) => {
      assert(err instanceof SyncIdempotencyKeyInputError);
      assert.match(err.message, /separator ':'/);
      return true;
    }
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "snap:001" }),
    (err: unknown) => {
      assert(err instanceof SyncIdempotencyKeyInputError);
      assert.match(err.message, /separator ':'/);
      return true;
    }
  );
});

test("generateSyncOperationIdempotencyKey rejects empty, blank, or missing sourceSnapshotId for update operations", () => {
  const base = {
    marketplace: "shopee",
    sellerAccountKey: "seller_main",
    source: "jakmall",
    sourceProductId: "6970238281488",
    operationType: "UPDATE_PRICE" as const,
  };

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "" }),
    SyncIdempotencyKeyInputError
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: "   " }),
    SyncIdempotencyKeyInputError
  );

  assert.throws(
    () => generateSyncOperationIdempotencyKey({ ...base, sourceSnapshotId: undefined }),
    SyncIdempotencyKeyInputError
  );

  assert.throws(
    // @ts-expect-error test invalid operationType
    () => generateSyncOperationIdempotencyKey({ ...base, operationType: "INVALID_OP", sourceSnapshotId: "snap-1" }),
    SyncIdempotencyKeyInputError
  );
});
