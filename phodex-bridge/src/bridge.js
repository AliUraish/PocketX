// FILE: bridge.js
// Purpose: Runs Codex locally, bridges relay traffic, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ws, crypto, os, ./pairing-code, ./codex-desktop-refresher, ./codex-transport, ./rollout-watch, ./voice-handler

const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const { execFile } = require("child_process");
const os = require("os");
const { promisify } = require("util");
const {
  CodexDesktopRefresher,
  readBridgeConfig,
} = require("./codex-desktop-refresher");
const { createCodexTransport } = require("./codex-transport");
const { createThreadRolloutActivityWatcher } = require("./rollout-watch");
const { printPairingCode } = require("./pairing-code");
const { rememberActiveThread } = require("./session-state");
const { handleDesktopRequest } = require("./desktop-handler");
const { handleGitRequest } = require("./git-handler");
const { handleThreadContextRequest } = require("./thread-context-handler");
const { handleWorkspaceRequest } = require("./workspace-handler");
const { createNotificationsHandler } = require("./notifications-handler");
const { createVoiceHandler, resolveVoiceAuth } = require("./voice-handler");
const {
  composeSanitizedAuthStatusFromSettledResults,
} = require("./account-status");
const { createBridgePackageVersionStatusReader } = require("./package-version-status");
const { createPushNotificationServiceClient } = require("./push-notification-service-client");
const { createPushNotificationTracker } = require("./push-notification-tracker");
const { createBridgeApprovalStateStore } = require("./approval-state");
const { createBridgeEventLogStore } = require("./event-log");
const {
  loadOrCreateBridgeDeviceState,
  resolveBridgeRelaySession,
} = require("./secure-device-state");
const { createBridgeSecureTransport } = require("./secure-transport");
const { createRolloutLiveMirrorController } = require("./rollout-live-mirror");
const {
  buildBridgeCapabilities,
  buildBridgeEventEnvelope,
  buildBridgeHealthSnapshot,
  buildBridgeRequestEnvelope,
  extractRequestedBridgeProtocolVersion,
  isBridgeProtocolMethod,
  isBridgeProtocolProxyMethod,
  mapBridgeProtocolMethodToCodexMethod,
  normalizeBridgeEventName,
  normalizeBridgeProtocolResult,
} = require("./bridge-protocol");

const execFileAsync = promisify(execFile);
const RELAY_WATCHDOG_PING_INTERVAL_MS = 10_000;
const RELAY_WATCHDOG_STALE_AFTER_MS = 25_000;
const BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS = 5_000;
const PENDING_BRIDGE_REQUEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_RELAY_STATUS_MESSAGE = "Relay heartbeat stalled; reconnect pending.";
const RELAY_HISTORY_IMAGE_REFERENCE_URL = "rimcodex://history-image-elided";

function startBridge({
  config: explicitConfig = null,
  printPairingCode: shouldPrintPairingCode = true,
  printPairingQr = true,
  onPairingSession = null,
  onPairingPayload = null,
  onBridgeStatus = null,
} = {}) {
  const config = explicitConfig || readBridgeConfig();
  const relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
  if (!relayBaseUrl) {
    console.error("[rimcodex] No relay URL configured.");
    console.error("[rimcodex] In a source checkout, run ./run-local-rimcodex.sh or set RIMCODEX_RELAY.");
    process.exit(1);
  }

  let deviceState;
  try {
    deviceState = loadOrCreateBridgeDeviceState();
  } catch (error) {
    console.error(`[rimcodex] ${(error && error.message) || "Failed to load the saved bridge pairing state."}`);
    process.exit(1);
  }
  const relaySession = resolveBridgeRelaySession(deviceState);
  deviceState = relaySession.deviceState;
  const sessionId = relaySession.sessionId;
  const relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
  const notificationSecret = randomBytes(24).toString("hex");
  const desktopRefresher = new CodexDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.codexBundleId,
    appPath: config.codexAppPath,
  });
  const pushServiceClient = createPushNotificationServiceClient({
    baseUrl: config.pushServiceUrl,
    sessionId,
    notificationSecret,
  });
  const notificationsHandler = createNotificationsHandler({
    pushServiceClient,
  });
  const pushNotificationTracker = createPushNotificationTracker({
    sessionId,
    pushServiceClient,
    previewMaxChars: config.pushPreviewMaxChars,
  });
  const approvalState = createBridgeApprovalStateStore({
    bridgeSessionId: sessionId,
    staleAfterMs: PENDING_BRIDGE_REQUEST_STALE_AFTER_MS,
  });
  const eventLog = createBridgeEventLogStore();
  const readBridgePackageVersionStatus = createBridgePackageVersionStatusReader();

  // Keep the local Codex runtime alive across transient relay disconnects.
  let socket = null;
  let isShuttingDown = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let relayWatchdogTimer = null;
  let statusHeartbeatTimer = null;
  let lastRelayActivityAt = 0;
  let lastPublishedBridgeStatus = null;
  let lastPublishedBridgeHealthSnapshotJSON = "";
  let lastConnectionStatus = null;
  let codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
  let codexSupervisorState = "running";
  let codexSupervisorRestartCount = 0;
  let codexSupervisorNextRetryAt = 0;
  let codexSupervisorLastError = "";
  let requestedBridgeProtocolVersion = 0;
  const forwardedInitializeRequestIds = new Set();
  const bridgeManagedCodexRequestWaiters = new Map();
  const forwardedRequestMethodsById = new Map();
  const relaySanitizedResponseMethodsById = new Map();
  const bridgeProtocolForwardedRequestsById = new Map();
  const pendingBridgeInboundRequestsById = new Map();
  const trackedForwardedRequestMethods = new Set([
    "account/login/start",
    "account/login/cancel",
    "account/logout",
  ]);
  const relaySanitizedRequestMethods = new Set([
    "thread/read",
    "thread/resume",
  ]);
  const forwardedRequestMethodTTLms = 2 * 60_000;
  const pendingAuthLogin = {
    loginId: null,
    authUrl: null,
    requestId: null,
    startedAt: 0,
  };
  const secureTransport = createBridgeSecureTransport({
    sessionId,
    relayUrl: relayBaseUrl,
    deviceState,
    onTrustedPhoneUpdate(nextDeviceState) {
      deviceState = nextDeviceState;
      onPairingSession?.(secureTransport.readPairingSession());
      sendRelayRegistrationUpdate(nextDeviceState);
      appendBridgeEvent({
        type: "pairing.trust_updated",
        level: "info",
        message: "Updated the trusted iPhone for this Mac.",
        detail: "Future reconnects can use the saved trusted device session.",
        metadata: {
          trustedPhoneCount: Object.keys(nextDeviceState?.trustedPhones || {}).length,
        },
      });
    },
  });
  const pairingSession = secureTransport.createPairingSession();
  appendBridgeEvent({
    type: "pairing.session_created",
    level: "info",
    message: "Created a new manual pairing session.",
    detail: "The Mac bridge generated a fresh short-lived pairing code.",
  });
  // Keeps one stable sender identity across reconnects so buffered replay state
  // reflects what actually made it onto the current relay socket.
  function sendRelayWireMessage(wireMessage) {
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(wireMessage);
    return true;
  }
  // Only the spawned local runtime needs rollout mirroring; a real endpoint
  // already provides the authoritative live stream for resumed threads.
  const rolloutLiveMirror = !config.codexEndpoint
    ? createRolloutLiveMirrorController({
      sendApplicationResponse,
    })
    : null;
  let contextUsageWatcher = null;
  let watchedContextUsageKey = null;

  const codex = createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    logPrefix: "[rimcodex]",
  });
  const voiceHandler = createVoiceHandler({
    sendCodexRequest,
    logPrefix: "[rimcodex]",
  });
  startBridgeStatusHeartbeat();
  publishCurrentBridgeStatus({
    connectionStatus: "starting",
    state: "starting",
    lastError: "",
  });

  codex.onError((error) => {
    codexSupervisorState = "error";
    codexSupervisorLastError = error.message;
    codexSupervisorNextRetryAt = 0;
    publishCurrentBridgeStatus({
      connectionStatus: config.codexEndpoint ? "error" : (lastConnectionStatus || "disconnected"),
      state: "error",
      lastError: error.message,
    });
    if (config.codexEndpoint) {
      console.error(`[rimcodex] Failed to connect to Codex endpoint: ${config.codexEndpoint}`);
      console.error(error.message);
      process.exit(1);
      return;
    }

    console.error("[rimcodex] Local `codex app-server` is unavailable.");
    console.error(`[rimcodex] Launch command: ${codex.describe()}`);
    console.error(error.message);
    appendBridgeEvent({
      type: "codex.runtime_error",
      level: "error",
      message: "Local codex app-server is unavailable.",
      detail: error.message,
    });
  });

  codex.onSupervisorEvent?.((event) => {
    codexHandshakeState = "cold";
    codexSupervisorState = event?.state || codexSupervisorState;
    codexSupervisorRestartCount = Number.isFinite(event?.attempt) ? event.attempt : codexSupervisorRestartCount;
    codexSupervisorNextRetryAt = Number.isFinite(event?.nextRetryAt) ? event.nextRetryAt : 0;
    codexSupervisorLastError = readString(event?.lastError);

    if (event?.state === "backoff") {
      handleCodexRuntimeRestart(
        Object.assign(new Error(codexSupervisorLastError || "Local Codex runtime restarting."), {
          errorCode: "codex_runtime_restarting",
          userMessage: codexSupervisorLastError || "Local Codex runtime restarting.",
        })
      );
      publishCurrentBridgeStatus({
        connectionStatus: lastConnectionStatus || "disconnected",
        state: "error",
        lastError: codexSupervisorLastError,
      });
      console.error(
        `[rimcodex] Local \`codex app-server\` exited; retrying in ${Math.max(
          0,
          Number(event?.restartDelayMs) || 0
        )}ms.`
      );
      appendBridgeEvent({
        type: "codex.restart_backoff",
        level: "error",
        message: "Local codex app-server exited unexpectedly.",
        detail: codexSupervisorLastError || "The bridge will retry the local runtime.",
        metadata: {
          restartCount: codexSupervisorRestartCount,
          restartDelayMs: Math.max(0, Number(event?.restartDelayMs) || 0),
        },
      });
      return;
    }

    if (event?.state === "running") {
      codexSupervisorLastError = "";
      codexSupervisorNextRetryAt = 0;
      publishCurrentBridgeStatus({
        connectionStatus: lastConnectionStatus || "starting",
        state: "running",
        lastError: "",
      });
      appendBridgeEvent({
        type: "codex.running",
        level: "info",
        message: codexSupervisorRestartCount > 0
          ? "Recovered the local codex app-server."
          : "Local codex app-server is running.",
        metadata: {
          restartCount: codexSupervisorRestartCount,
        },
      });
      return;
    }

    publishCurrentBridgeStatus({
      connectionStatus: lastConnectionStatus || "starting",
      state: event?.state === "restarting" ? "starting" : undefined,
      lastError: codexSupervisorLastError,
    });
  });

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Periodically rewrites the latest bridge snapshot so CLI status does not stay frozen.
  function startBridgeStatusHeartbeat() {
    if (statusHeartbeatTimer) {
      return;
    }

    statusHeartbeatTimer = setInterval(() => {
      if (!lastPublishedBridgeStatus || isShuttingDown) {
        return;
      }

      onBridgeStatus?.(buildHeartbeatBridgeStatus(lastPublishedBridgeStatus, lastRelayActivityAt));
    }, BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS);
    statusHeartbeatTimer.unref?.();
  }

  function clearBridgeStatusHeartbeat() {
    if (!statusHeartbeatTimer) {
      return;
    }

    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  // Tracks relay liveness locally so sleep/wake zombie sockets can be force-reconnected.
  function markRelayActivity() {
    lastRelayActivityAt = Date.now();
  }

  function clearRelayWatchdog() {
    if (!relayWatchdogTimer) {
      return;
    }

    clearInterval(relayWatchdogTimer);
    relayWatchdogTimer = null;
  }

  function startRelayWatchdog(trackedSocket) {
    clearRelayWatchdog();
    markRelayActivity();

    relayWatchdogTimer = setInterval(() => {
      if (isShuttingDown || socket !== trackedSocket) {
        clearRelayWatchdog();
        return;
      }

      if (trackedSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (hasRelayConnectionGoneStale(lastRelayActivityAt)) {
        console.warn("[rimcodex] relay heartbeat stalled; forcing reconnect");
        appendBridgeEvent({
          type: "relay.heartbeat_stalled",
          level: "warning",
          message: "Relay heartbeat stalled; forcing reconnect.",
          detail: "The bridge stopped seeing relay traffic and is resetting the socket.",
        });
        logConnectionStatus("disconnected");
        trackedSocket.terminate();
        return;
      }

      try {
        trackedSocket.ping();
      } catch {
        trackedSocket.terminate();
      }
    }, RELAY_WATCHDOG_PING_INTERVAL_MS);
    relayWatchdogTimer.unref?.();
  }

  // Keeps npm start output compact by emitting only high-signal connection states.
  function logConnectionStatus(status) {
    if (lastConnectionStatus === status) {
      return;
    }

    const previousStatus = lastConnectionStatus;
    lastConnectionStatus = status;
    publishCurrentBridgeStatus({ connectionStatus: status });
    appendBridgeEvent({
      type: "relay.connection_status_changed",
      level: status === "connected" ? "info" : "warning",
      message: status === "connected"
        ? "Relay connection restored."
        : `Relay connection is now ${status}.`,
      detail: previousStatus && previousStatus !== status
        ? `Previous status: ${previousStatus}.`
        : null,
      metadata: {
        connectionStatus: status,
      },
    });
    console.log(`[rimcodex] ${status}`);
  }

  // Retries the relay socket while preserving the active Codex process and session id.
  function scheduleRelayReconnect(closeCode) {
    if (isShuttingDown) {
      return;
    }

    if (closeCode === 4000 || closeCode === 4001) {
      logConnectionStatus("disconnected");
      shutdown(codex, () => socket, () => {
        isShuttingDown = true;
        clearReconnectTimer();
        clearRelayWatchdog();
        clearBridgeStatusHeartbeat();
      });
      return;
    }

    if (reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = Math.min(1_000 * reconnectAttempt, 5_000);
    logConnectionStatus("connecting");
    appendBridgeEvent({
      type: "relay.reconnect_scheduled",
      level: "warning",
      message: "Scheduled a relay reconnect attempt.",
      detail: `Retry attempt ${reconnectAttempt} in ${delayMs}ms.`,
      metadata: {
        attempt: reconnectAttempt,
        delayMs,
        closeCode: Number.isFinite(closeCode) ? closeCode : null,
      },
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay();
    }, delayMs);
  }

  function connectRelay() {
    if (isShuttingDown) {
      return;
    }

    logConnectionStatus("connecting");
    appendBridgeEvent({
      type: "relay.connecting",
      level: "info",
      message: "Connecting to the relay.",
    });
    const nextSocket = new WebSocket(relaySessionUrl, {
      // The relay uses this per-session secret to authenticate the first push registration.
      headers: {
        "x-role": "mac",
        "x-notification-secret": notificationSecret,
        ...buildMacRegistrationHeaders(deviceState),
      },
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      markRelayActivity();
      clearReconnectTimer();
      reconnectAttempt = 0;
      requestedBridgeProtocolVersion = 0;
      lastPublishedBridgeHealthSnapshotJSON = "";
      startRelayWatchdog(nextSocket);
      logConnectionStatus("connected");
      appendBridgeEvent({
        type: "relay.connected",
        level: "info",
        message: "Connected to the relay.",
      });
      secureTransport.bindLiveSendWireMessage(sendRelayWireMessage);
      sendRelayRegistrationUpdate(deviceState);
    });

    nextSocket.on("message", (data) => {
      markRelayActivity();
      const message = typeof data === "string" ? data : data.toString("utf8");
      if (secureTransport.handleIncomingWireMessage(message, {
        sendControlMessage(controlMessage) {
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.send(JSON.stringify(controlMessage));
          }
        },
        onApplicationMessage(plaintextMessage) {
          handleApplicationMessage(plaintextMessage);
        },
      })) {
        return;
      }
    });

    nextSocket.on("ping", () => {
      markRelayActivity();
    });

    nextSocket.on("pong", () => {
      markRelayActivity();
    });

    nextSocket.on("close", (code) => {
      if (socket === nextSocket) {
        clearRelayWatchdog();
      }
      logConnectionStatus("disconnected");
      appendBridgeEvent({
        type: "relay.closed",
        level: code === 1000 ? "info" : "warning",
        message: "Relay socket closed.",
        detail: Number.isFinite(code) ? `Close code: ${code}.` : null,
        metadata: {
          closeCode: Number.isFinite(code) ? code : null,
        },
      });
      if (socket === nextSocket) {
        socket = null;
      }
      stopContextUsageWatcher();
      rolloutLiveMirror?.stopAll();
      desktopRefresher.handleTransportReset();
      scheduleRelayReconnect(code);
    });

    nextSocket.on("error", () => {
      if (socket === nextSocket) {
        clearRelayWatchdog();
      }
      appendBridgeEvent({
        type: "relay.error",
        level: "error",
        message: "Relay socket error.",
      });
      logConnectionStatus("disconnected");
    });
  }

  onPairingSession?.(pairingSession);
  onPairingPayload?.(pairingSession.pairingPayload);
  if (shouldPrintPairingCode || printPairingQr) {
    printPairingCode(pairingSession);
  }
  pushServiceClient.logUnavailable();
  appendBridgeEvent({
    type: "bridge.started",
    level: "info",
    message: "Started the rimcodex bridge.",
    detail: config.codexEndpoint
      ? "Using an existing Codex endpoint."
      : "Using a supervised local codex app-server.",
  });
  connectRelay();

  codex.onMessage((message) => {
    if (handleBridgeManagedCodexResponse(message)) {
      return;
    }
    updatePendingAuthLoginFromCodexMessage(message);
    trackCodexHandshakeState(message);
    desktopRefresher.handleOutbound(message);
    pushNotificationTracker.handleOutbound(message);
    rememberThreadFromMessage("codex", message);
    secureTransport.queueOutboundApplicationMessage(
      createRelayBoundCodexMessage(message),
      sendRelayWireMessage
    );
  });

  codex.onClose(() => {
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
    logConnectionStatus("disconnected");
    publishCurrentBridgeStatus({
      connectionStatus: "disconnected",
      state: "stopped",
      lastError: "",
    });
    isShuttingDown = true;
    clearReconnectTimer();
    stopContextUsageWatcher();
    rolloutLiveMirror?.stopAll();
    desktopRefresher.handleTransportReset();
    failBridgeManagedCodexRequests(new Error("Codex transport closed before the bridge request completed."));
    forwardedRequestMethodsById.clear();
    bridgeProtocolForwardedRequestsById.clear();
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });

  process.on("SIGINT", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    clearReconnectTimer();
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
  }));
  process.on("SIGTERM", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    clearReconnectTimer();
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
  }));

  // Routes decrypted app payloads through the same bridge handlers as before.
  function handleApplicationMessage(rawMessage) {
    if (handleBridgeManagedHandshakeMessage(rawMessage)) {
      return;
    }
    if (handleBridgeProtocolRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleBridgeManagedAccountRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (voiceHandler.handleVoiceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleThreadContextRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (notificationsHandler.handleNotificationsRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleDesktopRequest(rawMessage, sendApplicationResponse, {
      bundleId: config.codexBundleId,
      appPath: config.codexAppPath,
    })) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    forgetResolvedBridgeInboundRequest(rawMessage);
    desktopRefresher.handleInbound(rawMessage);
    rolloutLiveMirror?.observeInbound(rawMessage);
    rememberForwardedRequestMethod(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
    codex.send(rawMessage);
  }

  // Encrypts bridge-generated responses instead of letting the relay see plaintext.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(rawMessage, sendRelayWireMessage);
  }

  function handleBridgeProtocolRequest(rawMessage, sendResponse) {
    const parsed = safeParseJSON(rawMessage);
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    const requestId = parsed?.id;
    if (!method || requestId == null || !isBridgeProtocolMethod(method)) {
      return false;
    }

    if (method === "bridge/capabilities") {
      readBridgePackageVersionStatus()
        .then((packageVersionStatus) => {
          sendResponse(JSON.stringify({
            id: requestId,
            result: buildBridgeCapabilities({ packageVersionStatus }),
          }));
        })
        .catch((error) => {
          sendResponse(createJsonRpcErrorResponse(requestId, error, "bridge_capabilities_failed"));
        });
      return true;
    }

    if (method === "bridge/health") {
      readBridgePackageVersionStatus()
        .then((packageVersionStatus) => {
          sendResponse(JSON.stringify({
            id: requestId,
            result: buildBridgeHealthSnapshot({
              bridgeStatus: lastPublishedBridgeStatus,
              codexHandshakeState,
              pairingSession: secureTransport.readPairingSession(),
              packageVersionStatus,
              pendingApprovalCount: countPendingBridgeApprovals(),
              lastRelayActivityAt,
              relayHeartbeatStaleAfterMs: RELAY_WATCHDOG_STALE_AFTER_MS,
            }),
          }));
        })
        .catch((error) => {
          sendResponse(createJsonRpcErrorResponse(requestId, error, "bridge_health_failed"));
        });
      return true;
    }

    if (method === "bridge/diagnostics/read") {
      const paramsObject = safeBridgeParamsObject(parsed?.params);
      const limit = Number(paramsObject?.limit) || Number(paramsObject?.maxEvents) || 50;
      sendResponse(JSON.stringify({
        id: requestId,
        result: {
          events: eventLog.listRecentEvents(limit),
        },
      }));
      return true;
    }

    if (method === "bridge/approval/list") {
      sendResponse(JSON.stringify({
        id: requestId,
        result: {
          approvals: listPendingBridgeApprovals(),
        },
      }));
      return true;
    }

    if (method === "bridge/approval/resolve") {
      resolvePendingBridgeApproval(parsed?.params)
        .then((result) => {
          sendResponse(JSON.stringify({
            id: requestId,
            result,
          }));
        })
        .catch((error) => {
          sendResponse(createJsonRpcErrorResponse(requestId, error, "bridge_approval_resolve_failed"));
        });
      return true;
    }

    if (!isBridgeProtocolProxyMethod(method)) {
      return false;
    }

    const codexMethod = mapBridgeProtocolMethodToCodexMethod(method);
    if (!codexMethod) {
      sendResponse(createJsonRpcErrorResponse(
        requestId,
        Object.assign(new Error(`Unsupported bridge method: ${method}`), {
          errorCode: "unsupported_bridge_method",
        }),
        "unsupported_bridge_method"
      ));
      return true;
    }

    const forwardedMessage = JSON.stringify({
      ...parsed,
      method: codexMethod,
    });

    rememberForwardedBridgeProtocolRequest(requestId, method, codexMethod);
    desktopRefresher.handleInbound(forwardedMessage);
    rolloutLiveMirror?.observeInbound(forwardedMessage);
    rememberThreadFromMessage("phone", forwardedMessage);

    try {
      codex.send(forwardedMessage);
    } catch (error) {
      bridgeProtocolForwardedRequestsById.delete(String(requestId));
      sendResponse(createJsonRpcErrorResponse(requestId, error, "bridge_proxy_forward_failed"));
    }

    return true;
  }

  // ─── Bridge-owned auth snapshot ─────────────────────────────

  // Handles the bridge-owned auth status wrappers without exposing tokens to the phone.
  // This dispatcher stays synchronous so non-account messages can continue down the normal routing chain.
  function handleBridgeManagedAccountRequest(rawMessage, sendResponse) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method !== "account/status/read"
      && method !== "getAuthStatus"
      && method !== "account/login/openOnMac"
      && method !== "voice/resolveAuth") {
      return false;
    }

    const requestId = parsed.id;
    const shouldRespond = requestId != null;
    readBridgeManagedAccountResult(method, parsed.params || {})
      .then((result) => {
        if (shouldRespond) {
          sendResponse(JSON.stringify({ id: requestId, result }));
        }
      })
      .catch((error) => {
        if (shouldRespond) {
          sendResponse(createJsonRpcErrorResponse(requestId, error, "auth_status_failed"));
        }
      });

    return true;
  }

  // Resolves bridge-owned account helpers like status reads and Mac-side browser opening.
  async function readBridgeManagedAccountResult(method, params) {
    switch (method) {
      case "account/status/read":
      case "getAuthStatus":
        return readSanitizedAuthStatus();
      case "account/login/openOnMac":
        return openPendingAuthLoginOnMac(params);
      case "voice/resolveAuth":
        return resolveVoiceAuth(sendCodexRequest);
      default:
        throw new Error(`Unsupported bridge-managed account method: ${method}`);
    }
  }

  // Combines account/read + getAuthStatus into one safe snapshot for the phone UI.
  // The two RPCs are settled independently so one transient failure does not hide the other.
  async function readSanitizedAuthStatus() {
    const [accountReadResult, authStatusResult, bridgeVersionInfoResult] = await Promise.allSettled([
      sendCodexRequest("account/read", {
        refreshToken: false,
      }),
      sendCodexRequest("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      }),
      readBridgePackageVersionStatus(),
    ]);

    return composeSanitizedAuthStatusFromSettledResults({
      accountReadResult: accountReadResult.status === "fulfilled"
        ? {
          status: "fulfilled",
          value: normalizeAccountRead(accountReadResult.value),
        }
        : accountReadResult,
      authStatusResult,
      loginInFlight: Boolean(pendingAuthLogin.loginId),
      bridgeVersionInfo: bridgeVersionInfoResult.status === "fulfilled"
        ? bridgeVersionInfoResult.value
        : null,
    });
  }

  // Opens the ChatGPT sign-in URL in the default browser on the bridge Mac.
  async function openPendingAuthLoginOnMac(params) {
    if (process.platform !== "darwin") {
      const error = new Error("Opening ChatGPT sign-in on the bridge is only supported on macOS.");
      error.errorCode = "unsupported_platform";
      throw error;
    }

    const authUrl = readString(params?.authUrl) || pendingAuthLogin.authUrl;
    if (!authUrl) {
      const error = new Error("No pending ChatGPT sign-in URL is available on this bridge.");
      error.errorCode = "missing_auth_url";
      throw error;
    }

    await execFileAsync("open", [authUrl], { timeout: 15_000 });
    return {
      success: true,
      openedOnMac: true,
    };
  }

  function normalizeAccountRead(payload) {
    if (!payload || typeof payload !== "object") {
      return {
        account: null,
        requiresOpenaiAuth: true,
      };
    }

    return {
      account: payload.account && typeof payload.account === "object" ? payload.account : null,
      requiresOpenaiAuth: Boolean(payload.requiresOpenaiAuth),
    };
  }

  function createJsonRpcErrorResponse(requestId, error, defaultErrorCode) {
    return JSON.stringify({
      id: requestId,
      error: {
        code: -32000,
        message: error?.userMessage || error?.message || "Bridge request failed.",
        data: {
          errorCode: error?.errorCode || defaultErrorCode,
        },
      },
    });
  }

  function rememberForwardedRequestMethod(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    const requestId = parsed?.id;
    if (!method || requestId == null) {
      return;
    }

    pruneExpiredForwardedRequestMethods();
    if (trackedForwardedRequestMethods.has(method)) {
      forwardedRequestMethodsById.set(String(requestId), {
        method,
        createdAt: Date.now(),
      });
    }
    if (relaySanitizedRequestMethods.has(method)) {
      relaySanitizedResponseMethodsById.set(String(requestId), {
        method,
        createdAt: Date.now(),
      });
    }
  }

  // Replaces huge inline desktop-history images with lightweight references before relay encryption.
  function sanitizeRelayBoundCodexMessage(rawMessage) {
    pruneExpiredForwardedRequestMethods();
    const parsed = safeParseJSON(rawMessage);
    const responseId = parsed?.id;
    if (responseId == null) {
      return rawMessage;
    }

    const trackedRequest = relaySanitizedResponseMethodsById.get(String(responseId));
    if (!trackedRequest) {
      return rawMessage;
    }
    relaySanitizedResponseMethodsById.delete(String(responseId));

    return sanitizeThreadHistoryImagesForRelay(rawMessage, trackedRequest.method);
  }

  function updatePendingAuthLoginFromCodexMessage(rawMessage) {
    pruneExpiredForwardedRequestMethods();
    const parsed = safeParseJSON(rawMessage);
    const responseId = parsed?.id;
    if (responseId != null) {
      const trackedRequest = forwardedRequestMethodsById.get(String(responseId));
      if (trackedRequest) {
        forwardedRequestMethodsById.delete(String(responseId));
        const requestMethod = trackedRequest.method;

        if (requestMethod === "account/login/start") {
          const loginId = readString(parsed?.result?.loginId);
          const authUrl = readString(parsed?.result?.authUrl);
          if (!loginId || !authUrl) {
            clearPendingAuthLogin();
            return;
          }
          pendingAuthLogin.loginId = loginId || null;
          pendingAuthLogin.authUrl = authUrl || null;
          pendingAuthLogin.requestId = String(responseId);
          pendingAuthLogin.startedAt = Date.now();
          return;
        }

        if (requestMethod === "account/login/cancel" || requestMethod === "account/logout") {
          clearPendingAuthLogin();
          return;
        }
      }
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method === "account/login/completed") {
      clearPendingAuthLogin();
      return;
    }

    if (method === "account/updated") {
      clearPendingAuthLogin();
    }
  }

  function clearPendingAuthLogin() {
    pendingAuthLogin.loginId = null;
    pendingAuthLogin.authUrl = null;
    pendingAuthLogin.requestId = null;
    pendingAuthLogin.startedAt = 0;
  }

  function pruneExpiredForwardedRequestMethods(now = Date.now()) {
    for (const [requestId, trackedRequest] of forwardedRequestMethodsById.entries()) {
      if (!trackedRequest || (now - trackedRequest.createdAt) >= forwardedRequestMethodTTLms) {
        forwardedRequestMethodsById.delete(requestId);
      }
    }
    for (const [requestId, trackedRequest] of relaySanitizedResponseMethodsById.entries()) {
      if (!trackedRequest || (now - trackedRequest.createdAt) >= forwardedRequestMethodTTLms) {
        relaySanitizedResponseMethodsById.delete(requestId);
      }
    }
  }

  function safeParseJSON(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function safeBridgeParamsObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (!context.threadId) {
      return;
    }

    rememberActiveThread(context.threadId, source);
    if (shouldStartContextUsageWatcher(context)) {
      ensureContextUsageWatcher(context);
    }
  }

  // Mirrors CodexMonitor's persisted token_count fallback so the phone keeps
  // receiving context-window usage even when the runtime omits live thread usage.
  function ensureContextUsageWatcher({ threadId, turnId }) {
    const normalizedThreadId = readString(threadId);
    const normalizedTurnId = readString(turnId);
    if (!normalizedThreadId) {
      return;
    }

    const nextWatcherKey = `${normalizedThreadId}|${normalizedTurnId || "pending-turn"}`;
    if (watchedContextUsageKey === nextWatcherKey && contextUsageWatcher) {
      return;
    }

    stopContextUsageWatcher();
    watchedContextUsageKey = nextWatcherKey;
    contextUsageWatcher = createThreadRolloutActivityWatcher({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      onUsage: ({ threadId: usageThreadId, usage }) => {
        sendContextUsageNotification(usageThreadId, usage);
      },
      onIdle: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onTimeout: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onError: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
    });
  }

  function stopContextUsageWatcher() {
    if (contextUsageWatcher) {
      contextUsageWatcher.stop();
    }

    contextUsageWatcher = null;
    watchedContextUsageKey = null;
  }

  function sendContextUsageNotification(threadId, usage) {
    if (!threadId || !usage) {
      return;
    }

    sendApplicationResponse(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        usage,
      },
    }));
  }

  // The spawned/shared Codex app-server stays warm across phone reconnects.
  // When iPhone reconnects it sends initialize again, but forwarding that to the
  // already-initialized Codex transport only produces "Already initialized".
  function handleBridgeManagedHandshakeMessage(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      const requestedProtocolVersion = extractRequestedBridgeProtocolVersion(parsed.params);
      if (requestedProtocolVersion > 0) {
        requestedBridgeProtocolVersion = requestedProtocolVersion;
      }

      if (codexHandshakeState !== "warm") {
        forwardedInitializeRequestIds.add(String(parsed.id));
        return false;
      }

      sendApplicationResponse(JSON.stringify({
        id: parsed.id,
        result: {
          bridgeManaged: true,
          bridgeProtocolVersion: requestedBridgeProtocolVersion || null,
        },
      }));
      return true;
    }

    if (method === "initialized") {
      return codexHandshakeState === "warm";
    }

    return false;
  }

  // Learns whether the underlying Codex transport has already completed its own MCP handshake.
  function trackCodexHandshakeState(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) {
      return;
    }

    const responseKey = String(responseId);
    if (!forwardedInitializeRequestIds.has(responseKey)) {
      return;
    }

    forwardedInitializeRequestIds.delete(responseKey);

    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      publishBridgeHealthSnapshotIfNeeded();
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      codexHandshakeState = "warm";
      publishBridgeHealthSnapshotIfNeeded();
    }
  }

  // Runs bridge-private JSON-RPC calls against the local app-server so token-bearing responses
  // can power bridge features like transcription without ever reaching the phone.
  function sendCodexRequest(method, params) {
    const requestId = `bridge-managed-${randomBytes(12).toString("hex")}`;
    const payload = JSON.stringify({
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bridgeManagedCodexRequestWaiters.delete(requestId);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 20_000);

      bridgeManagedCodexRequestWaiters.set(requestId, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        codex.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        bridgeManagedCodexRequestWaiters.delete(requestId);
        reject(error);
      }
    });
  }

  // Intercepts responses for bridge-private requests so only user-visible app-server traffic
  // is forwarded back through secure transport.
  function handleBridgeManagedCodexResponse(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const responseId = typeof parsed?.id === "string" ? parsed.id : null;
    if (!responseId) {
      return false;
    }

    const waiter = bridgeManagedCodexRequestWaiters.get(responseId);
    if (!waiter) {
      return false;
    }

    bridgeManagedCodexRequestWaiters.delete(responseId);
    clearTimeout(waiter.timeout);

    if (parsed.error) {
      const error = new Error(parsed.error.message || `Codex request failed: ${waiter.method}`);
      error.code = parsed.error.code;
      error.data = parsed.error.data;
      waiter.reject(error);
      return true;
    }

    waiter.resolve(parsed.result ?? null);
    return true;
  }

  function failBridgeManagedCodexRequests(error) {
    for (const waiter of bridgeManagedCodexRequestWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    bridgeManagedCodexRequestWaiters.clear();
  }

  function failPendingForwardedCodexRequests(error) {
    for (const requestId of forwardedRequestMethodsById.keys()) {
      sendApplicationResponse(
        createJsonRpcErrorResponse(requestId, error, "codex_runtime_restarting")
      );
    }
    forwardedRequestMethodsById.clear();

    for (const requestId of bridgeProtocolForwardedRequestsById.keys()) {
      sendApplicationResponse(
        createJsonRpcErrorResponse(requestId, error, "codex_runtime_restarting")
      );
    }
    bridgeProtocolForwardedRequestsById.clear();
  }

  function handleCodexRuntimeRestart(error) {
    stopContextUsageWatcher();
    rolloutLiveMirror?.stopAll();
    desktopRefresher.handleTransportReset();
    failBridgeManagedCodexRequests(error);
    failPendingForwardedCodexRequests(error);
    relaySanitizedResponseMethodsById.clear();
    forwardedInitializeRequestIds.clear();
    pendingAuthLogin.loginId = null;
    pendingAuthLogin.authUrl = null;
    pendingAuthLogin.requestId = null;
    pendingAuthLogin.startedAt = 0;
    pendingBridgeInboundRequestsById.clear();
    approvalState.clearPendingApprovals("codex_runtime_restarted");
    appendBridgeEvent({
      type: "codex.runtime_restarted",
      level: "warning",
      message: "Reset bridge-managed runtime state after a Codex restart.",
      detail: error?.message || null,
    });
    publishBridgeHealthSnapshotIfNeeded();
  }

  function resolveBridgeRuntimeState(explicitState = "") {
    const normalizedExplicitState = readString(explicitState);
    if (normalizedExplicitState) {
      return normalizedExplicitState;
    }

    if (codexSupervisorState === "backoff" || codexSupervisorState === "error") {
      return "error";
    }
    if (codexSupervisorState === "starting" || codexSupervisorState === "restarting") {
      return "starting";
    }
    return "running";
  }

  function publishCurrentBridgeStatus({
    connectionStatus = lastConnectionStatus || "starting",
    state = "",
    lastError = null,
  } = {}) {
    publishBridgeStatus({
      state: resolveBridgeRuntimeState(state),
      connectionStatus,
      pid: process.pid,
      lastError: lastError != null
        ? lastError
        : (codexSupervisorLastError || ""),
      codexSupervisorState,
      codexRestartCount: codexSupervisorRestartCount,
      codexNextRetryAt: codexSupervisorNextRetryAt || null,
    });
  }

  function publishBridgeStatus(status) {
    lastPublishedBridgeStatus = status;
    onBridgeStatus?.(status);
    publishBridgeHealthSnapshotIfNeeded();
  }

  function appendBridgeEvent(event) {
    try {
      eventLog.append(event);
    } catch {
      // Best-effort only; diagnostics should never block the bridge.
    }
  }

  // Refreshes the relay's trusted-mac index after the pairing bootstrap locks in a phone identity.
  function sendRelayRegistrationUpdate(nextDeviceState) {
    deviceState = nextDeviceState;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      kind: "relayMacRegistration",
      registration: buildMacRegistration(nextDeviceState),
      pairingSession: buildRelayPairingSession(secureTransport.readPairingSession()),
    }));
  }

  function createRelayBoundCodexMessage(rawMessage) {
    const bridgeProtocolRelayMessage = buildBridgeProtocolRelayMessage(rawMessage);
    if (bridgeProtocolRelayMessage) {
      return bridgeProtocolRelayMessage;
    }

    return sanitizeRelayBoundCodexMessage(rawMessage);
  }

  function buildBridgeProtocolRelayMessage(rawMessage) {
    pruneExpiredBridgeProtocolState();
    const parsed = safeParseJSON(rawMessage);
    if (!parsed) {
      return null;
    }

    const responseId = parsed?.id != null ? String(parsed.id) : null;
    if (responseId) {
      const trackedRequest = bridgeProtocolForwardedRequestsById.get(responseId);
      if (trackedRequest) {
        bridgeProtocolForwardedRequestsById.delete(responseId);
        const sanitizedRawMessage = sanitizeThreadHistoryImagesForRelay(rawMessage, trackedRequest.codexMethod);
        const sanitizedParsed = safeParseJSON(sanitizedRawMessage) || parsed;

        if (sanitizedParsed.error) {
          return JSON.stringify({
            id: sanitizedParsed.id,
            error: sanitizedParsed.error,
          });
        }

        return JSON.stringify({
          id: sanitizedParsed.id,
          result: normalizeBridgeProtocolResult(trackedRequest.bridgeMethod, sanitizedParsed.result ?? null),
        });
      }
    }

    if (!requestedBridgeProtocolVersion || typeof parsed?.method !== "string") {
      return null;
    }

    const rawMethod = parsed.method.trim();
    if (!rawMethod) {
      return null;
    }

    if (parsed.id != null) {
      rememberPendingBridgeInboundRequest(parsed.id, rawMethod, parsed.params);
      return JSON.stringify(buildBridgeRequestEnvelope(parsed.id, rawMethod, parsed.params ?? null));
    }

    return JSON.stringify(buildBridgeEventEnvelope(rawMethod, parsed.params ?? null));
  }

  function rememberForwardedBridgeProtocolRequest(requestId, bridgeMethod, codexMethod) {
    pruneExpiredBridgeProtocolState();
    bridgeProtocolForwardedRequestsById.set(String(requestId), {
      bridgeMethod,
      codexMethod,
      createdAt: Date.now(),
    });
  }

  function rememberPendingBridgeInboundRequest(requestId, method, params) {
    pruneExpiredBridgeProtocolState();
    const trackedRequest = {
      requestId: String(requestId),
      method,
      params: safeBridgeParamsObject(params),
      threadId: extractThreadId(method, params),
      turnId: extractTurnId(method, params),
      createdAt: Date.now(),
    };
    pendingBridgeInboundRequestsById.set(String(requestId), trackedRequest);
    if (isBridgeApprovalMethod(method)) {
      approvalState.rememberPendingApproval({
        ...trackedRequest,
        command: readString(trackedRequest.params?.command),
        reason: readString(trackedRequest.params?.reason),
      });
      appendBridgeEvent({
        type: "approval.requested",
        level: "warning",
        message: "A run is waiting for approval.",
        detail: readString(trackedRequest.params?.reason) || null,
        metadata: {
          threadId: trackedRequest.threadId || null,
          turnId: trackedRequest.turnId || null,
        },
      });
    }
    publishBridgeHealthSnapshotIfNeeded();
  }

  function forgetResolvedBridgeInboundRequest(rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed || parsed.method != null || parsed.id == null) {
      return;
    }

    const requestId = String(parsed.id);
    const pendingRequest = pendingBridgeInboundRequestsById.get(requestId);
    pendingBridgeInboundRequestsById.delete(requestId);
    if (pendingRequest && isBridgeApprovalMethod(pendingRequest.method)) {
      approvalState.resolvePendingApproval(requestId, parsed.result, {
        outcome: parsed.error ? "response_error_forwarded" : "response_forwarded",
      });
      appendBridgeEvent({
        type: "approval.resolved",
        level: parsed.error ? "warning" : "info",
        message: "Resolved a pending approval.",
        detail: parsed.error ? "The approval completed with an error response." : null,
        metadata: {
          threadId: pendingRequest.threadId || null,
          turnId: pendingRequest.turnId || null,
        },
      });
      publishBridgeHealthSnapshotIfNeeded();
    }
  }

  function pruneExpiredBridgeProtocolState(now = Date.now()) {
    for (const [requestId, trackedRequest] of bridgeProtocolForwardedRequestsById.entries()) {
      if (!trackedRequest || (now - trackedRequest.createdAt) >= forwardedRequestMethodTTLms) {
        bridgeProtocolForwardedRequestsById.delete(requestId);
      }
    }

    for (const [requestId, trackedRequest] of pendingBridgeInboundRequestsById.entries()) {
      if (!trackedRequest || (now - trackedRequest.createdAt) >= PENDING_BRIDGE_REQUEST_STALE_AFTER_MS) {
        pendingBridgeInboundRequestsById.delete(requestId);
        if (trackedRequest && isBridgeApprovalMethod(trackedRequest.method)) {
          approvalState.expirePendingApproval(requestId, "stale_timeout");
          appendBridgeEvent({
            type: "approval.expired",
            level: "warning",
            message: "Expired a stale pending approval.",
            metadata: {
              threadId: trackedRequest.threadId || null,
              turnId: trackedRequest.turnId || null,
            },
          });
        }
      }
    }
  }

  function listPendingBridgeApprovals() {
    pruneExpiredBridgeProtocolState();
    return Array.from(pendingBridgeInboundRequestsById.values())
      .filter((entry) => isBridgeApprovalMethod(entry?.method))
      .map((entry) => ({
        requestId: entry.requestId,
        method: entry.method,
        event: normalizeBridgeEventName(entry.method),
        threadId: entry.threadId || null,
        turnId: entry.turnId || null,
        command: readString(entry.params?.command),
        reason: readString(entry.params?.reason),
        requestedAt: entry.createdAt,
        params: entry.params || null,
      }));
  }

  function countPendingBridgeApprovals() {
    return listPendingBridgeApprovals().length;
  }

  async function resolvePendingBridgeApproval(params) {
    const paramsObject = safeBridgeParamsObject(params);
    const requestId = readString(paramsObject?.requestId)
      || readString(paramsObject?.requestID)
      || readString(paramsObject?.id);
    if (!requestId) {
      const error = new Error("bridge/approval/resolve requires requestId.");
      error.errorCode = "missing_request_id";
      throw error;
    }

    const pendingRequest = pendingBridgeInboundRequestsById.get(requestId);
    if (!pendingRequest) {
      const error = new Error("That approval request is no longer pending.");
      error.errorCode = "approval_not_found";
      throw error;
    }

    const explicitResult = safeBridgeParamsObject(paramsObject?.result);
    const decision = readString(paramsObject?.decision);
    let result = explicitResult;
    if (!result) {
      if (!decision) {
        const error = new Error("bridge/approval/resolve requires either result or decision.");
        error.errorCode = "missing_decision";
        throw error;
      }
      result = {
        decision,
      };
    }

    codex.send(JSON.stringify({
      id: pendingRequest.requestId,
      result,
    }));
    pendingBridgeInboundRequestsById.delete(requestId);
    approvalState.resolvePendingApproval(requestId, result, {
      outcome: "resolved_from_phone",
    });
    appendBridgeEvent({
      type: "approval.resolved",
      level: "info",
      message: "Resolved a pending approval from iPhone.",
      metadata: {
        threadId: pendingRequest.threadId || null,
        turnId: pendingRequest.turnId || null,
      },
    });
    publishBridgeHealthSnapshotIfNeeded();

    return {
      ok: true,
      requestId,
      resolved: true,
    };
  }

  function publishBridgeHealthSnapshotIfNeeded() {
    if (!requestedBridgeProtocolVersion) {
      return;
    }

    readBridgePackageVersionStatus()
      .then((packageVersionStatus) => {
        const healthSnapshot = buildBridgeHealthSnapshot({
          bridgeStatus: lastPublishedBridgeStatus,
          codexHandshakeState,
          pairingSession: secureTransport.readPairingSession(),
          packageVersionStatus,
          pendingApprovalCount: countPendingBridgeApprovals(),
          lastRelayActivityAt,
          relayHeartbeatStaleAfterMs: RELAY_WATCHDOG_STALE_AFTER_MS,
        });
        const serializedSnapshot = JSON.stringify(healthSnapshot);
        if (!serializedSnapshot || serializedSnapshot === lastPublishedBridgeHealthSnapshotJSON) {
          return;
        }

        lastPublishedBridgeHealthSnapshotJSON = serializedSnapshot;
        sendApplicationResponse(JSON.stringify({
          method: "bridge/healthChanged",
          params: healthSnapshot,
        }));
      })
      .catch(() => {
        // Best-effort only; `bridge/health` remains available for explicit reads.
      });
  }
}

// Registers the canonical Mac identity and the one trusted iPhone allowed for auto-resolve.
function buildMacRegistrationHeaders(deviceState) {
  const registration = buildMacRegistration(deviceState);
  const headers = {
    "x-mac-device-id": registration.macDeviceId,
    "x-mac-identity-public-key": registration.macIdentityPublicKey,
    "x-machine-name": registration.displayName,
  };
  if (registration.trustedPhoneDeviceId && registration.trustedPhonePublicKey) {
    headers["x-trusted-phone-device-id"] = registration.trustedPhoneDeviceId;
    headers["x-trusted-phone-public-key"] = registration.trustedPhonePublicKey;
  }
  return headers;
}

function buildMacRegistration(deviceState) {
  const trustedPhoneEntry = Object.entries(deviceState?.trustedPhones || {})[0] || null;
  return {
    macDeviceId: normalizeNonEmptyString(deviceState?.macDeviceId),
    macIdentityPublicKey: normalizeNonEmptyString(deviceState?.macIdentityPublicKey),
    displayName: normalizeNonEmptyString(os.hostname()),
    trustedPhoneDeviceId: normalizeNonEmptyString(trustedPhoneEntry?.[0]),
    trustedPhonePublicKey: normalizeNonEmptyString(trustedPhoneEntry?.[1]),
  };
}

function buildRelayPairingSession(pairingSession) {
  if (!pairingSession?.pairingPayload) {
    return null;
  }

  return {
    pairingSessionId: normalizeNonEmptyString(pairingSession.pairingSessionId),
    pairingCode: normalizeNonEmptyString(pairingSession.pairingCode),
    expiresAt: Number(pairingSession.expiresAt) || 0,
    pairingPayload: {
      v: Number(pairingSession.pairingPayload.v) || 0,
      relay: normalizeNonEmptyString(pairingSession.pairingPayload.relay),
      sessionId: normalizeNonEmptyString(pairingSession.pairingPayload.sessionId),
      macDeviceId: normalizeNonEmptyString(pairingSession.pairingPayload.macDeviceId),
      macIdentityPublicKey: normalizeNonEmptyString(pairingSession.pairingPayload.macIdentityPublicKey),
      expiresAt: Number(pairingSession.pairingPayload.expiresAt) || 0,
    },
  };
}

function shutdown(codex, getSocket, beforeExit = () => {}) {
  beforeExit();

  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  }

  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function shouldStartContextUsageWatcher(context) {
  if (!context?.threadId) {
    return false;
  }

  return context.method === "turn/start"
    || context.method === "turn/started";
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return (
    readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.thread?.id)
    || readString(params?.thread?.threadId)
    || readString(params?.thread?.thread_id)
    || readString(params?.turn?.threadId)
    || readString(params?.turn?.thread_id)
    || readString(params?.item?.threadId)
    || readString(params?.item?.thread_id)
  );
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
      || readString(params?.turn?.turnId)
      || readString(params?.turn?.turn_id)
    );
  }

  return (
    readString(params?.turnId)
    || readString(params?.turn_id)
    || readString(params?.turn?.id)
    || readString(params?.turn?.turnId)
    || readString(params?.turn?.turn_id)
    || readString(params?.item?.turnId)
    || readString(params?.item?.turn_id)
  );
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isBridgeApprovalMethod(method) {
  return method === "item/tool/requestUserInput"
    || method === "item/commandExecution/requestApproval"
    || method === "item/command_execution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || (typeof method === "string" && method.endsWith("requestApproval"));
}

// Shrinks `thread/read` and `thread/resume` snapshots by eliding inline image blobs.
function sanitizeThreadHistoryImagesForRelay(rawMessage, requestMethod) {
  if (requestMethod !== "thread/read" && requestMethod !== "thread/resume") {
    return rawMessage;
  }

  const parsed = parseBridgeJSON(rawMessage);
  const thread = parsed?.result?.thread;
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    return rawMessage;
  }

  let didSanitize = false;
  const sanitizedTurns = thread.turns.map((turn) => {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
      return turn;
    }

    let turnDidChange = false;
    const sanitizedItems = turn.items.map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.content)) {
        return item;
      }

      let itemDidChange = false;
      const sanitizedContent = item.content.map((contentItem) => {
        const sanitizedEntry = sanitizeInlineHistoryImageContentItem(contentItem);
        if (sanitizedEntry !== contentItem) {
          itemDidChange = true;
        }
        return sanitizedEntry;
      });

      if (!itemDidChange) {
        return item;
      }

      turnDidChange = true;
      return {
        ...item,
        content: sanitizedContent,
      };
    });

    if (!turnDidChange) {
      return turn;
    }

    didSanitize = true;
    return {
      ...turn,
      items: sanitizedItems,
    };
  });

  if (!didSanitize) {
    return rawMessage;
  }

  return JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      thread: {
        ...thread,
        turns: sanitizedTurns,
      },
    },
  });
}

// Converts `data:image/...` history content into a tiny placeholder the iPhone can render safely.
function sanitizeInlineHistoryImageContentItem(contentItem) {
  if (!contentItem || typeof contentItem !== "object") {
    return contentItem;
  }

  const normalizedType = normalizeRelayHistoryContentType(contentItem.type);
  if (normalizedType !== "image" && normalizedType !== "localimage") {
    return contentItem;
  }

  const hasInlineUrl = isInlineHistoryImageDataURL(contentItem.url)
    || isInlineHistoryImageDataURL(contentItem.image_url)
    || isInlineHistoryImageDataURL(contentItem.path);
  if (!hasInlineUrl) {
    return contentItem;
  }

  const {
    url: _url,
    image_url: _imageUrl,
    path: _path,
    ...rest
  } = contentItem;

  return {
    ...rest,
    url: RELAY_HISTORY_IMAGE_REFERENCE_URL,
  };
}

function normalizeRelayHistoryContentType(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[\s_-]+/g, "")
    : "";
}

function isInlineHistoryImageDataURL(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("data:image");
}

function parseBridgeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Treats silent relay sockets as stale so the daemon can self-heal after sleep/wake.
function hasRelayConnectionGoneStale(
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
  } = {}
) {
  return Number.isFinite(lastActivityAt)
    && Number.isFinite(now)
    && now - lastActivityAt >= staleAfterMs;
}

// Keeps persisted daemon status honest by downgrading stale "connected" snapshots.
function buildHeartbeatBridgeStatus(
  status,
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
    staleMessage = STALE_RELAY_STATUS_MESSAGE,
  } = {}
) {
  if (!status || typeof status !== "object") {
    return status;
  }

  if (status.connectionStatus !== "connected") {
    return status;
  }

  if (!hasRelayConnectionGoneStale(lastActivityAt, { now, staleAfterMs })) {
    return status;
  }

  return {
    ...status,
    connectionStatus: "disconnected",
    lastError: staleMessage,
  };
}

module.exports = {
  buildHeartbeatBridgeStatus,
  hasRelayConnectionGoneStale,
  sanitizeThreadHistoryImagesForRelay,
  startBridge,
};
