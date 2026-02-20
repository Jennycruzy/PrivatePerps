#!/usr/bin/env bash
# ============================================================================
# run_frontend.sh — Sync IDL and start the Arcium frontend dev server
# ============================================================================
#
# PURPOSE:
#   Copies the latest IDL from `target/idl/` into the frontend source tree,
#   auto-detects the program name, and starts `yarn dev`.
#
# USAGE:
#   ./scripts/run_frontend.sh
#
# EXAMPLES:
#   ./scripts/run_frontend.sh                           # auto-detect program
#   PROGRAM_NAME=my_program ./scripts/run_frontend.sh   # explicit program
#
# ENVIRONMENT VARIABLES:
#   PROGRAM_NAME   (optional) Anchor program name. If not set, the script
#                  auto-detects from IDL files in target/idl/. Required only
#                  when multiple IDL files exist.
#
# PREREQUISITES:
#   - Run from your project root (the directory containing frontend/,
#     target/, and Anchor.toml)
#   - `arcium build` must have been run at least once (to generate IDL)
#   - Node.js and Yarn installed
#
# WHAT IT DOES:
#   1. Validates that frontend/ and target/idl/ directories exist
#   2. Auto-detects PROGRAM_NAME from IDL files (if not set)
#   3. Copies target/idl/<program>.json -> frontend/src/idl/<program>.json
#   4. Creates .env.local from .env.example if .env.local doesn't exist
#   5. Runs `yarn install --ignore-engines` then `yarn dev`
#
# OUTPUT:
#   Frontend dev server at http://localhost:3000
#
# SEE ALSO:
#   README.md -> Part 2 — Run Cycle -> 2.4 Start frontend
#   templates/frontend/.env.local.example
# ============================================================================
set -euo pipefail

# Run from your project root (where frontend/, target/, Anchor.toml live).

PROGRAM_NAME="${PROGRAM_NAME:-}"
ROOT_DIR="$(pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
IDL_DIR="$ROOT_DIR/target/idl"

if [ ! -d "$FRONTEND_DIR" ]; then
  echo "frontend directory not found: $FRONTEND_DIR"
  exit 1
fi

if [ ! -d "$IDL_DIR" ]; then
  echo "IDL directory not found: $IDL_DIR"
  echo "Run 'arcium build' first."
  exit 1
fi

if [ -z "$PROGRAM_NAME" ]; then
  mapfile -t IDL_FILES < <(find "$IDL_DIR" -maxdepth 1 -type f -name '*.json' | sort)

  if [ "${#IDL_FILES[@]}" -eq 1 ]; then
    PROGRAM_NAME="$(basename "${IDL_FILES[0]}" .json)"
    echo "Detected PROGRAM_NAME=$PROGRAM_NAME"
  elif [ "${#IDL_FILES[@]}" -eq 0 ]; then
    echo "No IDL files found in $IDL_DIR"
    echo "Run 'arcium build' first."
    exit 1
  else
    echo "Multiple IDL files found. Set PROGRAM_NAME explicitly."
    printf ' - %s\n' "${IDL_FILES[@]##*/}"
    echo "Example: PROGRAM_NAME=my_program ./scripts/run_frontend.sh"
    exit 1
  fi
fi

TARGET_IDL="$IDL_DIR/${PROGRAM_NAME}.json"
FRONTEND_IDL="$FRONTEND_DIR/src/idl/${PROGRAM_NAME}.json"

if [ ! -f "$TARGET_IDL" ]; then
  echo "Target IDL not found: $TARGET_IDL"
  echo "Run 'arcium build' or set correct PROGRAM_NAME."
  exit 1
fi

mkdir -p "$(dirname "$FRONTEND_IDL")"
cp "$TARGET_IDL" "$FRONTEND_IDL"
echo "Synced IDL: $TARGET_IDL -> $FRONTEND_IDL"

cd "$FRONTEND_DIR"

if [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local
fi

yarn install --ignore-engines
yarn dev
