#!/usr/bin/env bash
# ============================================================================
# run_arcium_localnet.sh — Start Arcium localnet with validator stability fix
# ============================================================================
#
# PURPOSE:
#   Starts a local Solana validator + Arx MPC nodes via `arcium localnet`,
#   but wraps `solana-test-validator` to filter out the `--warp-slot` argument
#   which causes startup instability on some environments.
#
# USAGE:
#   ./scripts/run_arcium_localnet.sh [options]
#
# EXAMPLES:
#   ./scripts/run_arcium_localnet.sh --skip-build    # skip arcium build step
#   ./scripts/run_arcium_localnet.sh                  # full build + localnet
#
# OPTIONS:
#   All arguments are forwarded directly to `arcium localnet`.
#   Common: --skip-build  Skip the arcium build step before starting.
#
# PREREQUISITES:
#   - solana-test-validator   (solana CLI installed)
#   - arcium CLI              (v0.8.3+ recommended)
#   - Docker daemon running   (for Arx node containers)
#
# WHAT IT DOES:
#   1. Locates the real `solana-test-validator` binary
#   2. Creates a temporary wrapper that strips `--warp-slot` from arguments
#   3. Puts the wrapper first in PATH so `arcium localnet` uses it
#   4. Runs `arcium localnet` with all forwarded arguments
#   5. Cleans up the temporary wrapper on exit
#
# READINESS:
#   Wait for these messages before proceeding:
#     "Solana localnet is online"
#     "Primary cluster nodes are online"
#     "Solana localnet & Arx nodes are online"
#
# SEE ALSO:
#   README.md -> Part 2 — Run Cycle -> 2.1 Start localnet
#   TROUBLESHOOTING.md -> 1.1 Localnet startup timeout
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

REAL_SOLANA_TEST_VALIDATOR="$REAL_SOLANA_TEST_VALIDATOR" PATH="$WRAP_DIR:$PATH" arcium localnet "$@"
