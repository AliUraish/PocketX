// FILE: approval-state.js
// Purpose: Persists pending bridge approvals and a local audit trail for reconnect-safe phone approvals.
// Layer: CLI helper
// Exports: createBridgeApprovalStateStore plus approval state path resolver
// Depends on: fs, path, ./daemon-state

const fs = require("fs");
const path = require("path");
const { resolveRemodexStateDir } = require("./daemon-state");

const APPROVAL_STATE_FILE = "approval-state.json";
const MAX_APPROVAL_AUDIT_ENTRIES = 200;

function createBridgeApprovalStateStore({
  bridgeSessionId = "",
  staleAfterMs = 24 * 60 * 60 * 1000,
  now = () => Date.now(),
  fsImpl = fs,
  env = process.env,
} = {}) {
  let state = normalizeApprovalState(readApprovalStateFile({ fsImpl, env }));
  let mutated = false;
  const normalizedBridgeSessionId = normalizeNonEmptyString(bridgeSessionId);

  if (state.bridgeSessionId
    && normalizedBridgeSessionId
    && state.bridgeSessionId !== normalizedBridgeSessionId
    && state.pendingApprovals.length > 0) {
    const clearedAt = now();
    state.auditLog = state.auditLog.concat(
      state.pendingApprovals.map((approval) => buildAuditEntry("cleared_on_restart", approval, {
        recordedAt: clearedAt,
        outcome: "bridge_restarted",
      }))
    ).slice(-MAX_APPROVAL_AUDIT_ENTRIES);
    state.pendingApprovals = [];
    mutated = true;
  }

  if (normalizedBridgeSessionId && state.bridgeSessionId !== normalizedBridgeSessionId) {
    state.bridgeSessionId = normalizedBridgeSessionId;
    mutated = true;
  }

  const pruneResult = pruneExpiredApprovals(state, { now: now(), staleAfterMs });
  state = pruneResult.state;
  mutated = mutated || pruneResult.changed;

  if (mutated) {
    writeApprovalStateFile(state, { fsImpl, env });
  }

  return {
    countPendingApprovals() {
      const entries = listPendingApprovals();
      return entries.length;
    },

    expirePendingApproval(requestId, reason = "expired") {
      const normalizedRequestId = normalizeNonEmptyString(requestId);
      if (!normalizedRequestId) {
        return false;
      }

      const entry = state.pendingApprovals.find((item) => item.requestId === normalizedRequestId);
      if (!entry) {
        return false;
      }

      state.pendingApprovals = state.pendingApprovals.filter((item) => item.requestId !== normalizedRequestId);
      state.auditLog = state.auditLog.concat(
        buildAuditEntry("expired", entry, {
          recordedAt: now(),
          outcome: normalizeNonEmptyString(reason) || "expired",
        })
      ).slice(-MAX_APPROVAL_AUDIT_ENTRIES);
      persist();
      return true;
    },

    listPendingApprovals,

    rememberPendingApproval(entry) {
      const normalizedEntry = normalizePendingApprovalEntry(entry);
      if (!normalizedEntry) {
        return null;
      }

      const existingIndex = state.pendingApprovals.findIndex((item) => item.requestId === normalizedEntry.requestId);
      if (existingIndex >= 0) {
        state.pendingApprovals[existingIndex] = {
          ...state.pendingApprovals[existingIndex],
          ...normalizedEntry,
        };
      } else {
        state.pendingApprovals.push(normalizedEntry);
        state.auditLog = state.auditLog.concat(
          buildAuditEntry("requested", normalizedEntry, { recordedAt: now() })
        ).slice(-MAX_APPROVAL_AUDIT_ENTRIES);
      }

      state.pendingApprovals.sort((left, right) => left.createdAt - right.createdAt);
      persist();
      return normalizedEntry;
    },

    resolvePendingApproval(requestId, result, { outcome = "" } = {}) {
      const normalizedRequestId = normalizeNonEmptyString(requestId);
      if (!normalizedRequestId) {
        return false;
      }

      const entry = state.pendingApprovals.find((item) => item.requestId === normalizedRequestId);
      if (!entry) {
        return false;
      }

      const normalizedResult = normalizeApprovalResult(result);
      state.pendingApprovals = state.pendingApprovals.filter((item) => item.requestId !== normalizedRequestId);
      state.auditLog = state.auditLog.concat(
        buildAuditEntry("resolved", entry, {
          recordedAt: now(),
          decision: normalizedResult?.decision || null,
          outcome: normalizeNonEmptyString(outcome) || null,
        })
      ).slice(-MAX_APPROVAL_AUDIT_ENTRIES);
      persist();
      return true;
    },
  };

  function listPendingApprovals() {
    const pruneResult = pruneExpiredApprovals(state, { now: now(), staleAfterMs });
    if (pruneResult.changed) {
      state = pruneResult.state;
      persist();
    }
    return state.pendingApprovals.slice();
  }

  function persist() {
    writeApprovalStateFile(state, { fsImpl, env });
  }
}

function resolveApprovalStatePath(options = {}) {
  return path.join(resolveRemodexStateDir(options), APPROVAL_STATE_FILE);
}

function readApprovalStateFile({ fsImpl = fs, ...options } = {}) {
  const targetPath = resolveApprovalStatePath(options);
  if (!fsImpl.existsSync(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(fsImpl.readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
}

function writeApprovalStateFile(value, { fsImpl = fs, ...options } = {}) {
  const targetPath = resolveApprovalStatePath(options);
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.writeFileSync(targetPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fsImpl.chmodSync(targetPath, 0o600);
  } catch {
    // Best-effort only on filesystems without POSIX mode support.
  }
}

function pruneExpiredApprovals(state, { now, staleAfterMs }) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeStaleAfterMs = Math.max(1, Number(staleAfterMs) || (24 * 60 * 60 * 1000));
  const expiredEntries = [];
  const pendingApprovals = [];

  for (const entry of state.pendingApprovals) {
    if ((safeNow - entry.createdAt) >= safeStaleAfterMs) {
      expiredEntries.push(entry);
    } else {
      pendingApprovals.push(entry);
    }
  }

  if (expiredEntries.length === 0) {
    return { state, changed: false };
  }

  return {
    state: {
      ...state,
      pendingApprovals,
      auditLog: state.auditLog.concat(
        expiredEntries.map((entry) => buildAuditEntry("expired", entry, {
          recordedAt: safeNow,
          outcome: "stale_timeout",
        }))
      ).slice(-MAX_APPROVAL_AUDIT_ENTRIES),
    },
    changed: true,
  };
}

function normalizeApprovalState(value) {
  const pendingApprovals = Array.isArray(value?.pendingApprovals)
    ? value.pendingApprovals.map(normalizePendingApprovalEntry).filter(Boolean)
    : [];
  const auditLog = Array.isArray(value?.auditLog)
    ? value.auditLog.map(normalizeAuditEntry).filter(Boolean).slice(-MAX_APPROVAL_AUDIT_ENTRIES)
    : [];

  return {
    bridgeSessionId: normalizeNonEmptyString(value?.bridgeSessionId),
    pendingApprovals,
    auditLog,
  };
}

function normalizePendingApprovalEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const requestId = normalizeNonEmptyString(value.requestId || value.requestID || value.id);
  const method = normalizeNonEmptyString(value.method);
  const createdAt = Number(value.createdAt);
  if (!requestId || !method || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }

  return compactObject({
    requestId,
    method,
    params: readObject(value.params) || null,
    threadId: normalizeNonEmptyString(value.threadId),
    turnId: normalizeNonEmptyString(value.turnId),
    command: normalizeNonEmptyString(value.command),
    reason: normalizeNonEmptyString(value.reason),
    createdAt,
  });
}

function normalizeApprovalResult(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return compactObject({
    decision: normalizeNonEmptyString(value.decision),
  });
}

function normalizeAuditEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const action = normalizeNonEmptyString(value.action);
  const requestId = normalizeNonEmptyString(value.requestId);
  const method = normalizeNonEmptyString(value.method);
  const recordedAt = Number(value.recordedAt);
  if (!action || !requestId || !method || !Number.isFinite(recordedAt) || recordedAt <= 0) {
    return null;
  }

  return compactObject({
    action,
    requestId,
    method,
    threadId: normalizeNonEmptyString(value.threadId),
    turnId: normalizeNonEmptyString(value.turnId),
    decision: normalizeNonEmptyString(value.decision),
    outcome: normalizeNonEmptyString(value.outcome),
    recordedAt,
  });
}

function buildAuditEntry(action, approval, { recordedAt, decision = null, outcome = null } = {}) {
  return compactObject({
    action,
    requestId: approval.requestId,
    method: approval.method,
    threadId: approval.threadId,
    turnId: approval.turnId,
    decision,
    outcome,
    recordedAt,
  });
}

function compactObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (entryValue == null) {
        return false;
      }
      if (typeof entryValue === "string") {
        return entryValue.trim().length > 0;
      }
      return true;
    })
  );
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

module.exports = {
  createBridgeApprovalStateStore,
  resolveApprovalStatePath,
};
