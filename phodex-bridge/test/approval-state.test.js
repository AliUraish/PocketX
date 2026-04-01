// FILE: approval-state.test.js
// Purpose: Verifies local approval persistence, expiry, and restart cleanup for bridge-managed approvals.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/approval-state

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridgeApprovalStateStore, resolveApprovalStatePath } = require("../src/approval-state");

function createMockFs() {
  const files = new Map();

  return {
    chmodSync() {},
    existsSync(targetPath) {
      return files.has(targetPath);
    },
    mkdirSync() {},
    readFileSync(targetPath) {
      if (!files.has(targetPath)) {
        throw new Error(`Missing file: ${targetPath}`);
      }
      return files.get(targetPath);
    },
    writeFileSync(targetPath, value) {
      files.set(targetPath, String(value));
    },
  };
}

test("approval state store persists queue entries and resolved audit records", () => {
  const fsImpl = createMockFs();
  const env = {
    HOME: "/tmp/approval-test",
    RIMCODEX_DEVICE_STATE_DIR: "/tmp/approval-test",
  };
  let now = 1_000;

  const store = createBridgeApprovalStateStore({
    bridgeSessionId: "session-a",
    staleAfterMs: 10_000,
    now: () => now,
    fsImpl,
    env,
  });

  store.rememberPendingApproval({
    requestId: "req-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "git status" },
    threadId: "thread-1",
    turnId: "turn-1",
    command: "git status",
    createdAt: now,
  });

  assert.equal(store.countPendingApprovals(), 1);

  now = 1_500;
  store.resolvePendingApproval("req-1", { decision: "accept" }, { outcome: "resolved_from_phone" });
  assert.equal(store.countPendingApprovals(), 0);

  const persisted = JSON.parse(
    fsImpl.readFileSync(resolveApprovalStatePath({ env }), "utf8")
  );
  assert.equal(persisted.pendingApprovals.length, 0);
  assert.equal(persisted.auditLog.length, 2);
  assert.equal(persisted.auditLog[0].action, "requested");
  assert.equal(persisted.auditLog[1].action, "resolved");
  assert.equal(persisted.auditLog[1].decision, "accept");
  assert.equal(persisted.auditLog[1].outcome, "resolved_from_phone");
});

test("approval state store expires stale entries and clears old queue on new bridge session", () => {
  const fsImpl = createMockFs();
  const env = {
    HOME: "/tmp/approval-test",
    RIMCODEX_DEVICE_STATE_DIR: "/tmp/approval-test",
  };
  let now = 2_000;

  const initialStore = createBridgeApprovalStateStore({
    bridgeSessionId: "session-a",
    staleAfterMs: 500,
    now: () => now,
    fsImpl,
    env,
  });
  initialStore.rememberPendingApproval({
    requestId: "req-stale",
    method: "item/fileChange/requestApproval",
    params: { reason: "Write file" },
    createdAt: now,
  });

  now = 2_800;
  assert.equal(initialStore.countPendingApprovals(), 0);

  const afterExpiry = JSON.parse(
    fsImpl.readFileSync(resolveApprovalStatePath({ env }), "utf8")
  );
  assert.equal(afterExpiry.auditLog.at(-1).action, "expired");
  assert.equal(afterExpiry.auditLog.at(-1).outcome, "stale_timeout");

  now = 3_000;
  const sessionAStore = createBridgeApprovalStateStore({
    bridgeSessionId: "session-a",
    staleAfterMs: 10_000,
    now: () => now,
    fsImpl,
    env,
  });
  sessionAStore.rememberPendingApproval({
    requestId: "req-restart",
    method: "item/commandExecution/requestApproval",
    params: { command: "rm -rf build" },
    createdAt: now,
  });

  now = 3_100;
  const sessionBStore = createBridgeApprovalStateStore({
    bridgeSessionId: "session-b",
    staleAfterMs: 10_000,
    now: () => now,
    fsImpl,
    env,
  });
  assert.equal(sessionBStore.countPendingApprovals(), 0);

  const afterRestart = JSON.parse(
    fsImpl.readFileSync(resolveApprovalStatePath({ env }), "utf8")
  );
  assert.equal(afterRestart.bridgeSessionId, "session-b");
  assert.equal(afterRestart.pendingApprovals.length, 0);
  assert.equal(afterRestart.auditLog.at(-1).action, "cleared_on_restart");
  assert.equal(afterRestart.auditLog.at(-1).outcome, "bridge_restarted");
});
