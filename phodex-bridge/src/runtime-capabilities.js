// FILE: runtime-capabilities.js
// Purpose: Safely probes the local Codex runtime so the phone can rely on bridge-owned compatibility flags.
// Layer: CLI service support
// Exports: cached runtime capability reader
// Depends on: child_process, util

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 30_000;

function createBridgeRuntimeCapabilitiesReader({
  sendCodexRequest,
  canReadLocalCodexVersion = true,
  execFileAsyncImpl = execFileAsync,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  let cachedSnapshot = null;
  let cachedAt = 0;
  let inflightRead = null;

  return {
    invalidate() {
      cachedSnapshot = null;
      cachedAt = 0;
      inflightRead = null;
    },
    async readSnapshot({ force = false } = {}) {
      const currentTime = now();
      if (!force && cachedSnapshot && currentTime - cachedAt < cacheTtlMs) {
        return cachedSnapshot;
      }

      if (inflightRead) {
        return inflightRead;
      }

      inflightRead = probeRuntimeCapabilities({
        sendCodexRequest,
        canReadLocalCodexVersion,
        execFileAsyncImpl,
        now,
      }).then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedAt = currentTime;
        return snapshot;
      }).finally(() => {
        inflightRead = null;
      });

      return inflightRead;
    },
  };
}

async function probeRuntimeCapabilities({
  sendCodexRequest,
  canReadLocalCodexVersion,
  execFileAsyncImpl,
  now,
}) {
  const [
    planCollaborationMode,
    serviceTier,
    threadFork,
    codexVersion,
  ] = await Promise.all([
    probePlanCollaborationMode(sendCodexRequest),
    probeServiceTierSupport(sendCodexRequest),
    probeThreadForkSupport(sendCodexRequest),
    readLocalCodexVersion({
      canReadLocalCodexVersion,
      execFileAsyncImpl,
    }),
  ]);

  return {
    codexVersion,
    probedAt: now(),
    capabilities: {
      planCollaborationMode,
      serviceTier,
      threadFork,
    },
  };
}

async function probePlanCollaborationMode(sendCodexRequest) {
  try {
    const response = await sendCodexRequest("collaborationMode/list", null);
    return responseContainsPlanCollaborationMode(response);
  } catch (error) {
    if (isUnsupportedMethodError(error, ["collaborationmode/list", "collaboration mode"])) {
      return false;
    }
    return null;
  }
}

async function probeServiceTierSupport(sendCodexRequest) {
  try {
    await sendCodexRequest("thread/start", {
      serviceTier: "fast",
    });
    return true;
  } catch (error) {
    if (isUnsupportedServiceTierError(error)) {
      return false;
    }
    if (isSupportedMethodValidationError(error, ["thread/start", "thread start"])) {
      return true;
    }
    return null;
  }
}

async function probeThreadForkSupport(sendCodexRequest) {
  try {
    await sendCodexRequest("thread/fork", {});
    return true;
  } catch (error) {
    if (isUnsupportedMethodError(error, ["thread/fork", "thread fork"])) {
      return false;
    }
    if (isSupportedMethodValidationError(error, ["thread/fork", "thread fork"])) {
      return true;
    }
    return null;
  }
}

async function readLocalCodexVersion({
  canReadLocalCodexVersion,
  execFileAsyncImpl,
}) {
  if (!canReadLocalCodexVersion) {
    return null;
  }

  try {
    const result = await execFileAsyncImpl("codex", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return normalizeCodexVersion(result?.stdout);
  } catch {
    return null;
  }
}

function responseContainsPlanCollaborationMode(response) {
  const candidateArrays = [
    readArray(response),
    readArray(response?.modes),
    readArray(response?.collaborationModes),
    readArray(response?.collaboration_modes),
    readArray(response?.items),
    readArray(response?.data),
  ];

  for (const candidateArray of candidateArrays) {
    if (!candidateArray) {
      continue;
    }
    for (const entry of candidateArray) {
      const modeName = readString(entry?.mode)
        || readString(entry?.name)
        || readString(entry?.id)
        || readString(entry);
      if (modeName === "plan") {
        return true;
      }
    }
  }

  return false;
}

function isUnsupportedServiceTierError(error) {
  const message = normalizeErrorMessage(error);
  if (!message) {
    return false;
  }

  const mentionsServiceTier = message.includes("servicetier")
    || message.includes("service tier");

  if (!mentionsServiceTier) {
    return false;
  }

  if (isUnsupportedMethodError(error, ["thread/start", "thread start"])) {
    return false;
  }

  return message.includes("unknown field")
    || message.includes("unexpected field")
    || message.includes("unrecognized field")
    || message.includes("invalid param")
    || message.includes("invalid params")
    || message.includes("failed to parse")
    || message.includes("unsupported");
}

function isSupportedMethodValidationError(error, methodHints) {
  const code = Number(error?.code);
  if (code === -32601) {
    return false;
  }

  const message = normalizeErrorMessage(error);
  if (!message) {
    return false;
  }

  if (isUnsupportedMethodError(error, methodHints)) {
    return false;
  }

  return message.includes("invalid param")
    || message.includes("invalid params")
    || message.includes("missing")
    || message.includes("required")
    || message.includes("thread not found")
    || message.includes("unknown thread")
    || message.includes("failed to parse");
}

function isUnsupportedMethodError(error, methodHints) {
  const code = Number(error?.code);
  if (code === -32601) {
    return true;
  }

  const message = normalizeErrorMessage(error);
  if (!message) {
    return false;
  }

  const mentionsUnsupportedMethod = message.includes("method not found")
    || message.includes("unknown method")
    || message.includes("not implemented")
    || message.includes("does not support")
    || message.includes("unsupported");
  const mentionsHint = methodHints.some((hint) => message.includes(hint));

  return mentionsUnsupportedMethod && mentionsHint;
}

function normalizeCodexVersion(value) {
  const trimmed = readString(value);
  if (!trimmed) {
    return null;
  }

  const versionMatch = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return versionMatch ? versionMatch[0] : trimmed;
}

function normalizeErrorMessage(error) {
  return readString(error?.message).toLowerCase();
}

function readArray(value) {
  return Array.isArray(value) ? value : null;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  createBridgeRuntimeCapabilitiesReader,
};
