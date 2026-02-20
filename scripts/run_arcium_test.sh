#!/usr/bin/env bash
# ============================================================================
# run_arcium_test.sh — Run Arcium tests with validator stability fix
# ============================================================================
#
# PURPOSE:
#   Runs `arcium test` with the same `solana-test-validator` wrapper used by
#   `run_arcium_localnet.sh`. Filters out `--warp-slot` to avoid startup
#   instability during test runs.
#
# USAGE:
#   ./scripts/run_arcium_test.sh [options]
#
# EXAMPLES:
#   ./scripts/run_arcium_test.sh                # run all tests
#   ./scripts/run_arcium_test.sh --skip-build   # skip build, run tests only
#
# OPTIONS:
#   All arguments are forwarded directly to `arcium test`.
#
# PREREQUISITES:
#   - solana-test-validator   (solana CLI installed)
#   - anchor                  (Anchor framework CLI)
#   - arcium CLI              (v0.8.3+ recommended)
#   - Docker daemon running   (for Arx node containers)
#
# WHAT IT DOES:
#   1. Locates the real `solana-test-validator` binary
#   2. Creates a temporary wrapper that strips `--warp-slot` from arguments
#   3. Puts the wrapper first in PATH so `arcium test` uses it
#   4. Runs `arcium test` with all forwarded arguments
#   5. Cleans up the temporary wrapper on exit
#
# SEE ALSO:
#   README.md -> Scripts Reference
#   run_arcium_localnet.sh  (same wrapper pattern)
# ============================================================================
set -euo pipefail

REAL_SOLANA_TEST_VALIDATOR="$(command -v solana-test-validator)"
WRAP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WRAP_DIR"
}
trap cleanup EXIT

cat > "$WRAP_DIR/solana-test-validator" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REAL_SOLANA_TEST_VALIDATOR="${REAL_SOLANA_TEST_VALIDATOR:?REAL_SOLANA_TEST_VALIDATOR is not set}"

filtered_args=()
while (($#)); do
  if [[ "$1" == "--warp-slot" ]]; then
    shift 2
    continue
  fi
  filtered_args+=("$1")
  shift
done

exec "$REAL_SOLANA_TEST_VALIDATOR" "${filtered_args[@]}"
EOF

chmod +x "$WRAP_DIR/solana-test-validator"

REAL_SOLANA_TEST_VALIDATOR="$REAL_SOLANA_TEST_VALIDATOR" PATH="$WRAP_DIR:$PATH" arcium test "$@"
