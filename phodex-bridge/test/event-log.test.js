// FILE: event-log.test.js
// Purpose: Verifies bridge diagnostics journaling persists safe, ordered recent events.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/event-log

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridgeEventLogStore, resolveEventLogPath } = require("../src/event-log");

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

test("event log persists recent events and redacts bearer-like metadata", () => {
  const fsImpl = createMockFs();
  const env = {
    HOME: "/tmp/event-log-test",
    POCKETEX_DEVICE_STATE_DIR: "/tmp/event-log-test",
  };
  let now = 10_000;

  const store = createBridgeEventLogStore({
    fsImpl,
    env,
    maxEntries: 2,
    now: () => now,
  });

  store.append({
    type: "relay.connected",
    level: "info",
    message: "Connected to the relay.",
    metadata: {
      connectionStatus: "connected",
      sessionId: "secret-session",
    },
  });
  now = 20_000;
  store.append({
    type: "approval.requested",
    level: "warning",
    message: "A run is waiting for approval.",
    metadata: {
      threadId: "thread-1",
      pairingCode: "ABCD1234",
    },
  });
  now = 30_000;
  store.append({
    type: "codex.restart_backoff",
    level: "error",
    message: "Local codex app-server exited unexpectedly.",
    detail: "Process exited with code 1.",
    metadata: {
      restartCount: 2,
      restartDelayMs: 2000,
    },
  });

  const recentEvents = store.listRecentEvents(5);
  assert.equal(recentEvents.length, 2);
  assert.equal(recentEvents[0].type, "codex.restart_backoff");
  assert.equal(recentEvents[1].type, "approval.requested");
  assert.deepEqual(recentEvents[1].metadata, {
    threadId: "thread-1",
  });

  const persisted = JSON.parse(fsImpl.readFileSync(resolveEventLogPath({ env }), "utf8"));
  assert.equal(persisted.events.length, 2);
  assert.equal(persisted.events[0].metadata.sessionId, undefined);
  assert.equal(persisted.events[1].metadata.restartDelayMs, 2000);
});
