// FILE: terminal-handler.test.js
// Purpose: Verifies bridge-owned terminal sessions open, stream output, accept input, and close cleanly.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, node:events, ../src/terminal-handler

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createTerminalHandler } = require("../src/terminal-handler");

function createFakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    destroyed: false,
    writableEnded: false,
    writes: [],
    endCalled: false,
    write(value) {
      this.writes.push(value);
      return true;
    },
    end() {
      this.endCalled = true;
      this.writableEnded = true;
    },
  };
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.emit("close", 0, signal || null);
    return true;
  };
  return child;
}

test("terminal/open streams output and terminal/write forwards stdin", async () => {
  const responses = [];
  const notifications = [];
  let spawnedChild = null;

  const handler = createTerminalHandler({
    sendNotification(rawMessage) {
      notifications.push(JSON.parse(rawMessage));
    },
    spawnImpl(_command, _args, _options) {
      spawnedChild = createFakeChildProcess();
      return spawnedChild;
    },
    fsModule: {
      statSync() {
        return {
          isDirectory() {
            return true;
          },
        };
      },
    },
    osModule: {
      homedir() {
        return "/Users/tester";
      },
    },
    pathModule: require("path"),
  });

  const openHandled = handler.handleTerminalRequest(JSON.stringify({
    id: "open-1",
    method: "terminal/open",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      shell: "/bin/zsh",
      sessionName: "My shell",
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  assert.equal(openHandled, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const openResult = responses[0].result;
  assert.equal(openResult.threadId, "thread-1");
  assert.equal(openResult.cwd, "/tmp/project");
  assert.equal(openResult.shell, "/bin/zsh");
  assert.equal(openResult.sessionName, "My shell");

  spawnedChild.stdout.emit("data", Buffer.from("hello\n", "utf8"));
  assert.deepEqual(notifications[0], {
    method: "terminal/output",
    params: {
      sessionId: openResult.sessionId,
      threadId: "thread-1",
      text: "hello\n",
    },
  });

  const writeHandled = handler.handleTerminalRequest(JSON.stringify({
    id: "write-1",
    method: "terminal/write",
    params: {
      threadId: "thread-1",
      sessionId: openResult.sessionId,
      text: "ls\n",
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  assert.equal(writeHandled, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(spawnedChild.stdin.writes, ["ls\n"]);
  assert.equal(responses[1].result?.ok, true);
});

test("terminal/close ends the running session and emits closed notification", async () => {
  const responses = [];
  const notifications = [];
  let spawnedChild = null;

  const handler = createTerminalHandler({
    sendNotification(rawMessage) {
      notifications.push(JSON.parse(rawMessage));
    },
    spawnImpl() {
      spawnedChild = createFakeChildProcess();
      return spawnedChild;
    },
    fsModule: {
      statSync() {
        return {
          isDirectory() {
            return true;
          },
        };
      },
    },
    osModule: {
      homedir() {
        return "/Users/tester";
      },
    },
    pathModule: require("path"),
  });

  handler.handleTerminalRequest(JSON.stringify({
    id: "open-2",
    method: "terminal/open",
    params: {
      threadId: "thread-2",
      cwd: "/tmp/project",
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const sessionId = responses[0].result?.sessionId;

  handler.handleTerminalRequest(JSON.stringify({
    id: "close-2",
    method: "terminal/close",
    params: {
      threadId: "thread-2",
      sessionId,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(spawnedChild.killCalls, ["SIGHUP"]);
  assert.equal(spawnedChild.stdin.endCalled, true);
  assert.equal(responses[1].result?.ok, true);
  assert.deepEqual(notifications.at(-1), {
    method: "terminal/closed",
    params: {
      sessionId,
      threadId: "thread-2",
      exitCode: 0,
      signal: "SIGHUP",
    },
  });
});
