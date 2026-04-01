// FILE: pairing-code.js
// Purpose: Prints a short-lived manual pairing code for the bridge bootstrap flow.
// Layer: CLI helper
// Exports: printPairingCode
// Depends on: none

function printPairingCode(pairingSession) {
  const pairingCode = formatPairingCode(pairingSession?.pairingCode);
  const expiresAt = Number(pairingSession?.expiresAt);

  console.log("\nPair this iPhone with the code below:\n");
  console.log(`  ${pairingCode}\n`);
  if (Number.isFinite(expiresAt)) {
    console.log(`Expires: ${new Date(expiresAt).toISOString()}`);
  }
  console.log("\nOpen rimcodex on your iPhone, choose \"Pair with Code\", and enter this code.\n");
}

function formatPairingCode(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!normalized) {
    return "UNAVAILABLE";
  }

  if (normalized.length <= 4) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

module.exports = {
  printPairingCode,
};
