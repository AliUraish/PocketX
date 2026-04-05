// FILE: terminal-handler.js
// Purpose: Runs bridge-owned local terminal sessions, optionally backed by tmux for Reveal on Mac.
// Layer: Bridge handler
// Exports: createTerminalHandler
// Depends on: child_process, crypto, fs, os, path

const { execFile, spawn, spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const TMUX_OUTPUT_POLL_INTERVAL_MS = 120;
const EXEC_TIMEOUT_MS = 10_000;

function createTerminalHandler({
  sendNotification,
  spawnImpl = spawn,
  execFileImpl = execFileAsync,
  spawnSyncImpl = spawnSync,
  fsModule = fs,
  osModule = os,
  pathModule = path,
  platform = process.platform,
  env = process.env,
} = {}) {
  const sessionsById = new Map();
  const sessionIdByThreadId = new Map();
  const tmuxBinaryPath = resolveTmuxBinaryPath({
    spawnSyncImpl,
    platform,
  });

  function handleTerminalRequest(rawMessage, sendResponse) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method.startsWith("terminal/")) {
      return false;
    }

    const id = parsed.id;
    const params = parsed.params || {};

    handleTerminalMethod(method, params)
      .then((result) => {
        sendResponse(JSON.stringify({ id, result }));
      })
      .catch((error) => {
        sendResponse(JSON.stringify({
          id,
          error: {
            code: -32000,
            message: error.userMessage || error.message || "Terminal request failed.",
            data: {
              errorCode: error.errorCode || "terminal_error",
            },
          },
        }));
      });

    return true;
  }

  async function handleTerminalMethod(method, params) {
    switch (method) {
      case "terminal/open":
        return openTerminalSession(params);
      case "terminal/write":
        return writeTerminalSession(params);
      case "terminal/close":
        return closeTerminalSession(params);
      case "terminal/revealOnMac":
        return revealTerminalOnMac(params);
      default:
        throw terminalError("unknown_method", `Unknown terminal method: ${method}`);
    }
  }

  async function openTerminalSession(params) {
    const threadId = readRequiredString(params.threadId, "missing_thread_id", "terminal/open requires a threadId.");
    const shellPath = normalizeNonEmptyString(params.shell) || defaultShellPath(platform);
    const sessionName = normalizeNonEmptyString(params.sessionName) || "Local terminal";
    const workingDirectory = resolveWorkingDirectory(params, {
      fsModule,
      osModule,
      pathModule,
    });

    const existingSessionId = sessionIdByThreadId.get(threadId);
    if (existingSessionId) {
      await destroySession(existingSessionId, { notify: false });
    }

    const sessionId = randomUUID();
    const session = tmuxBinaryPath
      ? await createTmuxSession({
          execFileImpl,
          fsModule,
          osModule,
          pathModule,
          shellPath,
          sessionId,
          sessionName,
          threadId,
          tmuxBinaryPath,
          workingDirectory,
        })
      : createProcessSession({
          env,
          platform,
          sessionId,
          sessionName,
          shellPath,
          spawnImpl,
          threadId,
          workingDirectory,
        });

    sessionsById.set(sessionId, session);
    sessionIdByThreadId.set(threadId, sessionId);

    if (session.backend === "tmux") {
      bindTmuxSessionOutput(session);
    } else {
      bindProcessSessionOutput(session);
    }

    return {
      ok: true,
      threadId,
      sessionId,
      sessionName,
      shell: shellPath,
      cwd: workingDirectory,
      backend: session.backend,
      canRevealOnMac: Boolean(session.tmuxSessionName && platform === "darwin"),
    };
  }

  async function writeTerminalSession(params) {
    const session = resolveSession(params);
    const text = typeof params?.text === "string" ? params.text : "";
    if (!text) {
      throw terminalError("missing_text", "terminal/write requires non-empty text.");
    }

    if (session.backend === "tmux") {
      await writeTmuxInput(session, text);
    } else {
      if (!session.child?.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) {
        throw terminalError("session_closed", "This terminal session is no longer running.");
      }
      session.child.stdin.write(text);
    }

    return {
      ok: true,
      sessionId: session.sessionId,
      threadId: session.threadId,
    };
  }

  async function closeTerminalSession(params) {
    const session = resolveSession(params);
    await destroySession(session.sessionId, { notify: false });
    return {
      ok: true,
      sessionId: session.sessionId,
      threadId: session.threadId,
    };
  }

  async function revealTerminalOnMac(params) {
    const session = resolveSession(params);

    if (platform !== "darwin") {
      throw terminalError("unsupported_platform", "Reveal on Mac is only available when the bridge is running on macOS.");
    }

    if (!session.tmuxSessionName || !tmuxBinaryPath) {
      throw terminalError("tmux_unavailable", "Reveal on Mac requires tmux to be installed on this Mac.");
    }

    const attachCommand = `${shellQuote(tmuxBinaryPath)} attach -t ${shellQuote(session.tmuxSessionName)}`;
    await execFileImpl("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script ${appleScriptStringLiteral(attachCommand)}`,
    ], {
      timeout: EXEC_TIMEOUT_MS,
    });

    return {
      ok: true,
      sessionId: session.sessionId,
      threadId: session.threadId,
      backend: session.backend,
      revealedOnMac: true,
    };
  }

  function bindProcessSessionOutput(session) {
    const { child, sessionId, threadId } = session;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        sendTerminalNotification("terminal/output", {
          sessionId,
          threadId,
          text: chunkToString(chunk),
        });
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        sendTerminalNotification("terminal/output", {
          sessionId,
          threadId,
          text: chunkToString(chunk),
        });
      });
    }

    child.on("error", (error) => {
      sendTerminalClosed({
        session,
        errorMessage: error.message || "Terminal failed to start.",
      });
    });

    child.on("close", (exitCode, signal) => {
      if (!sessionsById.has(sessionId)) {
        return;
      }

      sendTerminalClosed({
        session,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === "string" ? signal : null,
      });
    });
  }

  function bindTmuxSessionOutput(session) {
    session.outputPollTimer = setInterval(() => {
      void pollTmuxOutput(session);
    }, TMUX_OUTPUT_POLL_INTERVAL_MS);
    session.outputPollTimer.unref?.();
    void pollTmuxOutput(session);
  }

  async function pollTmuxOutput(session) {
    if (!sessionsById.has(session.sessionId) || !session.logFilePath) {
      return;
    }

    const currentSize = safeFileSize(session.logFilePath, fsModule);
    if (currentSize < session.logFileOffset) {
      session.logFileOffset = 0;
    }

    if (currentSize <= session.logFileOffset) {
      return;
    }

    const delta = readFileSlice(
      session.logFilePath,
      session.logFileOffset,
      currentSize,
      fsModule
    );
    session.logFileOffset = currentSize;

    if (!delta) {
      return;
    }

    sendTerminalNotification("terminal/output", {
      sessionId: session.sessionId,
      threadId: session.threadId,
      text: delta,
    });
  }

  async function writeTmuxInput(session, text) {
    const tokens = tokenizeTerminalInput(text);
    for (const token of tokens) {
      if (token.kind === "literal") {
        if (!token.value) {
          continue;
        }
        await execFileImpl(tmuxBinaryPath, [
          "send-keys",
          "-t",
          session.tmuxSessionName,
          "-l",
          token.value,
        ], {
          timeout: EXEC_TIMEOUT_MS,
        });
        continue;
      }

      await execFileImpl(tmuxBinaryPath, [
        "send-keys",
        "-t",
        session.tmuxSessionName,
        token.value,
      ], {
        timeout: EXEC_TIMEOUT_MS,
      });
    }
  }

  async function destroySession(sessionId, { notify = false } = {}) {
    const session = sessionsById.get(sessionId);
    if (!session || session.isClosing) {
      return;
    }

    session.isClosing = true;

    if (session.outputPollTimer) {
      clearInterval(session.outputPollTimer);
      session.outputPollTimer = null;
    }

    if (session.backend === "tmux") {
      try {
        await execFileImpl(tmuxBinaryPath, [
          "kill-session",
          "-t",
          session.tmuxSessionName,
        ], {
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch (error) {
        if (!isIgnorableTmuxMissingSessionError(error)) {
          throw error;
        }
      }

      cleanupTmuxArtifacts(session, { fsModule });
      if (notify) {
        sendTerminalClosed({ session });
      } else {
        forgetSession(sessionId);
      }
      return;
    }

    try {
      session.child?.stdin?.end();
    } catch {}

    try {
      session.child?.kill("SIGHUP");
    } catch {}

    if (notify) {
      sendTerminalClosed({ session });
    }
  }

  function destroyAllSessions() {
    for (const sessionId of [...sessionsById.keys()]) {
      void destroySession(sessionId, { notify: false });
    }
  }

  function forgetSession(sessionId) {
    const session = sessionsById.get(sessionId);
    if (!session) {
      return;
    }

    sessionsById.delete(sessionId);
    if (sessionIdByThreadId.get(session.threadId) === sessionId) {
      sessionIdByThreadId.delete(session.threadId);
    }
  }

  function resolveSession(params) {
    const sessionId = normalizeNonEmptyString(params?.sessionId);
    const threadId = normalizeNonEmptyString(params?.threadId);
    const resolvedSessionId = sessionId || (threadId ? sessionIdByThreadId.get(threadId) : null);
    if (!resolvedSessionId) {
      throw terminalError("missing_session_id", "A terminal session id is required.");
    }

    const session = sessionsById.get(resolvedSessionId);
    if (!session) {
      throw terminalError("session_not_found", "This terminal session is no longer available.");
    }

    return session;
  }

  function sendTerminalNotification(method, params) {
    if (typeof sendNotification !== "function") {
      return;
    }

    sendNotification(JSON.stringify({
      method,
      params,
    }));
  }

  function sendTerminalClosed({
    session,
    errorMessage = null,
    exitCode = null,
    signal = null,
  }) {
    cleanupTmuxArtifacts(session, { fsModule });
    forgetSession(session.sessionId);
    sendTerminalNotification("terminal/closed", compactObject({
      sessionId: session.sessionId,
      threadId: session.threadId,
      errorMessage,
      exitCode,
      signal,
    }));
  }

  function getCapabilitySnapshot() {
    return {
      terminalSessions: true,
      terminalRevealOnMac: Boolean(tmuxBinaryPath && platform === "darwin"),
      terminalTmux: Boolean(tmuxBinaryPath),
    };
  }

  return {
    destroyAllSessions,
    getCapabilitySnapshot,
    handleTerminalRequest,
  };
}

async function createTmuxSession({
  execFileImpl,
  fsModule,
  osModule,
  pathModule,
  shellPath,
  sessionId,
  sessionName,
  threadId,
  tmuxBinaryPath,
  workingDirectory,
}) {
  const tmuxSessionName = buildTmuxSessionName(sessionId, sessionName);
  const logFilePath = pathModule.join(osModule.tmpdir(), `rimcodex-terminal-${sessionId}.log`);
  fsModule.writeFileSync(logFilePath, "");

  await execFileImpl(tmuxBinaryPath, [
    "new-session",
    "-d",
    "-s",
    tmuxSessionName,
    "-c",
    workingDirectory,
    shellPath,
    "-i",
  ], {
    timeout: EXEC_TIMEOUT_MS,
  });

  await execFileImpl(tmuxBinaryPath, [
    "pipe-pane",
    "-t",
    tmuxSessionName,
    "-o",
    `cat >> ${shellQuote(logFilePath)}`,
  ], {
    timeout: EXEC_TIMEOUT_MS,
  });

  return {
    backend: "tmux",
    isClosing: false,
    logFileOffset: 0,
    logFilePath,
    outputPollTimer: null,
    sessionId,
    sessionName,
    shellPath,
    threadId,
    tmuxSessionName,
    workingDirectory,
  };
}

function createProcessSession({
  env,
  platform,
  sessionId,
  sessionName,
  shellPath,
  spawnImpl,
  threadId,
  workingDirectory,
}) {
  const child = spawnTerminalProcess({
    shellPath,
    workingDirectory,
    spawnImpl,
    platform,
    env,
  });

  return {
    backend: "process",
    child,
    isClosing: false,
    sessionId,
    sessionName,
    shellPath,
    threadId,
    workingDirectory,
  };
}

function spawnTerminalProcess({
  shellPath,
  workingDirectory,
  spawnImpl,
  platform,
  env,
}) {
  const terminalEnv = {
    ...env,
    TERM: env?.TERM || "xterm-256color",
    COLORTERM: env?.COLORTERM || "truecolor",
    SHELL: shellPath,
  };

  if (platform === "darwin") {
    return spawnImpl("script", ["-q", "/dev/null", shellPath, "-i"], {
      cwd: workingDirectory,
      env: terminalEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  if (platform === "linux") {
    return spawnImpl("script", ["-q", "-c", `${shellPath} -i`, "/dev/null"], {
      cwd: workingDirectory,
      env: terminalEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  return spawnImpl(shellPath, ["-i"], {
    cwd: workingDirectory,
    env: terminalEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function resolveTmuxBinaryPath({ spawnSyncImpl, platform }) {
  if (platform === "win32") {
    return "";
  }

  const result = spawnSyncImpl("which", ["tmux"], {
    encoding: "utf8",
  });
  if (result?.status !== 0) {
    return "";
  }

  return normalizeNonEmptyString(result.stdout);
}

function cleanupTmuxArtifacts(session, { fsModule }) {
  if (session.outputPollTimer) {
    clearInterval(session.outputPollTimer);
    session.outputPollTimer = null;
  }

  if (session.logFilePath) {
    try {
      fsModule.unlinkSync(session.logFilePath);
    } catch {}
  }
}

function safeFileSize(filePath, fsModule) {
  try {
    return fsModule.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readFileSlice(filePath, start, endExclusive, fsModule) {
  const length = Math.max(0, endExclusive - start);
  if (length === 0) {
    return "";
  }

  const fileHandle = fsModule.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fsModule.readSync(fileHandle, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

function resolveWorkingDirectory(params, { fsModule, osModule, pathModule }) {
  const rawDirectory = normalizeNonEmptyString(
    params?.cwd || params?.workingDirectory || params?.working_directory
  ) || osModule.homedir();
  const expandedDirectory = rawDirectory.startsWith("~")
    ? pathModule.join(osModule.homedir(), rawDirectory.slice(1))
    : rawDirectory;
  const resolvedDirectory = pathModule.resolve(expandedDirectory);

  let stats;
  try {
    stats = fsModule.statSync(resolvedDirectory);
  } catch {
    throw terminalError("missing_working_directory", "The selected working directory is not available on this Mac.");
  }

  if (!stats.isDirectory()) {
    throw terminalError("invalid_working_directory", "The selected working directory is not a folder.");
  }

  return resolvedDirectory;
}

function tokenizeTerminalInput(text) {
  const tokens = [];
  let buffer = "";
  let index = 0;

  const pushBuffer = () => {
    if (!buffer) {
      return;
    }
    tokens.push({ kind: "literal", value: buffer });
    buffer = "";
  };

  while (index < text.length) {
    const remaining = text.slice(index);

    if (remaining.startsWith("\u001B[A")) {
      pushBuffer();
      tokens.push({ kind: "key", value: "Up" });
      index += 3;
      continue;
    }
    if (remaining.startsWith("\u001B[B")) {
      pushBuffer();
      tokens.push({ kind: "key", value: "Down" });
      index += 3;
      continue;
    }
    if (remaining.startsWith("\u001B[C")) {
      pushBuffer();
      tokens.push({ kind: "key", value: "Right" });
      index += 3;
      continue;
    }
    if (remaining.startsWith("\u001B[D")) {
      pushBuffer();
      tokens.push({ kind: "key", value: "Left" });
      index += 3;
      continue;
    }

    const character = text[index];
    switch (character) {
      case "\u0003":
        pushBuffer();
        tokens.push({ kind: "key", value: "C-c" });
        break;
      case "\u0004":
        pushBuffer();
        tokens.push({ kind: "key", value: "C-d" });
        break;
      case "\u001B":
        pushBuffer();
        tokens.push({ kind: "key", value: "Escape" });
        break;
      case "\t":
        pushBuffer();
        tokens.push({ kind: "key", value: "Tab" });
        break;
      case "\n":
      case "\r":
        pushBuffer();
        tokens.push({ kind: "key", value: "Enter" });
        break;
      default:
        buffer += character;
        break;
    }
    index += 1;
  }

  pushBuffer();
  return tokens;
}

function buildTmuxSessionName(sessionId, sessionName) {
  const base = (sessionName || "terminal")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "terminal";
  return `rimcodex-${base}-${sessionId.slice(0, 8)}`;
}

function readRequiredString(value, errorCode, userMessage) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    throw terminalError(errorCode, userMessage);
  }
  return normalized;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function defaultShellPath(platform) {
  if (platform === "win32") {
    return "powershell.exe";
  }
  return "/bin/zsh";
}

function chunkToString(chunk) {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return String(chunk || "");
}

function isIgnorableTmuxMissingSessionError(error) {
  const stderr = `${error?.stderr || ""}`.toLowerCase();
  const message = `${error?.message || ""}`.toLowerCase();
  return stderr.includes("can't find session") || message.includes("can't find session");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptStringLiteral(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function compactObject(objectValue) {
  return Object.fromEntries(
    Object.entries(objectValue).filter(([, value]) => value != null)
  );
}

function terminalError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

module.exports = {
  createTerminalHandler,
  spawnTerminalProcess,
  tokenizeTerminalInput,
};
