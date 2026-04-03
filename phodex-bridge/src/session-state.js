// FILE: session-state.js
// Purpose: Persists the latest active pocketex thread so the user can reopen it on the Mac for handoff.
// Layer: CLI helper
// Exports: rememberActiveThread, openLastActiveThread, readLastActiveThread
// Depends on: fs, os, path, child_process

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".pocketex");
const STATE_FILE_NAME = "last-thread.json";
const DEFAULT_BUNDLE_ID = "com.openai.codex";

function rememberActiveThread(threadId, source) {
  if (!threadId || typeof threadId !== "string") {
    return false;
  }

  const payload = {
    threadId,
    source: source || "unknown",
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(resolveStateDir(), { recursive: true });
  fs.writeFileSync(resolveStateFile(), JSON.stringify(payload, null, 2));
  return true;
}

function openLastActiveThread({ bundleId = DEFAULT_BUNDLE_ID } = {}) {
  const state = readState();
  const threadId = state?.threadId;
  if (!threadId) {
    throw new Error("No remembered pocketex thread found yet.");
  }

  const targetUrl = `codex://threads/${threadId}`;
  execFileSync("open", ["-b", bundleId, targetUrl], { stdio: "ignore" });
  return state;
}

function readState() {
  const stateFile = resolveStateFile();
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  const raw = fs.readFileSync(stateFile, "utf8");
  return JSON.parse(raw);
}

function resolveStateDir() {
  return DEFAULT_STATE_DIR;
}

function resolveStateFile() {
  return path.join(resolveStateDir(), STATE_FILE_NAME);
}

module.exports = {
  rememberActiveThread,
  openLastActiveThread,
  readLastActiveThread: readState,
};
