#!/usr/bin/env node
// FILE: remodex.js
// Purpose: Backward-compatible wrapper that forwards legacy `remodex` usage to `rimcodex`.
// Layer: CLI binary
// Exports: none
// Depends on: ./rimcodex

const { main } = require("./rimcodex");

void main();
