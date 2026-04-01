#!/usr/bin/env bash

# FILE: run-local-rimcodex.sh
# Purpose: Rebranded wrapper for the local relay + bridge developer utility.
# Layer: developer utility
# Exports: none
# Depends on: ./run-local-remodex.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${ROOT_DIR}/run-local-remodex.sh" "$@"
