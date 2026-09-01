import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSyncJobTransition,
  canTransitionSyncJobStatus,
  InvalidSyncJobTransitionError,
  mapPlanStatusToInitialJobStatus,
} from "../src/sync/state-machine.js";

test("canTransitionSyncJobStatus allows valid transitions from PENDING", () => {
  assert.equal(canTransitionSyncJobStatus("PENDING", "PROCESSING"), true);
  assert.equal(canTransitionSyncJobStatus("PENDING", "NEEDS_REVIEW"), true);
  assert.equal(canTransitionSyncJobStatus("PENDING", "BLOCKED"), true);
  assert.equal(canTransitionSyncJobStatus("PENDING", "CANCELLED"), true);

  // Illegal from PENDING
  assert.equal(canTransitionSyncJobStatus("PENDING", "COMPLETED"), false);
  assert.equal(canTransitionSyncJobStatus("PENDING", "FAILED"), false);
});

test("canTransitionSyncJobStatus allows valid transitions from PROCESSING", () => {
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "COMPLETED"), true);
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "FAILED"), true);
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "NEEDS_REVIEW"), true);
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "BLOCKED"), true);
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "CANCELLED"), true);

  // Illegal from PROCESSING
  assert.equal(canTransitionSyncJobStatus("PROCESSING", "PENDING"), false);
});

test("canTransitionSyncJobStatus allows requeuing or resolving from review/block/fail", () => {
  assert.equal(canTransitionSyncJobStatus("NEEDS_REVIEW", "PENDING"), true);
  assert.equal(canTransitionSyncJobStatus("NEEDS_REVIEW", "BLOCKED"), true);
  assert.equal(canTransitionSyncJobStatus("NEEDS_REVIEW", "CANCELLED"), true);

  assert.equal(canTransitionSyncJobStatus("BLOCKED", "PENDING"), true);
  assert.equal(canTransitionSyncJobStatus("BLOCKED", "CANCELLED"), true);

  assert.equal(canTransitionSyncJobStatus("FAILED", "PENDING"), true);
  assert.equal(canTransitionSyncJobStatus("FAILED", "CANCELLED"), true);
});

test("canTransitionSyncJobStatus rejects all transitions from terminal states COMPLETED and CANCELLED", () => {
  assert.equal(canTransitionSyncJobStatus("COMPLETED", "PENDING"), false);
  assert.equal(canTransitionSyncJobStatus("COMPLETED", "PROCESSING"), false);
  assert.equal(canTransitionSyncJobStatus("COMPLETED", "FAILED"), false);
  assert.equal(canTransitionSyncJobStatus("COMPLETED", "CANCELLED"), false);

  assert.equal(canTransitionSyncJobStatus("CANCELLED", "PENDING"), false);
  assert.equal(canTransitionSyncJobStatus("CANCELLED", "PROCESSING"), false);
  assert.equal(canTransitionSyncJobStatus("CANCELLED", "COMPLETED"), false);
});

test("assertSyncJobTransition succeeds on allowed transition and throws InvalidSyncJobTransitionError on illegal", () => {
  assert.doesNotThrow(() => {
    assertSyncJobTransition("PENDING", "PROCESSING");
  });

  assert.throws(
    () => {
      assertSyncJobTransition("COMPLETED", "PROCESSING");
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidSyncJobTransitionError);
      assert.equal(err.fromStatus, "COMPLETED");
      assert.equal(err.toStatus, "PROCESSING");
      assert.match(err.message, /Cannot transition SyncJob from status 'COMPLETED' to 'PROCESSING'/);
      return true;
    }
  );

  assert.throws(
    () => {
      assertSyncJobTransition("CANCELLED", "PENDING");
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidSyncJobTransitionError);
      assert.equal(err.fromStatus, "CANCELLED");
      assert.equal(err.toStatus, "PENDING");
      return true;
    }
  );
});

test("mapPlanStatusToInitialJobStatus maps planner outcomes to initial job lifecycle states", () => {
  assert.equal(mapPlanStatusToInitialJobStatus("NO_ACTION"), "COMPLETED");
  assert.equal(mapPlanStatusToInitialJobStatus("READY"), "PENDING");
  assert.equal(mapPlanStatusToInitialJobStatus("NEEDS_REVIEW"), "NEEDS_REVIEW");
  assert.equal(mapPlanStatusToInitialJobStatus("BLOCKED"), "BLOCKED");
});
