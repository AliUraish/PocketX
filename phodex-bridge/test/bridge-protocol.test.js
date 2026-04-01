// FILE: bridge-protocol.test.js
// Purpose: Verifies the bridge-owned mobile protocol facade stays stable over raw Codex shapes.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/bridge-protocol

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRIDGE_EVENT_METHOD,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_METHOD,
  buildBridgeCapabilities,
  buildBridgeEventEnvelope,
  buildBridgeHealthSnapshot,
  buildBridgeRequestEnvelope,
  extractRequestedBridgeProtocolVersion,
  normalizeBridgeProtocolResult,
} = require("../src/bridge-protocol");

test("extractRequestedBridgeProtocolVersion reads initialize capability negotiation", () => {
  assert.equal(
    extractRequestedBridgeProtocolVersion({
      capabilities: {
        bridgeProtocol: {
          maxVersion: 99,
        },
      },
    }),
    BRIDGE_PROTOCOL_VERSION
  );

  assert.equal(
    extractRequestedBridgeProtocolVersion({
      capabilities: {
        bridge_protocol: true,
      },
    }),
    BRIDGE_PROTOCOL_VERSION
  );
});

test("buildBridgeCapabilities reports bridge protocol envelopes and versions", () => {
  assert.deepEqual(
    buildBridgeCapabilities({
      packageVersionStatus: {
        bridgeVersion: "1.2.3",
        bridgeLatestVersion: "1.2.9",
      },
    }),
    {
      bridgeManaged: true,
      bridgeProtocolVersion: 1,
      notificationEnvelopeMethod: "bridge/event",
      requestEnvelopeMethod: "bridge/request",
      methods: [
        "bridge/thread/start",
        "bridge/thread/list",
        "bridge/thread/read",
        "bridge/thread/resume",
        "bridge/thread/fork",
        "bridge/model/list",
        "bridge/collaborationMode/list",
        "bridge/turn/start",
        "bridge/turn/steer",
        "bridge/turn/interrupt",
        "bridge/capabilities",
        "bridge/health",
        "bridge/diagnostics/read",
        "bridge/approval/list",
        "bridge/approval/resolve",
        "account/status/read",
        "voice/resolveAuth",
      ],
      features: {
        threadHistory: true,
        threadResume: true,
        turnStreaming: true,
        approvalQueue: true,
        bridgeHealth: true,
        bridgeDiagnostics: true,
        bridgeCapabilities: true,
        accountStatusRead: true,
        voiceResolveAuth: true,
      },
      bridgeVersion: "1.2.3",
      bridgeLatestVersion: "1.2.9",
    }
  );
});

test("normalizeBridgeProtocolResult flattens thread/list and turn/start responses", () => {
  assert.deepEqual(
    normalizeBridgeProtocolResult("bridge/thread/list", {
      data: [{ id: "thread-1" }],
      next_cursor: "cursor-2",
    }),
    {
      threads: [{ id: "thread-1" }],
      nextCursor: "cursor-2",
      rawResult: {
        data: [{ id: "thread-1" }],
        next_cursor: "cursor-2",
      },
    }
  );

  assert.deepEqual(
    normalizeBridgeProtocolResult("bridge/turn/start", {
      turn: {
        id: "turn-1",
        threadId: "thread-1",
      },
    }),
    {
      turnId: "turn-1",
      threadId: "thread-1",
      rawResult: {
        turn: {
          id: "turn-1",
          threadId: "thread-1",
        },
      },
    }
  );

  assert.deepEqual(
    normalizeBridgeProtocolResult("bridge/model/list", {
      models: [{ id: "gpt-5.4" }],
      nextCursor: null,
    }),
    {
      items: [{ id: "gpt-5.4" }],
      nextCursor: null,
      rawResult: {
        models: [{ id: "gpt-5.4" }],
        nextCursor: null,
      },
    }
  );

  assert.deepEqual(
    normalizeBridgeProtocolResult("bridge/collaborationMode/list", {
      modes: [{ mode: "plan" }],
    }),
    {
      items: [{ mode: "plan" }],
      nextCursor: null,
      rawResult: {
        modes: [{ mode: "plan" }],
      },
    }
  );
});

test("bridge event and request envelopes keep raw method context while normalizing event names", () => {
  assert.deepEqual(
    buildBridgeEventEnvelope("turn/started", {
      threadId: "thread-1",
      turnId: "turn-1",
    }),
    {
      method: BRIDGE_EVENT_METHOD,
      params: {
        event: "turn.started",
        rawMethod: "turn/started",
        rawParams: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }
  );

  assert.deepEqual(
    buildBridgeRequestEnvelope("req-1", "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
    }),
    {
      id: "req-1",
      method: BRIDGE_REQUEST_METHOD,
      params: {
        event: "approval.requested",
        rawMethod: "item/commandExecution/requestApproval",
        rawParams: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }
  );
});

test("buildBridgeHealthSnapshot reports a stable mobile-facing health state", () => {
  assert.deepEqual(
    buildBridgeHealthSnapshot({
      bridgeStatus: {
        state: "running",
        connectionStatus: "connected",
        lastError: "",
      },
      codexHandshakeState: "warm",
      pairingSession: {
        expiresAt: 10_000,
      },
      packageVersionStatus: {
        bridgeVersion: "1.2.3",
        bridgeLatestVersion: "1.2.9",
      },
      pendingApprovalCount: 2,
      lastRelayActivityAt: 8_500,
      now: 9_000,
    }),
    {
      status: "approval_pending",
      bridgeState: "running",
      relayConnectionStatus: "connected",
      codexConnectionStatus: "connected",
      codexHandshakeState: "warm",
      lastError: null,
      pendingApprovalCount: 2,
      pairingCodeActive: true,
      pairingCodeExpiresAt: 10_000,
      lastRelayActivityAt: 8_500,
      relayHeartbeatStale: false,
      canReconnect: false,
      bridgeVersion: "1.2.3",
      bridgeLatestVersion: "1.2.9",
    }
  );
});
