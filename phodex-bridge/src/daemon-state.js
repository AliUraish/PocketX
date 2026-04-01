// FILE: daemon-state.js
// Purpose: Persists macOS service config/runtime state outside the repo for the launchd bridge flow.
// Layer: CLI helper
// Exports: path resolvers plus read/write helpers for daemon config, pairing payloads, and service status.
// Depends on: fs, os, path

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_STATE_DIR_NAME = ".rimcodex";
const DAEMON_CONFIG_FILE = "daemon-config.json";
const PAIRING_SESSION_FILE = "pairing-session.json";
const BRIDGE_STATUS_FILE = "bridge-status.json";
const LOGS_DIR = "logs";
const BRIDGE_STDOUT_LOG_FILE = "bridge.stdout.log";
const BRIDGE_STDERR_LOG_FILE = "bridge.stderr.log";

// Reuses the existing rimcodex state root so daemon mode keeps the same local-first storage model.
function resolveRemodexStateDir({ env = process.env, osImpl = os } = {}) {
  return normalizeNonEmptyString(env.RIMCODEX_DEVICE_STATE_DIR)
    || normalizeNonEmptyString(env.REMODEX_DEVICE_STATE_DIR)
    || path.join(osImpl.homedir(), DEFAULT_STATE_DIR_NAME);
}

function resolveDaemonConfigPath(options = {}) {
  return path.join(resolveRemodexStateDir(options), DAEMON_CONFIG_FILE);
}

function resolvePairingSessionPath(options = {}) {
  return path.join(resolveRemodexStateDir(options), PAIRING_SESSION_FILE);
}

function resolveBridgeStatusPath(options = {}) {
  return path.join(resolveRemodexStateDir(options), BRIDGE_STATUS_FILE);
}

function resolveBridgeLogsDir(options = {}) {
  return path.join(resolveRemodexStateDir(options), LOGS_DIR);
}

function resolveBridgeStdoutLogPath(options = {}) {
  return path.join(resolveBridgeLogsDir(options), BRIDGE_STDOUT_LOG_FILE);
}

function resolveBridgeStderrLogPath(options = {}) {
  return path.join(resolveBridgeLogsDir(options), BRIDGE_STDERR_LOG_FILE);
}

function writeDaemonConfig(config, options = {}) {
  writeJsonFile(resolveDaemonConfigPath(options), config, options);
}

function readDaemonConfig(options = {}) {
  return readJsonFile(resolveDaemonConfigPath(options), options);
}

// Persists the pairing session so foreground CLI commands can render the latest pairing code locally.
function writePairingSession(pairingSession, { now = () => Date.now(), ...options } = {}) {
  const normalizedPairingSession = normalizeStoredPairingSession({
    createdAt: new Date(now()).toISOString(),
    ...(normalizePairingSessionInput(pairingSession)),
  });
  if (!normalizedPairingSession) {
    return;
  }

  writeJsonFile(resolvePairingSessionPath(options), normalizedPairingSession, options);
}

function readPairingSession(options = {}) {
  return normalizeStoredPairingSession(readJsonFile(resolvePairingSessionPath(options), options));
}

function clearPairingSession({ fsImpl = fs, ...options } = {}) {
  removeFile(resolvePairingSessionPath(options), fsImpl);
}

// Captures the last known service heartbeat so `rimcodex status` does not depend on launchctl output alone.
function writeBridgeStatus(status, { now = () => Date.now(), ...options } = {}) {
  writeJsonFile(resolveBridgeStatusPath(options), {
    ...status,
    updatedAt: new Date(now()).toISOString(),
  }, options);
}

function readBridgeStatus(options = {}) {
  return readJsonFile(resolveBridgeStatusPath(options), options);
}

function clearBridgeStatus({ fsImpl = fs, ...options } = {}) {
  removeFile(resolveBridgeStatusPath(options), fsImpl);
}

function ensureRemodexStateDir({ fsImpl = fs, ...options } = {}) {
  fsImpl.mkdirSync(resolveRemodexStateDir(options), { recursive: true });
}

function ensureRemodexLogsDir({ fsImpl = fs, ...options } = {}) {
  fsImpl.mkdirSync(resolveBridgeLogsDir(options), { recursive: true });
}

function normalizePairingSessionInput(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "pairingCode")
    || Object.prototype.hasOwnProperty.call(value, "pairingSessionId")
    || Object.prototype.hasOwnProperty.call(value, "expiresAt")
    || Object.prototype.hasOwnProperty.call(value, "pairingPayload")
  ) {
    return value;
  }

  return {
    pairingPayload: value,
  };
}

function normalizeStoredPairingSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const nestedPairingSession = value.pairingPayload
    && typeof value.pairingPayload === "object"
    && (
      Object.prototype.hasOwnProperty.call(value.pairingPayload, "pairingCode")
      || Object.prototype.hasOwnProperty.call(value.pairingPayload, "pairingSessionId")
      || Object.prototype.hasOwnProperty.call(value.pairingPayload, "expiresAt")
      || Object.prototype.hasOwnProperty.call(value.pairingPayload, "pairingPayload")
    )
    ? value.pairingPayload
    : null;
  const sessionSource = nestedPairingSession || value;
  const normalized = {};
  const createdAt = normalizeNonEmptyString(value.createdAt);
  if (createdAt) {
    normalized.createdAt = createdAt;
  }

  const pairingSessionId = normalizeNonEmptyString(sessionSource.pairingSessionId);
  if (pairingSessionId) {
    normalized.pairingSessionId = pairingSessionId;
  }

  const pairingCode = normalizeNonEmptyString(sessionSource.pairingCode);
  if (pairingCode) {
    normalized.pairingCode = pairingCode;
  }

  const expiresAt = Number(sessionSource.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    normalized.expiresAt = expiresAt;
  }

  const pairingPayload = normalizePairingPayload(
    nestedPairingSession
      ? nestedPairingSession.pairingPayload
      : value.pairingPayload
  );
  if (pairingPayload) {
    normalized.pairingPayload = pairingPayload;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizePairingPayload(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const normalized = {};
  const version = Number(value.v);
  const relay = normalizeNonEmptyString(value.relay);
  const sessionId = normalizeNonEmptyString(value.sessionId);
  const macDeviceId = normalizeNonEmptyString(value.macDeviceId);
  const macIdentityPublicKey = normalizeNonEmptyString(value.macIdentityPublicKey);
  const expiresAt = Number(value.expiresAt);

  if (Number.isFinite(version) && version > 0) {
    normalized.v = version;
  }
  if (relay) {
    normalized.relay = relay;
  }
  if (sessionId) {
    normalized.sessionId = sessionId;
  }
  if (macDeviceId) {
    normalized.macDeviceId = macDeviceId;
  }
  if (macIdentityPublicKey) {
    normalized.macIdentityPublicKey = macIdentityPublicKey;
  }
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    normalized.expiresAt = expiresAt;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function writeJsonFile(targetPath, value, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  const serialized = JSON.stringify(value, null, 2);
  fsImpl.writeFileSync(targetPath, serialized, { mode: 0o600 });
  try {
    fsImpl.chmodSync(targetPath, 0o600);
  } catch {
    // Best-effort only on filesystems without POSIX mode support.
  }
}

function readJsonFile(targetPath, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(fsImpl.readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
}

function removeFile(targetPath, fsImpl) {
  try {
    fsImpl.rmSync(targetPath, { force: true });
  } catch {
    // Missing runtime files should not block control-plane commands.
  }
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  clearBridgeStatus,
  clearPairingSession,
  ensureRemodexLogsDir,
  ensureRemodexStateDir,
  readBridgeStatus,
  readDaemonConfig,
  readPairingSession,
  resolveBridgeLogsDir,
  resolveBridgeStderrLogPath,
  resolveBridgeStatusPath,
  resolveBridgeStdoutLogPath,
  resolveDaemonConfigPath,
  resolvePairingSessionPath,
  resolveRemodexStateDir,
  writeBridgeStatus,
  writeDaemonConfig,
  writePairingSession,
};
