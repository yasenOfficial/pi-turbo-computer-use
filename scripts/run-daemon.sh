#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v cargo >/dev/null 2>&1; then
  CARGO="$(command -v cargo)"
elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO="$HOME/.cargo/bin/cargo"
else
  echo "cargo not found (looked for cargo and ~/.cargo/bin/cargo)" >&2
  exit 1
fi

# Use repository defaults unless an explicit config path was supplied.
export COMPUTER_USE_CONFIG="${COMPUTER_USE_CONFIG-$ROOT/config/default.toml}"
cd "$ROOT"
# Release is the normal hot path; debug remains explicit for development.
case "${COMPUTER_USE_BUILD_PROFILE:-release}" in
  release) exec "$CARGO" run --release --manifest-path "$ROOT/daemon/Cargo.toml" -- "$@" ;;
  debug) exec "$CARGO" run --manifest-path "$ROOT/daemon/Cargo.toml" -- "$@" ;;
  *) echo "COMPUTER_USE_BUILD_PROFILE must be release or debug" >&2; exit 1 ;;
esac
