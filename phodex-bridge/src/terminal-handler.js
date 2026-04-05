// FILE: terminal-handler.js
// Purpose: Runs bridge-owned local terminal sessions and streams PTY output back to the iPhone.
// Layer: Bridge handler
// Exports: createTerminalHandler
// Depends on: child_process, crypto, fs, os, path

const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function createTerminalHandler({
  sendNotification,
  spawnImpl = spawn,
  fsModule = fs,
  osModule = os,
  pathModule = path,
  platform = process.platform,
  env = process.env,
} = {}) {
  const sessionsById = new Map();
  const sessionIdByThreadId = new Map();

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
      destroySession(existingSessionId, { notify: false });
    }

    const child = spawnTerminalProcess({
      shellPath,
      workingDirectory,
      spawnImpl,
      platform,
      env,
    });
    const sessionId = randomUUID();
    const session = {
      child,
      sessionId,
      sessionName,
      shellPath,
      threadId,
      workingDirectory,
      isClosing: false,
    };

    sessionsById.set(sessionId, session);
    sessionIdByThreadId.set(threadId, sessionId);
    bindSessionOutput(session);

    return {
      ok: true,
      threadId,
      sessionId,
      sessionName,
      shell: shellPath,
      cwd: workingDirectory,
    };
  }

  async function writeTerminalSession(params) {
    const session = resolveSession(params);
    const text = typeof params?.text === "string" ? params.text : "";
    if (!text) {
      throw terminalError("missing_text", "terminal/write requires non-empty text.");
    }

    if (!session.child?.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) {
      throw terminalError("session_closed", "This terminal session is no longer running.");
    }

    session.child.stdin.write(text);
    return {
      ok: true,
      sessionId: session.sessionId,
      threadId: session.threadId,
    };
  }

  async function closeTerminalSession(params) {
    const session = resolveSession(params);
    destroySession(session.sessionId, { notify: false });
    return {
      ok: true,
      sessionId: session.sessionId,
      threadId: session.threadId,
    };
  }

  function bindSessionOutput(session) {
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
      sendTerminalNotification("terminal/closed", {
        sessionId,
        threadId,
        errorMessage: error.message || "Terminal failed to start.",
      });
      forgetSession(sessionId);
    });

    child.on("close", (exitCode, signal) => {
      const currentSession = sessionsById.get(sessionId);
      if (!currentSession) {
        return;
      }

      forgetSession(sessionId);
      sendTerminalNotification("terminal/closed", {
        sessionId,
        threadId,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === "string" ? signal : null,
      });
    });
  }

  function destroySession(sessionId, { notify = false } = {}) {
    const session = sessionsById.get(sessionId);
    if (!session || session.isClosing) {
      return;
    }

    session.isClosing = true;
    try {
      session.child?.stdin?.end();
    } catch {}

    try {
      session.child?.kill("SIGHUP");
    } catch {}

    if (notify) {
      sendTerminalNotification("terminal/closed", {
        sessionId,
        threadId: session.threadId,
      });
      forgetSession(sessionId);
    }
  }

  function destroyAllSessions() {
    for (const sessionId of [...sessionsById.keys()]) {
      destroySession(sessionId, { notify: false });
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

  return {
    destroyAllSessions,
    handleTerminalRequest,
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

function terminalError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

module.exports = {
  createTerminalHandler,
  spawnTerminalProcess,
};
