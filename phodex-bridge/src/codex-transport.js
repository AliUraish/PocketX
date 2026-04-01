// FILE: codex-transport.js
// Purpose: Abstracts the Codex-side transport so the bridge can talk to either a spawned app-server or an existing WebSocket endpoint.
// Layer: CLI helper
// Exports: createCodexTransport
// Depends on: child_process, ws

const { spawn } = require("child_process");
const MAX_QUEUED_OUTBOUND_MESSAGES = 200;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 15_000;
const DEFAULT_STABLE_UPTIME_MS = 30_000;

function createCodexTransport({
  endpoint = "",
  env = process.env,
  WebSocketImpl = null,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  restartBaseDelayMs = DEFAULT_RESTART_BASE_DELAY_MS,
  restartMaxDelayMs = DEFAULT_RESTART_MAX_DELAY_MS,
  stableUptimeMs = DEFAULT_STABLE_UPTIME_MS,
} = {}) {
  if (endpoint) {
    return createWebSocketTransport({
      endpoint,
      WebSocketImpl: WebSocketImpl || loadDefaultWebSocketImpl(),
    });
  }

  return createSpawnTransport({
    env,
    spawnImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
    restartBaseDelayMs,
    restartMaxDelayMs,
    stableUptimeMs,
  });
}

function createSpawnTransport({
  env,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  restartBaseDelayMs = DEFAULT_RESTART_BASE_DELAY_MS,
  restartMaxDelayMs = DEFAULT_RESTART_MAX_DELAY_MS,
  stableUptimeMs = DEFAULT_STABLE_UPTIME_MS,
}) {
  const launch = createCodexLaunchPlan({ env });
  const listeners = createListenerBag();
  const queuedOutboundMessages = [];
  let currentRuntime = null;
  let restartTimer = null;
  let consecutiveFailureCount = 0;
  let lastError = null;
  let isShuttingDown = false;

  startRuntime({ isRestart: false });

  return {
    mode: "spawn",
    describe() {
      return launch.description;
    },
    send(message) {
      if (!message || isShuttingDown) {
        return;
      }

      if (!canSendToRuntime(currentRuntime)) {
        queuedOutboundMessages.push(message);
        if (queuedOutboundMessages.length > MAX_QUEUED_OUTBOUND_MESSAGES) {
          queuedOutboundMessages.shift();
        }
        return;
      }

      writeToRuntime(currentRuntime, message);
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    onSupervisorEvent(handler) {
      listeners.onSupervisorEvent = handler;
    },
    shutdown() {
      isShuttingDown = true;
      clearScheduledRestart();
      if (!currentRuntime?.process) {
        listeners.emitClose(0, "shutdown");
        return;
      }
      currentRuntime.didRequestShutdown = true;
      shutdownCodexProcess(currentRuntime.process, spawnImpl);
    },
  };

  function startRuntime({ isRestart }) {
    if (isShuttingDown) {
      return;
    }

    clearScheduledRestart();
    listeners.emitSupervisorEvent({
      state: isRestart ? "restarting" : "starting",
      attempt: consecutiveFailureCount,
      lastError: lastError?.message || "",
      nextRetryAt: null,
      restartDelayMs: 0,
      pid: null,
    });

    let codex = null;
    try {
      codex = spawnImpl(launch.command, launch.args, launch.options);
    } catch (error) {
      scheduleRestart(error);
      return;
    }

    currentRuntime = {
      process: codex,
      stdoutBuffer: "",
      stderrBuffer: "",
      didRequestShutdown: false,
      didHandleUnexpectedTermination: false,
      stableTimer: null,
    };

    codex.on("error", (error) => {
      if (!currentRuntime || currentRuntime.process !== codex) {
        return;
      }
      handleUnexpectedTermination(error);
    });

    codex.on("close", (code, signal) => {
      if (!currentRuntime || currentRuntime.process !== codex) {
        return;
      }

      if (currentRuntime.didRequestShutdown) {
        clearRuntimeState();
        listeners.emitClose(code, signal);
        return;
      }

      handleUnexpectedTermination(createCodexCloseError({
        code,
        signal,
        stderrBuffer: currentRuntime.stderrBuffer,
        launchDescription: launch.description,
      }));
    });

    codex.stdin.on("error", (error) => {
      if (!currentRuntime || currentRuntime.process !== codex) {
        return;
      }

      if (currentRuntime.didRequestShutdown && isIgnorableStdinShutdownError(error)) {
        return;
      }

      if (isIgnorableStdinShutdownError(error)) {
        handleUnexpectedTermination(error);
        return;
      }

      handleUnexpectedTermination(error);
    });

    codex.stderr.on("data", (chunk) => {
      if (!currentRuntime || currentRuntime.process !== codex) {
        return;
      }
      currentRuntime.stderrBuffer = appendOutputBuffer(
        currentRuntime.stderrBuffer,
        chunk.toString("utf8")
      );
    });

    codex.stdout.on("data", (chunk) => {
      if (!currentRuntime || currentRuntime.process !== codex) {
        return;
      }

      currentRuntime.stdoutBuffer += chunk.toString("utf8");
      const lines = currentRuntime.stdoutBuffer.split("\n");
      currentRuntime.stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          listeners.emitMessage(trimmedLine);
        }
      }
    });

    if (Number.isFinite(stableUptimeMs) && stableUptimeMs > 0) {
      currentRuntime.stableTimer = setTimeoutImpl(() => {
        if (!currentRuntime || currentRuntime.process !== codex || isShuttingDown) {
          return;
        }
        consecutiveFailureCount = 0;
        listeners.emitSupervisorEvent({
          state: "running",
          attempt: 0,
          lastError: "",
          nextRetryAt: null,
          restartDelayMs: 0,
          pid: codex.pid || null,
        });
      }, stableUptimeMs);
      currentRuntime.stableTimer.unref?.();
    }

    listeners.emitSupervisorEvent({
      state: "running",
      attempt: consecutiveFailureCount,
      lastError: "",
      nextRetryAt: null,
      restartDelayMs: 0,
      pid: codex.pid || null,
    });
    flushQueuedOutboundMessages();
    lastError = null;
  }

  function handleUnexpectedTermination(error) {
    if (!currentRuntime || currentRuntime.didHandleUnexpectedTermination || isShuttingDown) {
      return;
    }

    currentRuntime.didHandleUnexpectedTermination = true;
    clearStableTimer(currentRuntime, clearTimeoutImpl);
    currentRuntime = null;
    scheduleRestart(error);
  }

  function scheduleRestart(error) {
    lastError = error instanceof Error ? error : new Error(String(error || "Codex transport failed."));
    const restartDelayMs = computeRestartDelayMs({
      consecutiveFailureCount,
      restartBaseDelayMs,
      restartMaxDelayMs,
    });
    consecutiveFailureCount += 1;
    const nextRetryAt = Date.now() + restartDelayMs;
    listeners.emitSupervisorEvent({
      state: "backoff",
      attempt: consecutiveFailureCount,
      lastError: lastError.message,
      nextRetryAt,
      restartDelayMs,
      pid: null,
    });
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      startRuntime({ isRestart: true });
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function clearRuntimeState() {
    clearStableTimer(currentRuntime, clearTimeoutImpl);
    currentRuntime = null;
  }

  function clearScheduledRestart() {
    if (!restartTimer) {
      return;
    }
    clearTimeoutImpl(restartTimer);
    restartTimer = null;
  }

  function flushQueuedOutboundMessages() {
    if (!canSendToRuntime(currentRuntime) || queuedOutboundMessages.length === 0) {
      return;
    }

    while (queuedOutboundMessages.length > 0 && canSendToRuntime(currentRuntime)) {
      writeToRuntime(currentRuntime, queuedOutboundMessages.shift());
    }
  }
}

// Builds a single, platform-aware launch path so the bridge never "guesses"
// between multiple commands and accidentally starts duplicate runtimes.
function createCodexLaunchPlan({ env }) {
  const sharedOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env },
  };

  if (process.platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "codex app-server"],
      options: {
        ...sharedOptions,
        windowsHide: true,
      },
      description: "`cmd.exe /d /c codex app-server`",
    };
  }

  return {
    command: "codex",
    args: ["app-server"],
    options: sharedOptions,
    description: "`codex app-server`",
  };
}

// Stops the exact process tree we launched on Windows so the shell wrapper
// does not leave a child Codex process running in the background.
function shutdownCodexProcess(codex, spawnImpl = spawn) {
  if (codex.killed || codex.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && codex.pid) {
    const killer = spawnImpl("taskkill", ["/pid", String(codex.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      codex.kill();
    });
    return;
  }

  codex.kill("SIGTERM");
}

function createCodexCloseError({ code, signal, stderrBuffer, launchDescription }) {
  const details = stderrBuffer.trim();
  const codeLabel = code == null ? "unknown" : code;
  const reason = details || `Process exited with code ${codeLabel}${signal ? ` (signal: ${signal})` : ""}.`;
  return new Error(`Codex launcher ${launchDescription} failed: ${reason}`);
}

function appendOutputBuffer(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  return next.slice(-4_096);
}

function isIgnorableStdinShutdownError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}

function createWebSocketTransport({ endpoint, WebSocketImpl }) {
  const socket = new WebSocketImpl(endpoint);
  const listeners = createListenerBag();
  const openState = WebSocketImpl.OPEN ?? WebSocket.OPEN ?? 1;
  const connectingState = WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING ?? 0;

  socket.on("message", (chunk) => {
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (message.trim()) {
      listeners.emitMessage(message);
    }
  });

  socket.on("close", (code, reason) => {
    const safeReason = reason ? reason.toString("utf8") : "no reason";
    listeners.emitClose(code, safeReason);
  });

  socket.on("error", (error) => listeners.emitError(error));

  return {
    mode: "websocket",
    describe() {
      return endpoint;
    },
    send(message) {
      if (socket.readyState === openState) {
        socket.send(message);
      }
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    shutdown() {
      if (socket.readyState === openState || socket.readyState === connectingState) {
        socket.close();
      }
    },
  };
}

function loadDefaultWebSocketImpl() {
  // Spawn-mode supervision tests should not require the websocket dependency.
  // Only the explicit endpoint-backed transport needs `ws`.
  // eslint-disable-next-line global-require
  return require("ws");
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    onSupervisorEvent: null,
    emitMessage(message) {
      this.onMessage?.(message);
    },
    emitClose(...args) {
      this.onClose?.(...args);
    },
    emitError(error) {
      this.onError?.(error);
    },
    emitSupervisorEvent(event) {
      this.onSupervisorEvent?.(event);
    },
  };
}

function canSendToRuntime(runtime) {
  return Boolean(
    runtime?.process?.stdin
    && runtime.process.stdin.writable
    && !runtime.process.stdin.destroyed
    && !runtime.process.stdin.writableEnded
  );
}

function writeToRuntime(runtime, message) {
  runtime.process.stdin.write(message.endsWith("\n") ? message : `${message}\n`);
}

function clearStableTimer(runtime, clearTimeoutImpl = clearTimeout) {
  if (!runtime?.stableTimer) {
    return;
  }
  clearTimeoutImpl(runtime.stableTimer);
  runtime.stableTimer = null;
}

function computeRestartDelayMs({
  consecutiveFailureCount,
  restartBaseDelayMs = DEFAULT_RESTART_BASE_DELAY_MS,
  restartMaxDelayMs = DEFAULT_RESTART_MAX_DELAY_MS,
}) {
  const safeFailureCount = Math.max(0, Number(consecutiveFailureCount) || 0);
  const safeBaseDelayMs = Math.max(100, Number(restartBaseDelayMs) || DEFAULT_RESTART_BASE_DELAY_MS);
  const safeMaxDelayMs = Math.max(safeBaseDelayMs, Number(restartMaxDelayMs) || DEFAULT_RESTART_MAX_DELAY_MS);
  const exponentialDelay = safeBaseDelayMs * (2 ** safeFailureCount);
  return Math.min(safeMaxDelayMs, exponentialDelay);
}

module.exports = { createCodexTransport };
