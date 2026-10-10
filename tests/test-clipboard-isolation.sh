#!/usr/bin/env bash
# Clipboard fixture uses a fresh, test-owned nested X server only. Never reads
# or writes the inherited desktop's selection, HOME, runtime sockets or keys.
# All GUI/DBus children run in a private PID/network/mount namespace.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ${1-} == --editor-worker || ${1-} == --fallback-worker || ${1-} == --bg-editor-worker ]]; then
  # The command must not be runnable with inherited host credentials or with
  # the host X socket visible. No GUI fixture starts if any guard fails.
  [[ "${DISPLAY-}" == "${PI_CLIPBOARD_PRIVATE_DISPLAY-}" && "${DISPLAY-}" == :[0-9]* \
     && "${PI_CLIPBOARD_TEST_TMP-}" == /tmp && "${HOME-}" == /tmp/home \
     && "${XDG_RUNTIME_DIR-}" == /tmp/runtime \
     && -S "/tmp/.X11-unix/X${DISPLAY#:}" \
     && ! -e /tmp/.X11-unix/X0 && ! -e /run/user/"$UID"/keyring \
     && ! -e "$(dirname "$ROOT")/.config" \
     && -z "${SSH_AUTH_SOCK-}" && -z "${GNOME_KEYRING_CONTROL-}" \
     && -z "${XAUTHORITY-}" && -z "${WAYLAND_DISPLAY-}" ]] || {
    echo 'FAIL: clipboard GUI worker is not isolated; no desktop fixture started' >&2
    exit 1
  }
  export GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1
  export GSETTINGS_BACKEND=memory GTK_USE_PORTAL=0 COMPUTER_USE_OVERLAY=0
  export COMPUTER_USE_SOCKET="$PI_CLIPBOARD_TEST_TMP/${1#--}-daemon.sock"
  export XDG_CONFIG_HOME="$PI_CLIPBOARD_TEST_TMP/config" XDG_CACHE_HOME="$PI_CLIPBOARD_TEST_TMP/cache"
  export XDG_DATA_HOME="$PI_CLIPBOARD_TEST_TMP/data"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  PI_CLIPBOARD_TITLE="pi-clipboard-fixture-$(basename "$PI_CLIPBOARD_TEST_TMP")"
  [[ ${1-} == --editor-worker || ${1-} == --bg-editor-worker ]] || PI_CLIPBOARD_TITLE="pi-clipboard-tk-$(basename "$PI_CLIPBOARD_TEST_TMP")"
  export PI_CLIPBOARD_TITLE
  metacity --no-composite >"$PI_CLIPBOARD_TEST_TMP/wm.log" 2>&1 & wm_pid=$!
  if [[ ${1-} == --bg-editor-worker ]]; then
    [[ "$DISPLAY" == "$PI_CLIPBOARD_PRIVATE_DISPLAY" ]] || { echo 'FAIL: BG fixture display mismatch'; exit 1; }
    setxkbmap -display "$DISPLAY" -layout us,bg -option ''
    export PI_CLIPBOARD_TEST_BG=1
  else
    unset PI_CLIPBOARD_TEST_BG
  fi
  if [[ ${1-} == --fallback-worker ]]; then
    python3 "$ROOT/tests/clipboard-fixture.py" --tk-editor >"$PI_CLIPBOARD_TEST_TMP/tk.log" 2>&1 & editor_pid=$!
  else
    : >"$PI_CLIPBOARD_TEST_TMP/$PI_CLIPBOARD_TITLE.txt"
    xed --standalone --new-window "$PI_CLIPBOARD_TEST_TMP/$PI_CLIPBOARD_TITLE.txt" >"$PI_CLIPBOARD_TEST_TMP/xed.log" 2>&1 & editor_pid=$!
  fi
  "$ROOT/daemon/target/debug/pi-turbo-daemon" >"$PI_CLIPBOARD_TEST_TMP/daemon.log" 2>&1 & daemon_pid=$!
  trap 'kill "$daemon_pid" "$editor_pid" "$wm_pid" 2>/dev/null || :; wait "$daemon_pid" "$editor_pid" "$wm_pid" 2>/dev/null || :' EXIT
  for ((i=0; i<100; i++)); do [[ -S "$COMPUTER_USE_SOCKET" ]] && break; sleep .1; done
  [[ -S "$COMPUTER_USE_SOCKET" ]] || { echo 'FAIL: isolated daemon socket unavailable'; exit 1; }
  fixture_mode="${1#--}"
  [[ "$fixture_mode" != bg-editor-worker ]] || fixture_mode=editor-worker
  if ! python3 "$ROOT/tests/clipboard-fixture.py" "$fixture_mode"; then
    for log in daemon.log xed.log tk.log wm.log; do
      echo "---- $log ----" >&2
      [[ ! -e "$PI_CLIPBOARD_TEST_TMP/$log" ]] || tail -n 20 "$PI_CLIPBOARD_TEST_TMP/$log" >&2 || :
    done
    exit 1
  fi
  exit
fi
for cmd in Xephyr xdpyinfo cargo timeout bwrap; do
  command -v "$cmd" >/dev/null || { echo "SKIP: $cmd unavailable"; exit 77; }
done
# Fail closed: never run the GUI workers on the host's DBus/runtime/HOME.
if ! bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / / \
    --dev-bind /dev /dev --proc /proc /bin/true >/dev/null 2>&1; then
  echo 'SKIP: bubblewrap PID/network isolation unavailable; no unisolated GUI fallback' >&2
  exit 77
fi
TMP_DIR="$(mktemp -d /tmp/pi-clipboard-fixture.XXXXXXXX)"
chmod 700 "$TMP_DIR"
mkdir -m 700 "$TMP_DIR/.X11-unix" "$TMP_DIR/home" "$TMP_DIR/runtime" "$TMP_DIR/config" "$TMP_DIR/cache" "$TMP_DIR/data"
NESTED=""
PID=""
cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || :; wait "$PID" 2>/dev/null || :; fi
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT
# DISPLAY is used by Xephyr solely as its parent window. The test process gets
# only NESTED, never a fallback to the parent if nested setup fails.
for number in $(seq 190 250); do
  [[ -e "/tmp/.X11-unix/X$number" || -e "/tmp/.X$number-lock" ]] && continue
  NESTED=":$number"
  Xephyr "$NESTED" -screen 800x600 -ac -noreset >"$TMP_DIR/xephyr.log" 2>&1 &
  PID=$!
  for ((i=0; i<100; i++)); do
    if DISPLAY="$NESTED" xdpyinfo >/dev/null 2>&1; then break; fi
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.05
  done
  if DISPLAY="$NESTED" xdpyinfo >/dev/null 2>&1; then break; fi
  kill "$PID" 2>/dev/null || :
  wait "$PID" 2>/dev/null || :
  PID=""
done
[[ -n "$PID" ]] || { echo "SKIP: could not start private Xephyr"; exit 77; }
export DISPLAY="$NESTED" PI_CLIPBOARD_PRIVATE_DISPLAY="$NESTED" XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
timeout 45s cargo test --offline --locked --manifest-path "$ROOT/daemon/Cargo.toml" \
  clipboard::tests::isolated_snapshot_incr_utf8_binary_restore_and_new_owner -- --ignored --exact
for cmd in dbus-run-session xed metacity python3; do
  command -v "$cmd" >/dev/null || { echo "SKIP: editor fixture ($cmd unavailable)"; exit 77; }
done
if ! python3 -c 'import gi, pyatspi' >/dev/null 2>&1; then
  echo 'SKIP: editor fixture (GTK/AT-SPI bindings unavailable)'; exit 77
fi
cargo build --offline --locked --manifest-path "$ROOT/daemon/Cargo.toml"
# Only the Xephyr socket for NESTED is visible inside the worker's /tmp.
# Mask the host's /home and /run (profiles, keyring, XDG_RUNTIME_DIR, agent
# sockets), then remount this checkout read-only for the fixture and daemon.
number=${NESTED#:}
[[ $number =~ ^[0-9]+$ && -S /tmp/.X11-unix/X$number ]] || {
  echo 'FAIL: private Xephyr socket missing' >&2; exit 1;
}
touch "$TMP_DIR/.X11-unix/X$number"
worker() {
  local mode=$1 duration=$2
  bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / / \
    --tmpfs /home --dir "$(dirname "$ROOT")" --ro-bind "$ROOT" "$ROOT" \
    --tmpfs /run --bind "$TMP_DIR" /tmp \
    --ro-bind "/tmp/.X11-unix/X$number" "/tmp/.X11-unix/X$number" \
    --dev-bind /dev /dev --proc /proc --clearenv \
    --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 \
    --setenv HOME /tmp/home --setenv TMPDIR /tmp --setenv XDG_RUNTIME_DIR /tmp/runtime \
    --setenv DISPLAY "$NESTED" --setenv PI_CLIPBOARD_PRIVATE_DISPLAY "$NESTED" \
    --setenv PI_CLIPBOARD_TEST_TMP /tmp --setenv XDG_SESSION_TYPE x11 \
    --setenv GIO_USE_VFS local --setenv GIO_USE_VOLUME_MONITOR unix \
    --setenv GSETTINGS_BACKEND memory --setenv GTK_USE_PORTAL 0 \
    -- timeout "$duration" dbus-run-session -- bash "$ROOT/tests/test-clipboard-isolation.sh" "$mode"
}
worker --editor-worker 105s
if python3 -c 'import tkinter' >/dev/null 2>&1; then
  worker --fallback-worker 45s
  if command -v setxkbmap >/dev/null && python3 -c 'import ctypes; ctypes.CDLL("libX11.so.6").XkbLockGroup' >/dev/null 2>&1; then
    worker --bg-editor-worker 105s
  else
    echo 'SKIP: Bulgarian-group fixture (private XKB setup unavailable)'
  fi
else
  echo 'SKIP: declared-focus fallback fixture (tkinter unavailable)'
fi
