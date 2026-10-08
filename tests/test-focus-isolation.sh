#!/usr/bin/env bash
# Explicit opt-in ONLY: creates test windows inside a private Xephyr + metacity.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v Xephyr >/dev/null
command -v metacity >/dev/null
command -v dbus-run-session >/dev/null
command -v xdpyinfo >/dev/null
TMP_DIR="$(mktemp -d)"
XEPHYR_PID=""
WM_PID=""
cleanup() {
  [[ -z "$WM_PID" ]] || { kill "$WM_PID" 2>/dev/null || true; wait "$WM_PID" 2>/dev/null || true; }
  [[ -z "$XEPHYR_PID" ]] || { kill "$XEPHYR_PID" 2>/dev/null || true; wait "$XEPHYR_PID" 2>/dev/null || true; }
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
# Never use inherited DISPLAY for the test; allocate a separate X socket.
for number in $(seq 190 250); do
  [[ -e "/tmp/.X11-unix/X$number" || -e "/tmp/.X$number-lock" ]] && continue
  NESTED=":$number"
  Xephyr "$NESTED" -screen 800x600 -ac -noreset >"$TMP_DIR/xephyr.log" 2>&1 &
  XEPHYR_PID=$!
  for ((attempt=0; attempt<100; attempt++)); do
    if DISPLAY="$NESTED" xdpyinfo >/dev/null 2>&1; then break; fi
    kill -0 "$XEPHYR_PID" 2>/dev/null || break
    sleep 0.05
  done
  if DISPLAY="$NESTED" xdpyinfo >/dev/null 2>&1; then break; fi
  kill "$XEPHYR_PID" 2>/dev/null || true
  wait "$XEPHYR_PID" 2>/dev/null || true
  XEPHYR_PID=""
done
[[ -n "$XEPHYR_PID" ]] || { echo "Could not start isolated Xephyr" >&2; exit 1; }
export DISPLAY="$NESTED" PI_FOCUS_ISOLATED_DISPLAY="$NESTED"
dbus-run-session -- metacity --sm-disable --no-composite >"$TMP_DIR/wm.log" 2>&1 &
WM_PID=$!
# The Rust test waits for the WM's EWMH client list; do not run all --ignored
# tests, since other ignored XTEST tests may target the user's real desktop.
if ! timeout 35s cargo test --offline --manifest-path "$ROOT/daemon/Cargo.toml" \
  isolated_wm_focus_preserves_owned_window_ids -- --ignored --exact input::focus_isolation_test::isolated_wm_focus_preserves_owned_window_ids; then
  echo "Xephyr log: $TMP_DIR/xephyr.log; WM log: $TMP_DIR/wm.log" >&2
  exit 1
fi
