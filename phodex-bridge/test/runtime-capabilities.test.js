// FILE: runtime-capabilities.test.js
// Purpose: Verifies the bridge-owned runtime compatibility probe produces stable capability flags.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/runtime-capabilities

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridgeRuntimeCapabilitiesReader } = require("../src/runtime-capabilities");

test("runtime capability reader probes safe features and caches the snapshot", async () => {
  const calls = [];
  let execCalls = 0;
  const reader = createBridgeRuntimeCapabilitiesReader({
    sendCodexRequest(method) {
      calls.push(method);
      switch (method) {
        case "collaborationMode/list":
          return Promise.resolve({
            modes: [{ mode: "plan" }],
          });
        case "thread/start": {
          const error = new Error("Missing required field: input");
          error.code = -32602;
          return Promise.reject(error);
        }
        case "thread/fork": {
          const error = new Error("Missing required field: threadId");
          error.code = -32602;
          return Promise.reject(error);
        }
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    },
    execFileAsyncImpl() {
      execCalls += 1;
      return Promise.resolve({ stdout: "codex 0.43.1\n" });
    },
    now: () => 10_000,
  });

  const firstSnapshot = await reader.readSnapshot();
  const secondSnapshot = await reader.readSnapshot();

  assert.deepEqual(firstSnapshot, {
    codexVersion: "0.43.1",
    probedAt: 10_000,
    capabilities: {
      planCollaborationMode: true,
      serviceTier: true,
      threadFork: true,
    },
  });
  assert.deepEqual(secondSnapshot, firstSnapshot);
  assert.deepEqual(calls, [
    "collaborationMode/list",
    "thread/start",
    "thread/fork",
  ]);
  assert.equal(execCalls, 1);
});

test("runtime capability reader marks unsupported features when the runtime rejects the method", async () => {
  const reader = createBridgeRuntimeCapabilitiesReader({
    sendCodexRequest(method) {
      switch (method) {
        case "collaborationMode/list": {
          const error = new Error("Method not found: collaborationMode/list");
          error.code = -32601;
          return Promise.reject(error);
        }
        case "thread/start": {
          const error = new Error("Unknown field: serviceTier");
          error.code = -32602;
          return Promise.reject(error);
        }
        case "thread/fork": {
          const error = new Error("Method not found: thread/fork");
          error.code = -32601;
          return Promise.reject(error);
        }
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    },
    canReadLocalCodexVersion: false,
    now: () => 20_000,
  });

  assert.deepEqual(await reader.readSnapshot(), {
    codexVersion: null,
    probedAt: 20_000,
    capabilities: {
      planCollaborationMode: false,
      serviceTier: false,
      threadFork: false,
    },
  });
});
