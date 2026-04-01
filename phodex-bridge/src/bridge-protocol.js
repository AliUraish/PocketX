// FILE: bridge-protocol.js
// Purpose: Defines the bridge-owned mobile protocol facade over raw Codex RPC methods and events.
// Layer: CLI service support
// Exports: bridge protocol constants plus request/result/event normalization helpers
// Depends on: none

const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_EVENT_METHOD = "bridge/event";
const BRIDGE_REQUEST_METHOD = "bridge/request";

const BRIDGE_PROXY_METHOD_TO_CODEX_METHOD = {
  "bridge/thread/start": "thread/start",
  "bridge/thread/list": "thread/list",
  "bridge/thread/read": "thread/read",
  "bridge/thread/resume": "thread/resume",
  "bridge/thread/fork": "thread/fork",
  "bridge/model/list": "model/list",
  "bridge/collaborationMode/list": "collaborationMode/list",
  "bridge/turn/start": "turn/start",
  "bridge/turn/steer": "turn/steer",
  "bridge/turn/interrupt": "turn/interrupt",
};

function extractRequestedBridgeProtocolVersion(params) {
  const capabilities = readObject(params?.capabilities) || {};
  const bridgeProtocol = readObject(capabilities.bridgeProtocol)
    || readObject(capabilities.bridge_protocol);

  if (bridgeProtocol) {
    const advertisedVersion = clampPositiveInteger(
      bridgeProtocol.maxVersion,
      bridgeProtocol.max_version,
      bridgeProtocol.version,
      bridgeProtocol.v
    );
    if (advertisedVersion > 0) {
      return Math.min(advertisedVersion, BRIDGE_PROTOCOL_VERSION);
    }
  }

  if (capabilities.bridgeProtocol === true || capabilities.bridge_protocol === true) {
    return BRIDGE_PROTOCOL_VERSION;
  }

  return 0;
}

function isBridgeProtocolMethod(method) {
  return typeof method === "string"
    && (method === "bridge/capabilities"
      || method === "bridge/health"
      || method === "bridge/diagnostics/read"
      || method === "bridge/approval/list"
      || method === "bridge/approval/resolve"
      || Boolean(BRIDGE_PROXY_METHOD_TO_CODEX_METHOD[method]));
}

function isBridgeProtocolProxyMethod(method) {
  return typeof method === "string" && Boolean(BRIDGE_PROXY_METHOD_TO_CODEX_METHOD[method]);
}

function mapBridgeProtocolMethodToCodexMethod(method) {
  return BRIDGE_PROXY_METHOD_TO_CODEX_METHOD[method] || "";
}

function buildBridgeCapabilities({
  packageVersionStatus = null,
  runtimeCapabilitySnapshot = null,
} = {}) {
  return {
    bridgeManaged: true,
    bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    notificationEnvelopeMethod: BRIDGE_EVENT_METHOD,
    requestEnvelopeMethod: BRIDGE_REQUEST_METHOD,
    methods: Object.keys(BRIDGE_PROXY_METHOD_TO_CODEX_METHOD).concat([
      "bridge/capabilities",
      "bridge/health",
      "bridge/diagnostics/read",
      "bridge/approval/list",
      "bridge/approval/resolve",
      "account/status/read",
      "voice/resolveAuth",
    ]),
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
    bridgeVersion: readString(packageVersionStatus?.bridgeVersion) || null,
    bridgeLatestVersion: readString(packageVersionStatus?.bridgeLatestVersion) || null,
    codexVersion: readString(runtimeCapabilitySnapshot?.codexVersion) || null,
    runtimeCapabilities: compactObject({
      planCollaborationMode: readBoolean(runtimeCapabilitySnapshot?.capabilities?.planCollaborationMode),
      serviceTier: readBoolean(runtimeCapabilitySnapshot?.capabilities?.serviceTier),
      threadFork: readBoolean(runtimeCapabilitySnapshot?.capabilities?.threadFork),
      accountStatusRead: true,
      voiceResolveAuth: true,
    }),
    runtimeCapabilityProbeAt: clampPositiveInteger(runtimeCapabilitySnapshot?.probedAt) || null,
  };
}

function buildBridgeHealthSnapshot({
  bridgeStatus = null,
  codexHandshakeState = "cold",
  pairingSession = null,
  packageVersionStatus = null,
  pendingApprovalCount = 0,
  lastRelayActivityAt = 0,
  relayHeartbeatStaleAfterMs = 25_000,
  now = Date.now(),
} = {}) {
  const normalizedBridgeState = readString(bridgeStatus?.state) || "stopped";
  const relayConnectionStatus = readString(bridgeStatus?.connectionStatus) || "disconnected";
  const codexConnectionStatus = normalizedBridgeState === "error"
    ? "unreachable"
    : codexHandshakeState === "warm"
      ? "connected"
      : "starting";
  const pairingCodeExpiresAt = Number(pairingSession?.expiresAt);
  const normalizedPendingApprovalCount = Math.max(0, Number(pendingApprovalCount) || 0);
  const normalizedLastRelayActivityAt = Number.isFinite(Number(lastRelayActivityAt))
    ? Number(lastRelayActivityAt)
    : 0;
  const relayHeartbeatStale = normalizedLastRelayActivityAt > 0
    && Number.isFinite(now)
    && now - normalizedLastRelayActivityAt >= relayHeartbeatStaleAfterMs;

  return {
    status: deriveBridgeHealthStatus({
      bridgeState: normalizedBridgeState,
      relayConnectionStatus,
      codexHandshakeState,
      relayHeartbeatStale,
      pendingApprovalCount: normalizedPendingApprovalCount,
    }),
    bridgeState: normalizedBridgeState,
    relayConnectionStatus,
    codexConnectionStatus,
    codexHandshakeState: codexHandshakeState === "warm" ? "warm" : "cold",
    lastError: readString(bridgeStatus?.lastError) || null,
    pendingApprovalCount: normalizedPendingApprovalCount,
    pairingCodeActive: Number.isFinite(pairingCodeExpiresAt) && pairingCodeExpiresAt > now,
    pairingCodeExpiresAt: Number.isFinite(pairingCodeExpiresAt) && pairingCodeExpiresAt > 0
      ? pairingCodeExpiresAt
      : null,
    lastRelayActivityAt: normalizedLastRelayActivityAt > 0 ? normalizedLastRelayActivityAt : null,
    relayHeartbeatStale,
    canReconnect: normalizedBridgeState === "running" && relayConnectionStatus !== "connected",
    bridgeVersion: readString(packageVersionStatus?.bridgeVersion) || null,
    bridgeLatestVersion: readString(packageVersionStatus?.bridgeLatestVersion) || null,
  };
}

function normalizeBridgeProtocolResult(bridgeMethod, rawResult) {
  const rawResultObject = readObject(rawResult);

  switch (bridgeMethod) {
    case "bridge/thread/list":
      return compactObject({
        threads: readListEntries(rawResultObject, ["threads", "items", "data"]),
        nextCursor: readThreadListCursor(rawResultObject),
        rawResult,
      });
    case "bridge/thread/start":
    case "bridge/thread/read":
    case "bridge/thread/resume":
    case "bridge/thread/fork":
      return compactObject({
        thread: readObject(rawResultObject?.thread) || null,
        rawResult,
      });
    case "bridge/model/list":
      return compactObject({
        items: readListEntries(rawResultObject, ["items", "data", "models"]),
        nextCursor: readThreadListCursor(rawResultObject),
        rawResult,
      });
    case "bridge/collaborationMode/list":
      return compactObject({
        items: readListEntries(rawResultObject, [
          "items",
          "data",
          "modes",
          "collaborationModes",
          "collaboration_modes",
        ]) || readArray(rawResult) || [],
        nextCursor: readThreadListCursor(rawResultObject),
        rawResult,
      });
    case "bridge/turn/start":
    case "bridge/turn/steer":
      return compactObject({
        turnId: extractTurnId(rawResultObject),
        threadId: extractThreadId("", rawResultObject),
        rawResult,
      });
    case "bridge/turn/interrupt":
      return compactObject({
        ok: true,
        turnId: extractTurnId(rawResultObject),
        threadId: extractThreadId("", rawResultObject),
        rawResult,
      });
    default:
      return compactObject({ rawResult });
  }
}

function buildBridgeEventEnvelope(rawMethod, rawParams) {
  return {
    method: BRIDGE_EVENT_METHOD,
    params: buildBridgeEnvelopeParams(rawMethod, rawParams),
  };
}

function buildBridgeRequestEnvelope(requestId, rawMethod, rawParams) {
  return {
    id: requestId,
    method: BRIDGE_REQUEST_METHOD,
    params: buildBridgeEnvelopeParams(rawMethod, rawParams),
  };
}

function normalizeBridgeEventName(rawMethod) {
  const normalizedMethod = readString(rawMethod) || "";
  if (!normalizedMethod) {
    return "bridge.event";
  }

  if (isApprovalRequestMethod(normalizedMethod)) {
    return "approval.requested";
  }

  switch (normalizedMethod) {
    case "thread/started":
    case "thread/name/updated":
    case "thread/status/changed":
    case "thread/tokenUsage/updated":
      return "thread.updated";
    case "turn/started":
      return "turn.started";
    case "turn/completed":
      return "turn.completed";
    case "turn/plan/updated":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "item/fileChange/outputDelta":
    case "item/toolCall/outputDelta":
    case "item/toolCall/output_delta":
    case "item/tool_call/outputDelta":
    case "item/tool_call/output_delta":
    case "item/commandExecution/outputDelta":
    case "item/command_execution/outputDelta":
      return "turn.streaming";
    default:
      if (normalizedMethod.startsWith("codex/event/")) {
        return "turn.streaming";
      }
      return normalizedMethod.replace(/\//g, ".");
  }
}

function buildBridgeEnvelopeParams(rawMethod, rawParams) {
  const normalizedRawMethod = readString(rawMethod) || "";
  const normalizedRawParams = readObject(rawParams) || rawParams || null;
  const threadId = extractThreadId(normalizedRawMethod, normalizedRawParams);
  const turnId = extractTurnId(normalizedRawParams);

  return compactObject({
    event: normalizeBridgeEventName(normalizedRawMethod),
    rawMethod: normalizedRawMethod || null,
    rawParams: normalizedRawParams,
    threadId,
    turnId,
  });
}

function deriveBridgeHealthStatus({
  bridgeState,
  relayConnectionStatus,
  codexHandshakeState,
  relayHeartbeatStale = false,
  pendingApprovalCount = 0,
}) {
  if (bridgeState === "stopped") {
    return "bridge_down";
  }
  if (bridgeState === "error") {
    return "codex_unreachable";
  }
  if (relayConnectionStatus === "starting" || relayConnectionStatus === "connecting") {
    return "reconnecting";
  }
  if (relayHeartbeatStale) {
    return "mac_sleeping_or_unresponsive";
  }
  if (relayConnectionStatus === "disconnected") {
    return "relay_unreachable";
  }
  if (relayConnectionStatus === "error") {
    return "codex_unreachable";
  }
  if (codexHandshakeState !== "warm") {
    return "reconnecting";
  }
  if (pendingApprovalCount > 0) {
    return "approval_pending";
  }
  if (relayConnectionStatus === "connected" && codexHandshakeState === "warm") {
    return "healthy";
  }
  return "reconnecting";
}

function readListEntries(resultObject, keys) {
  if (!resultObject || typeof resultObject !== "object") {
    return [];
  }

  for (const key of keys) {
    const entries = readArray(resultObject[key]);
    if (entries) {
      return entries;
    }
  }

  return [];
}

function readThreadListCursor(resultObject) {
  if (!resultObject || typeof resultObject !== "object") {
    return null;
  }

  return resultObject.nextCursor
    ?? resultObject.next_cursor
    ?? null;
}

function extractThreadId(rawMethod, rawParams) {
  const paramsObject = readObject(rawParams);
  if (!paramsObject) {
    return null;
  }

  if (rawMethod === "thread/started" || rawMethod === "thread/start") {
    return firstNonEmptyString([
      paramsObject.threadId,
      paramsObject.thread_id,
      paramsObject.thread?.id,
      paramsObject.thread?.threadId,
      paramsObject.thread?.thread_id,
    ]);
  }

  if (rawMethod === "turn/start"
    || rawMethod === "turn/started"
    || rawMethod === "turn/completed") {
    return firstNonEmptyString([
      paramsObject.threadId,
      paramsObject.thread_id,
      paramsObject.turn?.threadId,
      paramsObject.turn?.thread_id,
    ]);
  }

  return firstNonEmptyString([
    paramsObject.threadId,
    paramsObject.thread_id,
    paramsObject.thread?.id,
    paramsObject.thread?.threadId,
    paramsObject.thread?.thread_id,
    paramsObject.turn?.threadId,
    paramsObject.turn?.thread_id,
    paramsObject.item?.threadId,
    paramsObject.item?.thread_id,
  ]);
}

function extractTurnId(rawParams) {
  const paramsObject = readObject(rawParams);
  if (!paramsObject) {
    return null;
  }

  return firstNonEmptyString([
    paramsObject.turnId,
    paramsObject.turn_id,
    paramsObject.id,
    paramsObject.turn?.id,
    paramsObject.turn?.turnId,
    paramsObject.turn?.turn_id,
    paramsObject.item?.turnId,
    paramsObject.item?.turn_id,
  ]);
}

function isApprovalRequestMethod(method) {
  return method === "item/tool/requestUserInput"
    || method === "item/commandExecution/requestApproval"
    || method === "item/command_execution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method.endsWith("requestApproval");
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readArray(value) {
  return Array.isArray(value) ? value : null;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const normalizedValue = readString(value);
    if (normalizedValue) {
      return normalizedValue;
    }
  }
  return null;
}

function clampPositiveInteger(...values) {
  for (const value of values) {
    const numericValue = Number(value);
    if (Number.isInteger(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }
  return 0;
}

module.exports = {
  BRIDGE_EVENT_METHOD,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REQUEST_METHOD,
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
};
