#!/usr/bin/env node
// FILE: phodex.js
// Purpose: Backward-compatible wrapper that forwards legacy `phodex up` usage to `rimcodex up`.
// Layer: CLI binary
// Exports: none
// Depends on: ./rimcodex

const { main } = require("./rimcodex");

void main();
