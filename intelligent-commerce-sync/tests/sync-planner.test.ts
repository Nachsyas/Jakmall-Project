import test from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../src/sync/planner.js";
import {
  type SyncPlannerInput,
  SyncPlanningInputError,
} from "../src/sync/types.js";
import {
  getFieldOwner,
  isAutoSyncAllowed,
  isSellerOwned,
  protectSellerField,
} from "../src/sync/ownership.js";
import { diffSnapshotHashes } from "../src/persistence/diff.js";
import type { SourceSnapshotHashes, SnapshotDiffResult } from "../src/persistence/types.js";
import type { MarketplaceListingStatus } from "../src/marketplace/types.js";

const DUMMY_HASHES: SourceSnapshotHashes = {
  sourceHash: "0000000000000000000000000000000000000000000000000000000000000001",
  contentHash: "0000000000000000000000000000000000000000000000000000000000000002",
  priceHash: "0000000000000000000000000000000000000000000000000000000000000003",
  inventoryHash: "0000000000000000000000000000000000000000000000000000000000000004",
  variantHash: "0000000000000000000000000000000000000000000000000000000000000005",
};

// Truthful diff fixture helpers that derive authoritative diffs using diffSnapshotHashes
function makeNoChangeDiff(): SnapshotDiffResult {
  return diffSnapshotHashes(DUMMY_HASHES, DUMMY_HASHES);
}

function makePriceDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    priceHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    sourceHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makeInventoryDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    inventoryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makeContentDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    contentHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makeVariantsDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    variantHash: "5555555555555555555555555555555555555555555555555555555555555555",
    sourceHash: "6666666666666666666666666666666666666666666666666666666666666666",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makePriceAndInventoryDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    priceHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    inventoryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceHash: "7777777777777777777777777777777777777777777777777777777777777777",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makePriceAndContentDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    priceHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    contentHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceHash: "8888888888888888888888888888888888888888888888888888888888888888",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function makePriceInventoryVariantsDiff(): SnapshotDiffResult {
  const newHashes: SourceSnapshotHashes = {
    ...DUMMY_HASHES,
    priceHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    inventoryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    variantHash: "5555555555555555555555555555555555555555555555555555555555555555",
    sourceHash: "9999999999999999999999999999999999999999999999999999999999999999",
  };
  return diffSnapshotHashes(DUMMY_HASHES, newHashes);
}

function createBaseInput(overrides?: Partial<SyncPlannerInput>): SyncPlannerInput {
  return {
    diff: makePriceDiff(),
    sourceSnapshotId: "snapshot-001",
    source: "jakmall",
    sourceProductId: "6970238281488",
    marketplace: "shopee",
    sellerAccountKey: "seller_official",
    listing: {
      exists: true,
      remoteListingId: "shopee_item_12345",
      status: "PUBLISHED",
    },
    gates: {
      inventory: "RESOLVED",
    },
    ...overrides,
  };
}

// 1. NO_CHANGE -> NO_ACTION
test("planSync: NO_CHANGE diff produces NO_ACTION plan with no operations", () => {
  const input = createBaseInput({
    diff: makeNoChangeDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NO_ACTION");
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.requiresReview, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "LOW");
  assert.equal(plan.decisions.length, 1);
  const decision0 = plan.decisions[0];
  assert.ok(decision0);
  assert.equal(decision0.code, "NO_SEMANTIC_CHANGE");
});

// 2. PRICE_CHANGED -> UPDATE_PRICE
test("planSync: PRICE_CHANGED diff produces eligible UPDATE_PRICE operation", () => {
  const input = createBaseInput();
  const plan = planSync(input);

  assert.equal(plan.status, "READY");
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "UPDATE_PRICE");
  assert.equal(op0.eligibility, "ELIGIBLE");
  assert.equal(op0.baseOperationKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE");
  assert.equal(op0.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE:snapshot-001");
  assert.equal(plan.requiresReview, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "LOW");
});

// 3. PRICE_CHANGED does not produce UPDATE_STOCK
test("planSync: PRICE_CHANGED does not produce UPDATE_STOCK operation", () => {
  const input = createBaseInput();
  const plan = planSync(input);

  const stockOps = plan.operations.filter((op) => op.operationType === "UPDATE_STOCK");
  assert.equal(stockOps.length, 0);
});

// 4. INVENTORY_CHANGED + RESOLVED -> UPDATE_STOCK
test("planSync: INVENTORY_CHANGED with RESOLVED gate produces eligible UPDATE_STOCK operation", () => {
  const input = createBaseInput({
    diff: makeInventoryDiff(),
    sourceSnapshotId: "snapshot-100",
    gates: {
      inventory: "RESOLVED",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "READY");
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "UPDATE_STOCK");
  assert.equal(op0.eligibility, "ELIGIBLE");
  assert.equal(op0.baseOperationKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK");
  assert.equal(op0.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK:snapshot-100");
  assert.equal(plan.requiresReview, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "LOW");
});

// 5. inventory NEEDS_REVIEW -> no ready stock execution
test("planSync: INVENTORY_CHANGED with NEEDS_REVIEW gate produces NEEDS_REVIEW plan", () => {
  const input = createBaseInput({
    diff: makeInventoryDiff(),
    gates: {
      inventory: "NEEDS_REVIEW",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "MEDIUM");
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "UPDATE_STOCK");
  assert.equal(op0.eligibility, "REQUIRES_REVIEW");

  const resolutionDecision = plan.decisions.find((d) => d.code === "INVENTORY_RESOLUTION_REQUIRED");
  assert.ok(resolutionDecision);
});

// 6. inventory BLOCKED -> BLOCKED
test("planSync: INVENTORY_CHANGED with BLOCKED gate produces BLOCKED plan", () => {
  const input = createBaseInput({
    diff: makeInventoryDiff(),
    gates: {
      inventory: "BLOCKED",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.blocked, true);
  assert.equal(plan.risk, "HIGH");
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "UPDATE_STOCK");
  assert.equal(op0.eligibility, "BLOCKED");

  const blockedDecision = plan.decisions.find((d) => d.code === "INVENTORY_POLICY_BLOCKED");
  assert.ok(blockedDecision);
});

// 7. PRICE + INVENTORY -> deterministic two-operation plan when resolved
test("planSync: MULTIPLE_CHANGED with price and resolved inventory produces both UPDATE_PRICE and UPDATE_STOCK", () => {
  const input = createBaseInput({
    diff: makePriceAndInventoryDiff(),
    sourceSnapshotId: "snapshot-050",
    gates: {
      inventory: "RESOLVED",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "READY");
  assert.equal(plan.operations.length, 2);
  const op0 = plan.operations[0];
  const op1 = plan.operations[1];
  assert.ok(op0);
  assert.ok(op1);
  assert.equal(op0.operationType, "UPDATE_PRICE");
  assert.equal(op0.eligibility, "ELIGIBLE");
  assert.equal(op1.operationType, "UPDATE_STOCK");
  assert.equal(op1.eligibility, "ELIGIBLE");

  assert.equal(op0.baseOperationKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE");
  assert.equal(op0.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE:snapshot-050");
  assert.equal(op1.baseOperationKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK");
  assert.equal(op1.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK:snapshot-050");
});

// 8. CONTENT_CHANGED -> NEEDS_REVIEW
test("planSync: CONTENT_CHANGED requires human review and assigns MEDIUM risk", () => {
  const input = createBaseInput({
    diff: makeContentDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "MEDIUM");

  const reviewDecision = plan.decisions.find((d) => d.code === "CONTENT_CHANGE_REQUIRES_REVIEW");
  assert.ok(reviewDecision);
});

// 9. CONTENT_CHANGED emits no content update marketplace operation
test("planSync: CONTENT_CHANGED emits zero marketplace operations", () => {
  const input = createBaseInput({
    diff: makeContentDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.operations.length, 0);
});

// 10. VARIANTS_CHANGED -> NEEDS_REVIEW
test("planSync: VARIANTS_CHANGED requires human review and assigns HIGH risk", () => {
  const input = createBaseInput({
    diff: makeVariantsDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.risk, "HIGH");

  const variantDecision = plan.decisions.find((d) => d.code === "VARIANT_STRUCTURE_CHANGE_REQUIRES_REVIEW");
  assert.ok(variantDecision);
});

// 11. VARIANTS_CHANGED emits no variant update marketplace operation
test("planSync: VARIANTS_CHANGED emits zero marketplace operations", () => {
  const input = createBaseInput({
    diff: makeVariantsDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.operations.length, 0);
});

// 12. PRICE + CONTENT -> NEEDS_REVIEW dominates READY
test("planSync: MULTIPLE_CHANGED with price and content sets overall plan to NEEDS_REVIEW", () => {
  const input = createBaseInput({
    diff: makePriceAndContentDiff(),
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "UPDATE_PRICE");
  assert.equal(op0.eligibility, "REQUIRES_REVIEW");
});

// 13. PRICE + INVENTORY with inventory BLOCKED -> BLOCKED dominates
test("planSync: MULTIPLE_CHANGED with price and blocked inventory sets overall plan to BLOCKED", () => {
  const input = createBaseInput({
    diff: makePriceAndInventoryDiff(),
    gates: {
      inventory: "BLOCKED",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.blocked, true);

  // Both operations are planned but withheld from execution
  assert.equal(plan.operations.length, 2);
  const op0 = plan.operations[0];
  const op1 = plan.operations[1];
  assert.ok(op0);
  assert.ok(op1);
  assert.equal(op0.eligibility, "BLOCKED");
  assert.equal(op1.eligibility, "BLOCKED");
});

// 14. FIRST_SNAPSHOT + no listing -> create intent requiring review (product-scoped idempotency)
test("planSync: FIRST_SNAPSHOT with no listing plans CREATE_LISTING requiring review", () => {
  const diffFirst = diffSnapshotHashes(undefined, DUMMY_HASHES);
  const input = createBaseInput({
    diff: diffFirst,
    sourceSnapshotId: "snapshot-init",
    listing: {
      exists: false,
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.operationType, "CREATE_LISTING");
  assert.equal(op0.eligibility, "REQUIRES_REVIEW");
  assert.equal(op0.baseOperationKey, "shopee:seller_official:jakmall:6970238281488:CREATE_LISTING");
  assert.equal(op0.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:CREATE_LISTING");

  const firstDecision = plan.decisions.find((d) => d.code === "FIRST_SNAPSHOT_NEW_LISTING");
  assert.ok(firstDecision);
});

// 15. FIRST_SNAPSHOT + existing listing -> reconciliation review
test("planSync: FIRST_SNAPSHOT against existing listing requires reconciliation review and emits no write", () => {
  const diffFirst = diffSnapshotHashes(undefined, DUMMY_HASHES);
  const input = createBaseInput({
    diff: diffFirst,
    listing: {
      exists: true,
      remoteListingId: "shopee_preexisting_999",
      status: "PUBLISHED",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "NEEDS_REVIEW");
  assert.equal(plan.requiresReview, true);
  assert.equal(plan.risk, "HIGH");
  assert.equal(plan.operations.length, 0);

  const reconDecision = plan.decisions.find((d) => d.code === "FIRST_SNAPSHOT_EXISTING_LISTING");
  assert.ok(reconDecision);
});

// 16. existing listing without remoteListingId blocks updates
test("planSync: existing listing without remoteListingId blocks update operations", () => {
  const input = createBaseInput({
    listing: {
      exists: true,
      remoteListingId: undefined, // Missing remote ID
      status: "APPROVED_FOR_PUBLISH",
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.blocked, true);
  assert.equal(plan.risk, "HIGH");

  const remoteDecision = plan.decisions.find((d) => d.code === "REMOTE_LISTING_ID_REQUIRED");
  assert.ok(remoteDecision);

  assert.equal(plan.operations.length, 1);
  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.eligibility, "BLOCKED");
});

// 17. BLOCKED listing status propagates block
test("planSync: BLOCKED or REJECTED listing status propagates BLOCKED plan", () => {
  const inputBlocked = createBaseInput({
    listing: {
      exists: true,
      remoteListingId: "item_blocked_1",
      status: "BLOCKED",
    },
  });

  const planBlocked = planSync(inputBlocked);
  assert.equal(planBlocked.status, "BLOCKED");
  assert.equal(planBlocked.blocked, true);

  const inputRejected = createBaseInput({
    listing: {
      exists: true,
      remoteListingId: "item_rejected_1",
      status: "REJECTED",
    },
  });

  const planRejected = planSync(inputRejected);
  assert.equal(planRejected.status, "BLOCKED");
  assert.equal(planRejected.blocked, true);
});

// 18. READY_FOR_REVIEW / NEEDS_REVIEW listing status propagates review
test("planSync: unapproved listing statuses propagate NEEDS_REVIEW", () => {
  const inputReview = createBaseInput({
    listing: {
      exists: true,
      remoteListingId: "item_review_1",
      status: "READY_FOR_REVIEW",
    },
  });

  const planReview = planSync(inputReview);
  assert.equal(planReview.status, "NEEDS_REVIEW");
  assert.equal(planReview.requiresReview, true);
  const op0 = planReview.operations[0];
  assert.ok(op0);
  assert.equal(op0.eligibility, "REQUIRES_REVIEW");

  const reviewDecision = planReview.decisions.find((d) => d.code === "LISTING_REVIEW_REQUIRED");
  assert.ok(reviewDecision);
});

// 19. identical inputs produce deep-equal output
test("planSync: identical inputs produce deeply equal deterministic outputs", () => {
  const input1 = createBaseInput();
  const input2 = createBaseInput();

  const plan1 = planSync(input1);
  const plan2 = planSync(input2);

  assert.deepEqual(plan1, plan2);
});

// 20. shuffled change kinds produce deterministic same plan semantics and deepEqual decisions
test("planSync: shuffled diff.kinds produce identical deterministic operations, ordering, and decisions", () => {
  const baseDiff = makePriceInventoryVariantsDiff();
  const inputOriginal = createBaseInput({
    diff: {
      ...baseDiff,
      kinds: ["PRICE_CHANGED", "INVENTORY_CHANGED", "VARIANTS_CHANGED"],
    },
  });

  const inputShuffled = createBaseInput({
    diff: {
      ...baseDiff,
      kinds: ["VARIANTS_CHANGED", "PRICE_CHANGED", "INVENTORY_CHANGED"],
    },
  });

  const plan1 = planSync(inputOriginal);
  const plan2 = planSync(inputShuffled);

  assert.deepEqual(plan1.operations, plan2.operations);
  assert.deepEqual(plan1.decisions, plan2.decisions);
  assert.equal(plan1.status, plan2.status);
  assert.equal(plan1.risk, plan2.risk);
  assert.equal(plan1.requiresReview, plan2.requiresReview);
  assert.equal(plan1.blocked, plan2.blocked);
});

// 21. no Date/random data appears
test("planSync: plan output contains strictly no Date objects, timestamps, or random tokens", () => {
  const input = createBaseInput();
  const plan = planSync(input);

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T/); // No ISO Date string
  assert.doesNotMatch(serialized, /Date/);
});

// 22. seller-owned content protection decision exists
test("planSync: content change records seller-owned field protection decision", () => {
  const input = createBaseInput({
    diff: makeContentDiff(),
  });

  const plan = planSync(input);

  const protectionDecision = plan.decisions.find((d) => d.code === "SELLER_OWNED_FIELD_PROTECTED");
  assert.ok(protectionDecision);
  assert.match(protectionDecision.message, /seller-owned destination customizations/);
});

// 23. operation ordering deterministic: CREATE_LISTING -> UPDATE_PRICE -> UPDATE_STOCK
test("planSync: operations are deterministically ordered: CREATE_LISTING, UPDATE_PRICE, UPDATE_STOCK", () => {
  const input = createBaseInput({
    diff: makePriceAndInventoryDiff(),
  });

  const plan = planSync(input);

  const op0 = plan.operations[0];
  const op1 = plan.operations[1];
  assert.ok(op0);
  assert.ok(op1);
  assert.equal(op0.operationType, "UPDATE_PRICE");
  assert.equal(op1.operationType, "UPDATE_STOCK");
});

// 24. malformed diff input rejected
test("planSync: throws SyncPlanningInputError on invalid or inconsistent diff inputs", () => {
  // Inconsistent: NO_CHANGE with changed: true
  assert.throws(() => {
    planSync(createBaseInput({
      diff: {
        classification: "NO_CHANGE",
        changed: true,
        kinds: [],
        fields: [],
        oldHashes: DUMMY_HASHES,
        newHashes: DUMMY_HASHES,
      },
    }));
  }, SyncPlanningInputError);

  // Inconsistent: NO_CHANGE with non-empty kinds
  assert.throws(() => {
    planSync(createBaseInput({
      diff: {
        classification: "NO_CHANGE",
        changed: false,
        kinds: ["PRICE_CHANGED"],
        fields: [],
        oldHashes: DUMMY_HASHES,
        newHashes: DUMMY_HASHES,
      },
    }));
  }, SyncPlanningInputError);

  // Inconsistent: PRICE_CHANGED classification with missing or mismatched kind
  assert.throws(() => {
    planSync(createBaseInput({
      diff: {
        classification: "PRICE_CHANGED",
        changed: true,
        kinds: ["INVENTORY_CHANGED"],
        fields: [],
        oldHashes: DUMMY_HASHES,
        newHashes: DUMMY_HASHES,
      },
    }));
  }, SyncPlanningInputError);

  // Inconsistent: duplicate kinds
  assert.throws(() => {
    planSync(createBaseInput({
      diff: {
        classification: "MULTIPLE_CHANGED",
        changed: true,
        kinds: ["PRICE_CHANGED", "PRICE_CHANGED"],
        fields: [],
        oldHashes: DUMMY_HASHES,
        newHashes: DUMMY_HASHES,
      },
    }));
  }, SyncPlanningInputError);
});

// 25. sourceProductId preserved literally
test("planSync: sourceProductId is preserved literally without parsing, truncation, or conversion", () => {
  const literalId = "0006970238281488-SPEC_ID#99";
  const input = createBaseInput({
    sourceProductId: literalId,
  });

  const plan = planSync(input);

  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.equal(op0.sourceProductId, literalId);
  assert.ok(op0.idempotencyKey.includes(literalId));
  assert.ok(op0.baseOperationKey.includes(literalId));
});

// 26. no fake remote IDs
test("planSync: plan output strictly does not invent or fabricate remote listing IDs", () => {
  const diffFirst = diffSnapshotHashes(undefined, DUMMY_HASHES);
  const input = createBaseInput({
    listing: {
      exists: false,
    },
    diff: diffFirst,
  });

  const plan = planSync(input);

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /fake|mock|simulated_id|shopee_item_mock/i);
});

// 27. Field ownership tests (Section 33)
test("ownership: field ownership domains and seller protection adhere strictly to policy", () => {
  // SOURCE
  assert.equal(getFieldOwner("SOURCE_PRICE"), "SOURCE");
  assert.equal(getFieldOwner("SOURCE_INVENTORY"), "SOURCE");
  assert.equal(getFieldOwner("SOURCE_VARIANTS"), "SOURCE");
  assert.equal(getFieldOwner("SOURCE_WEIGHT"), "SOURCE");
  assert.equal(getFieldOwner("SOURCE_IMAGES"), "SOURCE");

  // SYSTEM
  assert.equal(getFieldOwner("SELLING_PRICE"), "SYSTEM");
  assert.equal(getFieldOwner("MARKUP_POLICY"), "SYSTEM");
  assert.equal(getFieldOwner("SAFETY_STOCK"), "SYSTEM");
  assert.equal(getFieldOwner("CATEGORY_MAPPING"), "SYSTEM");
  assert.equal(getFieldOwner("ATTRIBUTE_MAPPING"), "SYSTEM");
  assert.equal(getFieldOwner("SYNC_POLICY"), "SYSTEM");
  assert.equal(getFieldOwner("RISK_DECISION"), "SYSTEM");

  // SELLER
  assert.equal(getFieldOwner("MARKETING_TITLE"), "SELLER");
  assert.equal(getFieldOwner("CUSTOM_DESCRIPTION"), "SELLER");
  assert.equal(getFieldOwner("MANUAL_CATEGORY_OVERRIDE"), "SELLER");
  assert.equal(getFieldOwner("PROMOTIONAL_CONTENT"), "SELLER");
  assert.equal(getFieldOwner("SELLER_METADATA"), "SELLER");

  // isSellerOwned
  assert.equal(isSellerOwned("MARKETING_TITLE"), true);
  assert.equal(isSellerOwned("CUSTOM_DESCRIPTION"), true);
  assert.equal(isSellerOwned("SOURCE_PRICE"), false);
  assert.equal(isSellerOwned("SELLING_PRICE"), false);

  // isAutoSyncAllowed
  assert.equal(isAutoSyncAllowed("SOURCE_PRICE"), true);
  assert.equal(isAutoSyncAllowed("SOURCE_INVENTORY"), true);
  assert.equal(isAutoSyncAllowed("MARKETING_TITLE"), false);
  assert.equal(isAutoSyncAllowed("CUSTOM_DESCRIPTION"), false);
  assert.equal(isAutoSyncAllowed("MANUAL_CATEGORY_OVERRIDE"), false);
  assert.equal(isAutoSyncAllowed("SELLING_PRICE"), false);

  // protectSellerField
  const protection = protectSellerField("MARKETING_TITLE");
  assert.equal(protection.owner, "SELLER");
  assert.equal(protection.autoSyncAllowed, false);
  assert.match(protection.protectionReason, /protected from automatic source overwrite/);
});

// 28. Preserved review facts under blocker precedence
test("planSync: preserves requiresReview: true and blocked: true when both blocker and review conditions are present", () => {
  // Blocker from inventory gate + review requirement from CONTENT_CHANGED
  const diffPriceContent = makePriceAndContentDiff();
  const input = createBaseInput({
    diff: diffPriceContent,
    gates: {
      inventory: "BLOCKED",
    },
    listing: {
      exists: true,
      remoteListingId: "item_remote_123",
      status: "BLOCKED", // Listing itself is blocked
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.blocked, true);
  assert.equal(plan.requiresReview, true); // Review fact is preserved!

  // All planned operations must be downgraded to BLOCKED
  for (const op of plan.operations) {
    assert.equal(op.eligibility, "BLOCKED");
  }
});

// 29. Missing listing.status when exists is true blocks with LISTING_STATUS_REQUIRED
test("planSync: missing listing.status when listing.exists === true produces BLOCKED plan with LISTING_STATUS_REQUIRED", () => {
  const input = createBaseInput({
    listing: {
      exists: true,
      remoteListingId: "item_12345",
      status: undefined,
    },
  });

  const plan = planSync(input);

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.blocked, true);
  const statusDecision = plan.decisions.find((d) => d.code === "LISTING_STATUS_REQUIRED");
  assert.ok(statusDecision);
});

// 30. Unknown listing status string rejected with SyncPlanningInputError
test("planSync: unknown listing status string rejected with SyncPlanningInputError", () => {
  assert.throws(
    () =>
      planSync(
        createBaseInput({
          listing: {
            exists: true,
            remoteListingId: "item_12345",
            // @ts-expect-error test unknown status
            status: "SOME_UNKNOWN_STATUS",
          },
        })
      ),
    SyncPlanningInputError
  );
});

// 31. Strict exists=false invariant: remoteListingId and listing.status must be absent
test("planSync: rejects inconsistent listing when exists === false but remoteListingId or listing.status is present", () => {
  assert.throws(
    () =>
      planSync(
        createBaseInput({
          listing: {
            exists: false,
            remoteListingId: "remote_id_should_not_exist",
          },
        })
      ),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /remoteListingId must not be present when listing\.exists is false/);
      return true;
    }
  );

  // exists=false + DRAFT -> rejected
  assert.throws(
    () =>
      planSync(
        createBaseInput({
          listing: {
            exists: false,
            status: "DRAFT",
          },
        })
      ),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /listing\.status must be undefined when listing\.exists is false/);
      return true;
    }
  );

  // exists=false + NEEDS_REVIEW -> rejected
  assert.throws(
    () =>
      planSync(
        createBaseInput({
          listing: {
            exists: false,
            status: "NEEDS_REVIEW",
          },
        })
      ),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /listing\.status must be undefined when listing\.exists is false/);
      return true;
    }
  );

  // exists=false + PUBLISHED -> rejected
  assert.throws(
    () =>
      planSync(
        createBaseInput({
          listing: {
            exists: false,
            status: "PUBLISHED",
          },
        })
      ),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /listing\.status must be undefined when listing\.exists is false/);
      return true;
    }
  );
});

// 32. Inventory gate strict validation: missing / invalid string / valid gate values
test("planSync: gates.inventory must strictly be RESOLVED, NEEDS_REVIEW, or BLOCKED", () => {
  assert.throws(
    // @ts-expect-error test missing gates
    () => planSync(createBaseInput({ gates: undefined })),
    SyncPlanningInputError
  );

  assert.throws(
    // @ts-expect-error test invalid inventory gate
    () => planSync(createBaseInput({ gates: { inventory: "UNKNOWN_GATE" } })),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /gates\.inventory must be exactly one of/);
      return true;
    }
  );

  assert.throws(
    // @ts-expect-error test boolean inventory gate
    () => planSync(createBaseInput({ gates: { inventory: true } })),
    SyncPlanningInputError
  );
});

// 33. Finite listing update policy: audit all non-update-capable statuses
test("planSync: only PUBLISHED and VERIFIED produce READY status for update operations", () => {
  const nonUpdateCapableStatuses: MarketplaceListingStatus[] = [
    "DRAFT",
    "DRAFT_VALID",
    "READY_FOR_REVIEW",
    "EDIT_REQUIRED",
    "NEEDS_REVIEW",
    "APPROVED_FOR_PUBLISH",
    "READY",
    "BLOCKED",
    "REJECTED",
    "FAILED",
    "PUBLISHING",
    "VERIFYING",
  ];

  for (const status of nonUpdateCapableStatuses) {
    const input = createBaseInput({
      listing: {
        exists: true,
        remoteListingId: "remote_item_test",
        status,
      },
    });

    const plan = planSync(input);
    assert.notEqual(
      plan.status,
      "READY",
      `Listing status '${status}' must NEVER produce a READY plan for update operations.`
    );
    assert(
      plan.status === "BLOCKED" || plan.status === "NEEDS_REVIEW",
      `Listing status '${status}' must produce either BLOCKED or NEEDS_REVIEW, got: ${plan.status}`
    );
  }

  // Verify PUBLISHED and VERIFIED produce READY
  for (const status of ["PUBLISHED", "VERIFIED"] as const) {
    const input = createBaseInput({
      listing: {
        exists: true,
        remoteListingId: "remote_item_test",
        status,
      },
    });
    const plan = planSync(input);
    assert.equal(plan.status, "READY", `Listing status '${status}' must produce READY for valid price change.`);
  }
});

// 34. Sequential price-change plans for same product with different snapshot IDs have different idempotency keys
test("planSync: two sequential price-change plans for the same product but different snapshot IDs have different idempotency keys", () => {
  const planSnap1 = planSync(createBaseInput({ sourceSnapshotId: "snapshot-20260831-001" }));
  const planSnap2 = planSync(createBaseInput({ sourceSnapshotId: "snapshot-20260831-002" }));

  const op1 = planSnap1.operations[0];
  const op2 = planSnap2.operations[0];

  assert.ok(op1);
  assert.ok(op2);
  assert.equal(op1.baseOperationKey, op2.baseOperationKey);
  assert.notEqual(op1.idempotencyKey, op2.idempotencyKey);
  assert.equal(op1.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE:snapshot-20260831-001");
  assert.equal(op2.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_PRICE:snapshot-20260831-002");
});

// 35. Sequential inventory-change plans for same product with different snapshot IDs have different idempotency keys
test("planSync: two sequential inventory-change plans for the same product but different snapshot IDs have different idempotency keys", () => {
  const diff = makeInventoryDiff();
  const planSnap1 = planSync(createBaseInput({ diff, sourceSnapshotId: "snapshot-inv-001" }));
  const planSnap2 = planSync(createBaseInput({ diff, sourceSnapshotId: "snapshot-inv-002" }));

  const op1 = planSnap1.operations[0];
  const op2 = planSnap2.operations[0];

  assert.ok(op1);
  assert.ok(op2);
  assert.equal(op1.baseOperationKey, op2.baseOperationKey);
  assert.notEqual(op1.idempotencyKey, op2.idempotencyKey);
  assert.equal(op1.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK:snapshot-inv-001");
  assert.equal(op2.idempotencyKey, "shopee:seller_official:jakmall:6970238281488:UPDATE_STOCK:snapshot-inv-002");
});

// 36. blank sourceSnapshotId rejected
test("planSync: blank or missing sourceSnapshotId is rejected with SyncPlanningInputError", () => {
  assert.throws(
    () => planSync(createBaseInput({ sourceSnapshotId: "" })),
    SyncPlanningInputError
  );

  assert.throws(
    () => planSync(createBaseInput({ sourceSnapshotId: "   " })),
    SyncPlanningInputError
  );

  assert.throws(
    // @ts-expect-error test undefined snapshot ID
    () => planSync(createBaseInput({ sourceSnapshotId: undefined })),
    SyncPlanningInputError
  );
});

// 37. sourceSnapshotId containing ':' rejected
test("planSync: sourceSnapshotId containing ':' is rejected with SyncPlanningInputError", () => {
  assert.throws(
    () => planSync(createBaseInput({ sourceSnapshotId: "snap:001" })),
    (err: unknown) => {
      assert(err instanceof SyncPlanningInputError);
      assert.match(err.message, /sourceSnapshotId must not contain separator ':'/);
      return true;
    }
  );
});

// 38. sourceSnapshotId preserved literally in operations
test("planSync: sourceSnapshotId is preserved literally and reflected in snapshot-scoped idempotencyKey", () => {
  const literalSnapshotId = "snap_prod_6970238281488_v99";
  const plan = planSync(createBaseInput({ sourceSnapshotId: literalSnapshotId }));

  const op0 = plan.operations[0];
  assert.ok(op0);
  assert.ok(op0.idempotencyKey.endsWith(`:${literalSnapshotId}`));
});
