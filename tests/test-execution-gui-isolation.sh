#!/usr/bin/env bash
# Offline browser/desktop replay, ONLY inside a new PID/network namespace and Xephyr.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ ${1-} == --worker ]]; then
  # Refuse direct invocation on the host, even when called with --worker.
  [[ "${DISPLAY-}" == "${PI_EXECUTION_PRIVATE_DISPLAY-}" && "${DISPLAY-}" == :[0-9]* \
     && "${HOME-}" == /tmp/home && "${XDG_RUNTIME_DIR-}" == /tmp/runtime \
     && -S "/tmp/.X11-unix/X${DISPLAY#:}" && ! -e /tmp/.X11-unix/X0 \
     && ! -e /run/user/"$(id -u)"/bus && ! -e /run/user/"$(id -u)"/keyring \
     && ! -e "$(dirname "$ROOT")/.ssh" && -z "${XAUTHORITY-}" \
     && -z "${SSH_AUTH_SOCK-}" && -z "${GNOME_KEYRING_CONTROL-}" ]] || {
    echo 'FAIL: execution GUI fixture is not on its private display/home/runtime' >&2; exit 1;
  }
  exec python3 "$ROOT/tests/execution-gui-fixture.py"
fi
[[ $# == 0 ]] || { echo 'Usage: tests/test-execution-gui-isolation.sh' >&2; exit 2; }
for cmd in bwrap dbus-run-session Xephyr xdpyinfo metacity wmctrl python3 xed cargo timeout; do
  command -v "$cmd" >/dev/null || { echo "SKIP: missing $cmd" >&2; exit 77; }
done
python3 -c 'import pyatspi,gi' >/dev/null 2>&1 || { echo 'SKIP: missing private AT-SPI support' >&2; exit 77; }
BROWSER=$(command -v firefox || command -v brave-browser || command -v brave-browser-stable || true)
[[ -n "$BROWSER" ]] || { echo 'SKIP: isolated fixture browser not found' >&2; exit 77; }
HOST_DISPLAY=${DISPLAY:-:0}
xdpyinfo -display "$HOST_DISPLAY" >/dev/null 2>&1 || { echo 'SKIP: host X server needed only as nested Xephyr parent' >&2; exit 77; }
bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / / --tmpfs /home --tmpfs /run \
  --dev-bind /dev /dev --proc /proc /bin/true >/dev/null 2>&1 || {
  echo 'SKIP: network/PID namespaces unavailable; never fall back to live desktop/network' >&2; exit 77;
}
# Compile exactly the current *working tree* offline, not an unverified installed release.
cargo build --offline --locked --manifest-path "$ROOT/daemon/Cargo.toml" >/dev/null 2>&1 || {
  echo 'FAIL: offline native working-tree build unavailable' >&2; exit 1;
}
DAEMON_BIN="$ROOT/daemon/target/debug/pi-turbo-daemon"
[[ -x "$DAEMON_BIN" ]] || { echo 'FAIL: native executable absent' >&2; exit 1; }
BASE=$(mktemp -d /tmp/pi-execution-gui.XXXXXXXX)
chmod 700 "$BASE"
mkdir -m 700 "$BASE/.X11-unix" "$BASE/home" "$BASE/runtime" "$BASE/config" "$BASE/cache" "$BASE/data"
XEPHYR_PID=
cleanup() {
  if [[ -n "$XEPHYR_PID" ]]; then kill "$XEPHYR_PID" 2>/dev/null || :; wait "$XEPHYR_PID" 2>/dev/null || :; fi
  rm -rf -- "$BASE"
}
trap cleanup EXIT
# Xephyr alone connects to the parent display. The GUI worker sees only the
# test-owned nested socket, never the host X socket or host Xauthority.
NESTED=
for number in $(seq 190 250); do
  [[ -e /tmp/.X11-unix/X$number || -e /tmp/.X$number-lock ]] && continue
  Xephyr -ac -noreset -no-host-grab -screen 1100x800 ":$number" >"$BASE/xephyr.log" 2>&1 &
  XEPHYR_PID=$!
  for ((i=0; i<100; i++)); do
    if kill -0 "$XEPHYR_PID" 2>/dev/null && xdpyinfo -display ":$number" >/dev/null 2>&1; then
      NESTED=":$number"; break
    fi
    kill -0 "$XEPHYR_PID" 2>/dev/null || break
    sleep .05
  done
  [[ -n "$NESTED" ]] && break
  kill "$XEPHYR_PID" 2>/dev/null || :; wait "$XEPHYR_PID" 2>/dev/null || :; XEPHYR_PID=
done
[[ -n "$NESTED" ]] || { echo 'SKIP: private Xephyr could not start' >&2; exit 77; }
touch "$BASE/.X11-unix/X${NESTED#:}"
# Mask personal HOME and /run before remounting ONLY this checkout as readable.
# /tmp and its private home/runtime/profile are test-owned. The single exposed
# X socket is Xephyr's nested display, not the parent's display.
CODE=$(command -v code || true)
[[ "$CODE" == /usr/* || "$CODE" == /opt/* ]] || CODE=
bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / / \
  --tmpfs /home --dir "$(dirname "$ROOT")" --ro-bind "$ROOT" "$ROOT" \
  --tmpfs /run --bind "$BASE" /tmp \
  --ro-bind "/tmp/.X11-unix/X${NESTED#:}" "/tmp/.X11-unix/X${NESTED#:}" \
  --dev-bind /dev /dev --proc /proc --clearenv \
  --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 \
  --setenv HOME /tmp/home --setenv TMPDIR /tmp --setenv XDG_RUNTIME_DIR /tmp/runtime \
  --setenv DISPLAY "$NESTED" --setenv PI_EXECUTION_PRIVATE_DISPLAY "$NESTED" \
  --setenv GSETTINGS_BACKEND memory --setenv GTK_USE_PORTAL 0 \
  --setenv PI_EXECUTION_ROOT "$ROOT" --setenv PI_EXECUTION_BROWSER "$BROWSER" \
  --setenv PI_EXECUTION_DAEMON "$DAEMON_BIN" --setenv PI_EXECUTION_CODE "$CODE" \
  -- timeout --signal=TERM --kill-after=5s 160s dbus-run-session -- \
  bash "$ROOT/tests/test-execution-gui-isolation.sh" --worker
