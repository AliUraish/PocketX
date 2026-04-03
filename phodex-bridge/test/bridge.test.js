// FILE: bridge.test.js
// Purpose: Verifies relay watchdog helpers used to recover from stale sleep/wake sockets.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/bridge

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPendingBridgeRequestLifecycleEvent,
  buildStructuredUserInputNotificationBody,
  buildHeartbeatBridgeStatus,
  describePendingBridgeRequest,
  hasRelayConnectionGoneStale,
  sanitizeThreadHistoryImagesForRelay,
} = require("../src/bridge");

test("hasRelayConnectionGoneStale returns true once the relay silence crosses the timeout", () => {
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 71_000,
      staleAfterMs: 70_000,
    }),
    true
  );
});

test("hasRelayConnectionGoneStale returns false for fresh or missing activity timestamps", () => {
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 70_999,
      staleAfterMs: 70_000,
    }),
    false
  );
  assert.equal(hasRelayConnectionGoneStale(Number.NaN), false);
});

test("buildHeartbeatBridgeStatus downgrades stale connected snapshots", () => {
  assert.deepEqual(
    buildHeartbeatBridgeStatus(
      {
        state: "running",
        connectionStatus: "connected",
        pid: 123,
        lastError: "",
      },
      1_000,
      {
        now: 26_500,
        staleAfterMs: 25_000,
        staleMessage: "Relay heartbeat stalled; reconnect pending.",
      }
    ),
    {
      state: "running",
      connectionStatus: "disconnected",
      pid: 123,
      lastError: "Relay heartbeat stalled; reconnect pending.",
    }
  );
});

test("buildHeartbeatBridgeStatus leaves fresh or already-disconnected snapshots unchanged", () => {
  const freshStatus = {
    state: "running",
    connectionStatus: "connected",
    pid: 123,
    lastError: "",
  };
  assert.deepEqual(
    buildHeartbeatBridgeStatus(freshStatus, 1_000, {
      now: 20_000,
      staleAfterMs: 25_000,
    }),
    freshStatus
  );

  const disconnectedStatus = {
    state: "running",
    connectionStatus: "disconnected",
    pid: 123,
    lastError: "",
  };
  assert.deepEqual(buildHeartbeatBridgeStatus(disconnectedStatus, 1_000), disconnectedStatus);
});

test("sanitizeThreadHistoryImagesForRelay replaces inline history images with lightweight references", () => {
  const rawMessage = JSON.stringify({
    id: "req-thread-read",
    result: {
      thread: {
        id: "thread-images",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-user",
                type: "user_message",
                content: [
                  {
                    type: "input_text",
                    text: "Look at this screenshot",
                  },
                  {
                    type: "image",
                    image_url: "data:image/png;base64,AAAA",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  const sanitized = JSON.parse(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "thread/read")
  );
  const content = sanitized.result.thread.turns[0].items[0].content;

  assert.deepEqual(content[0], {
    type: "input_text",
    text: "Look at this screenshot",
  });
  assert.deepEqual(content[1], {
    type: "image",
    url: "pocketex://history-image-elided",
  });
});

test("sanitizeThreadHistoryImagesForRelay leaves unrelated RPC payloads unchanged", () => {
  const rawMessage = JSON.stringify({
    id: "req-other",
    result: {
      ok: true,
    },
  });

  assert.equal(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "turn/start"),
    rawMessage
  );
});

test("describePendingBridgeRequest treats structured input separately from approvals", () => {
  const structuredInput = describePendingBridgeRequest({
    requestId: "req-input-1",
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      questions: [{ id: "mode" }, { id: "risk" }],
    },
  });

  assert.deepEqual(structuredInput, {
    kind: "structured_user_input",
    requestId: "req-input-1",
    threadId: "thread-1",
    turnId: "turn-1",
    questionCount: 2,
    pushEvent: {
      eventType: "structured_user_input_needed",
      threadId: "thread-1",
      turnId: "turn-1",
      title: "pocketex input needed",
      body: "Codex needs 2 answers to continue.",
      dedupeKey: "structured-user-input:req-input-1",
      eventPayload: {
        requestId: "req-input-1",
        questionCount: 2,
      },
    },
  });

  const approval = describePendingBridgeRequest({
    requestId: "req-approval-1",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-2",
    turnId: "turn-2",
    params: {
      reason: "Approval needed to continue the run.",
    },
  });

  assert.equal(approval.kind, "approval");
  assert.equal(approval.pushEvent.eventType, "approval_needed");
  assert.equal(approval.pushEvent.body, "Approval needed to continue the run.");
});

test("buildPendingBridgeRequestLifecycleEvent uses structured input-specific messages", () => {
  const lifecycleEvent = buildPendingBridgeRequestLifecycleEvent({
    kind: "structured_user_input",
    threadId: "thread-1",
    turnId: "turn-1",
    questionCount: 1,
  }, "requested");

  assert.deepEqual(lifecycleEvent, {
    type: "structured_user_input.requested",
    level: "warning",
    message: "Codex needs input to continue.",
    detail: "Codex needs one answer to continue.",
    metadata: {
      threadId: "thread-1",
      turnId: "turn-1",
      questionCount: 1,
    },
  });
});

test("buildStructuredUserInputNotificationBody handles singular, plural, and fallback phrasing", () => {
  assert.equal(buildStructuredUserInputNotificationBody(1), "Codex needs one answer to continue.");
  assert.equal(buildStructuredUserInputNotificationBody(3), "Codex needs 3 answers to continue.");
  assert.equal(buildStructuredUserInputNotificationBody(0), "Codex needs input to continue.");
});
