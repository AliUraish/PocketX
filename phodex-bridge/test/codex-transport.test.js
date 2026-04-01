// FILE: codex-transport.test.js
// Purpose: Verifies endpoint-backed Codex transport only sends after the websocket is open.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/codex-transport

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createCodexTransport } = require("../src/codex-transport");

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latestInstance = null;

  constructor(endpoint) {
    this.endpoint = endpoint;
    this.readyState = FakeWebSocket.CONNECTING;
    this.handlers = {};
    this.sentMessages = [];
    FakeWebSocket.latestInstance = this;
  }

  on(eventName, handler) {
    this.handlers[eventName] = handler;
  }

  send(message) {
    this.sentMessages.push(message);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(eventName, ...args) {
    this.handlers[eventName]?.(...args);
  }
}

test("endpoint transport only sends outbound messages after the websocket opens", () => {
  const transport = createCodexTransport({
    endpoint: "ws://127.0.0.1:4321/codex",
    WebSocketImpl: FakeWebSocket,
  });

  const socket = FakeWebSocket.latestInstance;
  assert.ok(socket);
  assert.equal(socket.endpoint, "ws://127.0.0.1:4321/codex");

  transport.send('{"id":"init-1","method":"initialize"}');
  transport.send('{"id":"list-1","method":"thread/list"}');
  assert.deepEqual(socket.sentMessages, []);

  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");

  assert.deepEqual(socket.sentMessages, []);

  transport.send('{"id":"list-2","method":"thread/list"}');
  assert.deepEqual(socket.sentMessages, ['{"id":"list-2","method":"thread/list"}']);
});

function createFakeSpawnChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.destroyed = false;
  child.stdin.writableEnded = false;
  child.stdin.writes = [];
  child.stdin.write = (message) => {
    child.stdin.writes.push(message);
  };
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test("spawn transport restarts a crashed local codex process and flushes queued outbound messages", () => {
  const availableChildren = [
    createFakeSpawnChild(101),
    createFakeSpawnChild(202),
  ];
  const spawnedChildren = [];
  const supervisorEvents = [];
  let scheduledRestart = null;
  const transport = createCodexTransport({
    spawnImpl() {
      const child = availableChildren.shift();
      assert.ok(child, "expected another fake codex child");
      spawnedChildren.push(child);
      return child;
    },
    setTimeoutImpl(callback, delay) {
      scheduledRestart = { callback, delay };
      return scheduledRestart;
    },
    clearTimeoutImpl() {
      scheduledRestart = null;
    },
    stableUptimeMs: 60_000,
  });
  transport.onSupervisorEvent((event) => {
    supervisorEvents.push(event);
  });

  const firstChild = spawnedChildren[0];
  assert.ok(firstChild);
  transport.send('{"id":"req-1"}');
  assert.deepEqual(firstChild.stdin.writes, ['{"id":"req-1"}\n']);

  firstChild.emit("close", 1, null);
  assert.ok(scheduledRestart);
  assert.equal(scheduledRestart.delay, 1_000);
  assert.equal(supervisorEvents.at(-1).state, "backoff");

  transport.send('{"id":"req-queued"}');
  assert.deepEqual(firstChild.stdin.writes, ['{"id":"req-1"}\n']);

  scheduledRestart.callback();
  const secondChild = spawnedChildren[1];
  assert.ok(secondChild);
  assert.deepEqual(secondChild.stdin.writes, ['{"id":"req-queued"}\n']);
  assert.equal(supervisorEvents.at(-1).state, "running");
});

test("spawn transport shutdown does not schedule a restart for the local codex process", () => {
  const child = createFakeSpawnChild(303);
  let scheduledRestart = null;
  const transport = createCodexTransport({
    spawnImpl() {
      return child;
    },
    setTimeoutImpl(callback, delay) {
      scheduledRestart = { callback, delay };
      return scheduledRestart;
    },
    clearTimeoutImpl() {
      scheduledRestart = null;
    },
  });

  transport.shutdown();
  child.emit("close", 0, null);
  assert.equal(scheduledRestart, null);
  assert.equal(child.killed, true);
});
