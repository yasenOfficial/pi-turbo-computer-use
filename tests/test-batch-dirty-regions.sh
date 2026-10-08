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

if [[ -z "${DAEMON_BIN:-}" ]]; then
  "$CARGO" build --manifest-path "$ROOT/daemon/Cargo.toml"
  DAEMON_BIN="$ROOT/daemon/target/debug/pi-turbo-daemon"
fi
if [[ -n "${XDG_RUNTIME_DIR:-}" && -d "$XDG_RUNTIME_DIR" && -w "$XDG_RUNTIME_DIR" ]]; then
  TMP_DIR="$(mktemp -d "$XDG_RUNTIME_DIR/pi-computer-batch.XXXXXX")"
else
  TMP_DIR="$(mktemp -d)"
fi
SOCKET="$TMP_DIR/daemon.sock"
DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

export COMPUTER_USE_SOCKET="$SOCKET"
"$DAEMON_BIN" >"$TMP_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
# Wait for the isolated socket before any request; never retry desktop input.
for ((attempt = 0; attempt < 240; attempt++)); do
  [[ -S "$SOCKET" ]] && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "Test daemon exited during startup" >&2; exit 1; }
  sleep 0.05
done
[[ -S "$SOCKET" ]] || { echo "Test daemon startup timed out" >&2; exit 1; }
cd "$ROOT"
# The test only sends input to its uniquely titled, spawned Zenity window and
# is bounded so a stuck GUI/daemon cannot leave the test or daemon running.
timeout --foreground --signal=TERM --kill-after=3s 60s node "$ROOT/tests/test-batch-dirty-regions.mjs"
