// FILE: push-service.js
// Purpose: Stores session-scoped APNs registration state and sends bridge event pushes for relay-hosted pocketex sessions.
// Layer: Hosted service helper
// Exports: createPushSessionService, createFileBackedPushStateStore, resolvePushStateFilePath
// Depends on: crypto, fs, os, path, ./apns-client

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAPNsClient } = require("./apns-client");

const PUSH_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const PUSH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUSH_PREVIEW_MAX_CHARS = 160;

function createPushSessionService({
  apnsClient = createAPNsClient(apnsConfigFromEnv(process.env)),
  canRegisterSession = () => true,
  canNotifyCompletion = null,
  shouldDeliverPush = () => true,
  now = () => Date.now(),
  logPrefix = "[relay]",
  stateStore = createFileBackedPushStateStore({
    stateFilePath: resolvePushStateFilePath(process.env),
  }),
} = {}) {
  const resolvedCanNotifyCompletion = typeof canNotifyCompletion === "function"
    ? canNotifyCompletion
    : canRegisterSession;
  const persistedState = stateStore.read();
  const sessions = new Map(persistedState.sessions || []);
  const deliveredDedupeKeys = new Map(persistedState.deliveredDedupeKeys || []);
  pruneStaleState();

  async function registerDevice({
    sessionId,
    notificationSecret,
    deviceToken,
    alertsEnabled,
    apnsEnvironment,
  } = {}) {
    const normalizedSessionId = readString(sessionId);
    const normalizedSecret = readString(notificationSecret);
    const normalizedDeviceToken = normalizeDeviceToken(deviceToken);

    if (!normalizedSessionId || !normalizedSecret || !normalizedDeviceToken) {
      throw pushServiceError(
        "invalid_request",
        "Push registration requires sessionId, notificationSecret, and deviceToken.",
        400
      );
    }

    if (!await canRegisterSession({
      sessionId: normalizedSessionId,
      notificationSecret: normalizedSecret,
    })) {
      throw pushServiceError(
        "session_unavailable",
        "Push registration requires an active relay session.",
        403
      );
    }

    const existing = sessions.get(normalizedSessionId);
    if (existing && !secretsEqual(existing.notificationSecret, normalizedSecret)) {
      throw pushServiceError("unauthorized", "Invalid notification secret for this session.", 403);
    }

    sessions.set(normalizedSessionId, {
      notificationSecret: normalizedSecret,
      deviceToken: normalizedDeviceToken,
      alertsEnabled: Boolean(alertsEnabled),
      apnsEnvironment: apnsEnvironment === "development" ? "development" : "production",
      updatedAt: now(),
    });
    persistState("registerDevice");
    return { ok: true };
  }

  async function notifyCompletion({
    sessionId,
    notificationSecret,
    threadId,
    turnId,
    result,
    title,
    body,
    dedupeKey,
  } = {}) {
    const normalizedSessionId = readString(sessionId);
    const normalizedSecret = readString(notificationSecret);
    const normalizedThreadId = readString(threadId);
    const normalizedResult = result === "failed" ? "failed" : "completed";
    const normalizedDedupeKey = readString(dedupeKey);

    if (!normalizedSessionId || !normalizedSecret || !normalizedThreadId || !normalizedDedupeKey) {
      throw pushServiceError(
        "invalid_request",
        "Push completion requires sessionId, notificationSecret, threadId, and dedupeKey.",
        400
      );
    }

    if (!await resolvedCanNotifyCompletion({
      sessionId: normalizedSessionId,
      notificationSecret: normalizedSecret,
    })) {
      throw pushServiceError(
        "session_unavailable",
        "Push completion requires an active relay session.",
        403
      );
    }

    pruneDeliveredDedupeKeys();
    if (deliveredDedupeKeys.has(normalizedDedupeKey)) {
      return { ok: true, deduped: true };
    }

    const session = sessions.get(normalizedSessionId);
    if (!session || !secretsEqual(session.notificationSecret, normalizedSecret)) {
      throw pushServiceError("unauthorized", "Invalid notification secret for this session.", 403);
    }

    if (!session.alertsEnabled || !session.deviceToken) {
      return { ok: true, skipped: true };
    }

    if (!await shouldDeliverPush({
      sessionId: normalizedSessionId,
      notificationSecret: normalizedSecret,
      threadId: normalizedThreadId,
      turnId: readString(turnId) || "",
      kind: "completion",
      result: normalizedResult,
    })) {
      return { ok: true, skipped: true, reason: "iphone_connected" };
    }

    await apnsClient.sendNotification({
      deviceToken: session.deviceToken,
      apnsEnvironment: session.apnsEnvironment,
      title: normalizePreviewText(title) || "New Thread",
      body: normalizePreviewText(body) || fallbackBodyForResult(normalizedResult),
      payload: {
        source: "codex.runCompletion",
        threadId: normalizedThreadId,
        turnId: readString(turnId) || "",
        result: normalizedResult,
      },
    });

    deliveredDedupeKeys.set(normalizedDedupeKey, now());
    persistState("notifyCompletion");
    return { ok: true };
  }

  async function notifyEvent({
    sessionId,
    notificationSecret,
    eventType,
    threadId,
    turnId,
    title,
    body,
    dedupeKey,
    eventPayload,
  } = {}) {
    const normalizedSessionId = readString(sessionId);
    const normalizedSecret = readString(notificationSecret);
    const normalizedEventType = readString(eventType);
    const normalizedDedupeKey = readString(dedupeKey);
    const normalizedThreadId = readString(threadId);

    if (!normalizedSessionId || !normalizedSecret || !normalizedEventType || !normalizedDedupeKey) {
      throw pushServiceError(
        "invalid_request",
        "Push event requires sessionId, notificationSecret, eventType, and dedupeKey.",
        400
      );
    }

    if (!await resolvedCanNotifyCompletion({
      sessionId: normalizedSessionId,
      notificationSecret: normalizedSecret,
    })) {
      throw pushServiceError(
        "session_unavailable",
        "Push event requires an active relay session.",
        403
      );
    }

    pruneDeliveredDedupeKeys();
    if (deliveredDedupeKeys.has(normalizedDedupeKey)) {
      return { ok: true, deduped: true };
    }

    const session = sessions.get(normalizedSessionId);
    if (!session || !secretsEqual(session.notificationSecret, normalizedSecret)) {
      throw pushServiceError("unauthorized", "Invalid notification secret for this session.", 403);
    }

    if (!session.alertsEnabled || !session.deviceToken) {
      return { ok: true, skipped: true };
    }

    if (!await shouldDeliverPush({
      sessionId: normalizedSessionId,
      notificationSecret: normalizedSecret,
      threadId: normalizedThreadId || "",
      turnId: readString(turnId) || "",
      kind: "event",
      eventType: normalizedEventType,
    })) {
      return { ok: true, skipped: true, reason: "iphone_connected" };
    }

    await apnsClient.sendNotification({
      deviceToken: session.deviceToken,
      apnsEnvironment: session.apnsEnvironment,
      title: normalizePreviewText(title) || fallbackTitleForEventType(normalizedEventType),
      body: normalizePreviewText(body) || fallbackBodyForEventType(normalizedEventType, eventPayload),
      payload: {
        source: notificationSourceForEventType(normalizedEventType),
        eventType: normalizedEventType,
        threadId: normalizedThreadId || "",
        turnId: readString(turnId) || "",
        ...safeNotificationPayloadObject(eventPayload),
      },
    });

    deliveredDedupeKeys.set(normalizedDedupeKey, now());
    persistState("notifyEvent");
    return { ok: true };
  }

  function getStats() {
    pruneDeliveredDedupeKeys();
    return {
      registeredSessions: sessions.size,
      deliveredDedupeKeys: deliveredDedupeKeys.size,
      apnsConfigured: apnsClient.isConfigured(),
    };
  }

  function pruneDeliveredDedupeKeys() {
    let didChange = false;
    const cutoff = now() - PUSH_DEDUPE_TTL_MS;
    for (const [key, timestamp] of deliveredDedupeKeys.entries()) {
      if (timestamp < cutoff) {
        deliveredDedupeKeys.delete(key);
        didChange = true;
      }
    }
    return didChange;
  }

  function pruneSessions() {
    let didChange = false;
    const cutoff = now() - PUSH_SESSION_TTL_MS;
    for (const [sessionId, session] of sessions.entries()) {
      if (Number(session?.updatedAt || 0) < cutoff) {
        sessions.delete(sessionId);
        didChange = true;
      }
    }
    return didChange;
  }

  function pruneStaleState() {
    if (pruneDeliveredDedupeKeys() || pruneSessions()) {
      persistState("pruneStaleState");
    }
  }

  // Keeps live registrations usable even if the optional state file cannot be updated.
  function persistState(reason) {
    try {
      stateStore.write({
        sessions: [...sessions.entries()],
        deliveredDedupeKeys: [...deliveredDedupeKeys.entries()],
      });
    } catch (error) {
      console.error(
        `${logPrefix} push state persistence failed during ${reason}: ${error.message}`
      );
    }
  }

  return {
    registerDevice,
    notifyCompletion,
    notifyEvent,
    getStats,
  };
}

function createFileBackedPushStateStore({ stateFilePath } = {}) {
  const resolvedPath = typeof stateFilePath === "string" && stateFilePath.trim()
    ? stateFilePath.trim()
    : "";

  return {
    read() {
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        return emptyPushState();
      }

      const parsed = safeParseJSON(fs.readFileSync(resolvedPath, "utf8"));
      if (!parsed || typeof parsed !== "object") {
        return emptyPushState();
      }

      return {
        sessions: normalizeEntryList(parsed.sessions),
        deliveredDedupeKeys: normalizeEntryList(parsed.deliveredDedupeKeys),
      };
    },
    write(state) {
      if (!resolvedPath) {
        return;
      }

      const normalizedState = {
        sessions: normalizeEntryList(state?.sessions),
        deliveredDedupeKeys: normalizeEntryList(state?.deliveredDedupeKeys),
      };
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const tempPath = `${resolvedPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(normalizedState), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tempPath, resolvedPath);
      try {
        fs.chmodSync(resolvedPath, 0o600);
      } catch {
        // Best-effort only on filesystems that support POSIX modes.
      }
    },
  };
}

function apnsConfigFromEnv(env) {
  return {
    teamId: readFirstDefinedEnv(["POCKETEX_APNS_TEAM_ID", "PHODEX_APNS_TEAM_ID"], env),
    keyId: readFirstDefinedEnv(["POCKETEX_APNS_KEY_ID", "PHODEX_APNS_KEY_ID"], env),
    bundleId: readFirstDefinedEnv(["POCKETEX_APNS_BUNDLE_ID", "PHODEX_APNS_BUNDLE_ID"], env),
    privateKey: readAPNsPrivateKey(env),
  };
}

function readAPNsPrivateKey(env) {
  const rawValue = readFirstDefinedEnv(
    ["POCKETEX_APNS_PRIVATE_KEY", "PHODEX_APNS_PRIVATE_KEY"],
    env
  );
  if (rawValue) {
    return rawValue;
  }

  const filePath = readFirstDefinedEnv(
    ["POCKETEX_APNS_PRIVATE_KEY_FILE", "PHODEX_APNS_PRIVATE_KEY_FILE"],
    env
  );
  if (!filePath) {
    return "";
  }

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readFirstDefinedEnv(keys, env) {
  for (const key of keys) {
    const value = readString(env?.[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizeDeviceToken(value) {
  const normalized = readString(value);
  if (!normalized) {
    return "";
  }

  return normalized.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

function normalizePreviewText(value) {
  const normalized = readString(value).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  return normalized.length > PUSH_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, PUSH_PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : normalized;
}

function fallbackBodyForResult(result) {
  return result === "failed" ? "Run failed" : "Response ready";
}

function fallbackTitleForEventType(eventType) {
  switch (eventType) {
    case "approval_needed":
      return "pocketex approval needed";
    case "structured_user_input_needed":
      return "pocketex input needed";
    case "bridge_offline":
      return "pocketex went offline";
    case "reconnect_succeeded":
      return "pocketex reconnected";
    case "reconnect_failed":
      return "pocketex reconnect failed";
    default:
      return "pocketex";
  }
}

function fallbackBodyForEventType(eventType, eventPayload) {
  switch (eventType) {
    case "approval_needed":
      return "Approval needed to continue the run.";
    case "structured_user_input_needed": {
      const questionCount = readPositiveInteger(eventPayload?.questionCount);
      if (questionCount === 1) {
        return "Codex needs one answer to continue.";
      }
      if (questionCount > 1) {
        return `Codex needs ${questionCount} answers to continue.`;
      }
      return "Codex needs input to continue.";
    }
    case "bridge_offline":
      return "The Mac bridge is no longer reachable.";
    case "reconnect_succeeded":
      return "Your Mac bridge is reachable again.";
    case "reconnect_failed":
      return "The Mac bridge could not be restored.";
    default:
      return "New pocketex event.";
  }
}

function safeNotificationPayloadObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (typeof entryValue === "string") {
        return entryValue.trim().length > 0;
      }
      return typeof entryValue === "number" || typeof entryValue === "boolean";
    })
  );
}

function notificationSourceForEventType(eventType) {
  return eventType === "structured_user_input_needed"
    ? "codex.structuredUserInput"
    : "codex.bridgeEvent";
}

function resolvePushStateFilePath(env = process.env) {
  const explicitPath = readFirstDefinedEnv(
    ["POCKETEX_PUSH_STATE_FILE", "PHODEX_PUSH_STATE_FILE"],
    env
  );
  if (explicitPath) {
    return explicitPath;
  }

  const codexHome = readString(env.CODEX_HOME) || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "pocketex", "push-state.json");
}

function normalizeEntryList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => Array.isArray(entry) && entry.length === 2);
}

function emptyPushState() {
  return {
    sessions: [],
    deliveredDedupeKeys: [],
  };
}

function safeParseJSON(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(readString(left));
  const rightBuffer = Buffer.from(readString(right));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readPositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function pushServiceError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

module.exports = {
  createPushSessionService,
  createFileBackedPushStateStore,
  resolvePushStateFilePath,
};
