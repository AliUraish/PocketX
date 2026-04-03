// FILE: event-log.js
// Purpose: Persists a compact bridge-side event journal for reconnect, pairing, approval, and runtime diagnostics.
// Layer: CLI helper
// Exports: createBridgeEventLogStore plus event-log path resolver
// Depends on: fs, path, ./daemon-state

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { resolvePocketexStateDir } = require("./daemon-state");

const EVENT_LOG_FILE = "event-log.json";
const DEFAULT_MAX_EVENT_COUNT = 300;

function createBridgeEventLogStore({
  maxEntries = DEFAULT_MAX_EVENT_COUNT,
  now = () => Date.now(),
  fsImpl = fs,
  env = process.env,
} = {}) {
  let state = normalizeEventLogState(readEventLogFile({ fsImpl, env }), {
    maxEntries,
  });

  return {
    append(event) {
      const normalizedEvent = normalizeDiagnosticEvent(event, { now });
      if (!normalizedEvent) {
        return null;
      }

      state.events.push(normalizedEvent);
      trimEvents();
      persist();
      return normalizedEvent;
    },

    listRecentEvents(limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      return state.events.slice(-safeLimit).reverse();
    },
  };

  function trimEvents() {
    const safeMaxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_EVENT_COUNT);
    if (state.events.length > safeMaxEntries) {
      state.events = state.events.slice(-safeMaxEntries);
    }
  }

  function persist() {
    writeEventLogFile(state, { fsImpl, env });
  }
}

function resolveEventLogPath(options = {}) {
  return path.join(resolvePocketexStateDir(options), EVENT_LOG_FILE);
}

function readEventLogFile({ fsImpl = fs, ...options } = {}) {
  const targetPath = resolveEventLogPath(options);
  if (!fsImpl.existsSync(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(fsImpl.readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
}

function writeEventLogFile(value, { fsImpl = fs, ...options } = {}) {
  const targetPath = resolveEventLogPath(options);
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.writeFileSync(targetPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fsImpl.chmodSync(targetPath, 0o600);
  } catch {
    // Best-effort only on filesystems without POSIX mode support.
  }
}

function normalizeEventLogState(value, { maxEntries = DEFAULT_MAX_EVENT_COUNT } = {}) {
  const safeMaxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_EVENT_COUNT);
  const events = Array.isArray(value?.events)
    ? value.events
      .map((event) => normalizeDiagnosticEvent(event, { now: () => Date.now() }))
      .filter(Boolean)
      .slice(-safeMaxEntries)
    : [];

  return { events };
}

function normalizeDiagnosticEvent(event, { now = () => Date.now() } = {}) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const type = normalizeNonEmptyString(event.type);
  const level = normalizeEventLevel(event.level);
  const message = normalizeNonEmptyString(event.message);
  if (!type || !message) {
    return null;
  }

  const recordedAt = Number(event.recordedAt);
  const safeRecordedAt = Number.isFinite(recordedAt) && recordedAt > 0 ? recordedAt : now();
  return compactObject({
    id: normalizeNonEmptyString(event.id) || randomUUID(),
    type,
    level,
    message,
    detail: normalizeNonEmptyString(event.detail),
    recordedAt: safeRecordedAt,
    metadata: sanitizeMetadata(event.metadata),
  });
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const blockedKeys = new Set([
    "sessionId",
    "session_id",
    "pairingCode",
    "pairing_code",
    "token",
    "secret",
    "authUrl",
    "auth_url",
  ]);
  const entries = Object.entries(value).filter(([key, entryValue]) => {
    if (blockedKeys.has(key)) {
      return false;
    }
    if (entryValue == null) {
      return false;
    }
    if (typeof entryValue === "string") {
      return entryValue.trim().length > 0;
    }
    return ["number", "boolean"].includes(typeof entryValue);
  });

  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue != null)
  );
}

function normalizeEventLevel(value) {
  switch (normalizeNonEmptyString(value).toLowerCase()) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  createBridgeEventLogStore,
  resolveEventLogPath,
};
