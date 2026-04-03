#!/usr/bin/env node
// FILE: phodex.js
// Purpose: Backward-compatible wrapper that forwards legacy `phodex up` usage to `pocketex up`.
// Layer: CLI binary
// Exports: none
// Depends on: ./pocketex

const { main } = require("./pocketex");

if (require.main === module) {
  void main();
}

module.exports = {
  main,
};
