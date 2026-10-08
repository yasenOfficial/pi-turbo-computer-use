#!/usr/bin/env bash
# Disposable Brave/Xephyr/AT-SPI/GIO matrix. Never connect the daemon to the host display.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ ${1:-} == --worker ]]; then
  exec python3 "$ROOT/tests/brave-isolation-worker.py"
fi
[[ $# == 0 ]] || { echo "Usage: $0" >&2; exit 2; }
for tool in bwrap dbus-run-session Xephyr xdpyinfo metacity wmctrl xprop timeout python3; do
  command -v "$tool" >/dev/null || { echo "SKIP: missing $tool"; exit 77; }
done
BRAVE=$(command -v brave-browser || command -v brave-browser-stable || true)
python3 -c 'import pyatspi,gi;gi.require_version("Gtk", "3.0");from gi.repository import Gtk' >/dev/null 2>&1 || { echo 'SKIP: Python GTK/AT-SPI bindings unavailable'; exit 77; }
case ${PI_BRAVE_A11Y_MODE:-plain} in plain|bridge) ;; *) echo 'Usage: PI_BRAVE_A11Y_MODE=plain|bridge' >&2; exit 2;; esac
[[ -n "$BRAVE" ]] || { echo 'SKIP: Brave unavailable'; exit 77; }
[[ -x "$BRAVE" ]] || { echo 'SKIP: Brave not executable'; exit 77; }
DAEMON_BIN=${DAEMON_BIN:-$ROOT/daemon/target/release/pi-turbo-daemon}
[[ -x "$DAEMON_BIN" ]] || { echo "SKIP: daemon not built: $DAEMON_BIN (build release first or set DAEMON_BIN)"; exit 77; }
HOST_DISPLAY=${DISPLAY:-:0}
xdpyinfo -display "$HOST_DISPLAY" >/dev/null 2>&1 || { echo 'SKIP: X11 host needed for nested Xephyr'; exit 77; }
# Only a tested network namespace may run the browser. No fallback to a live network.
bwrap --unshare-net --ro-bind / / --dev-bind /dev /dev --proc /proc /bin/true >/dev/null 2>&1 || {
  echo 'SKIP: bubblewrap network namespace unavailable'; exit 77;
}
BASE=$(mktemp -d "${TMPDIR:-/tmp}/pi-brave-isolation.XXXXXXXX")
chmod 700 "$BASE"
# Make the sole host X socket reachable from inside the private /tmp mount.
mkdir -m 700 "$BASE/.X11-unix"
num=${HOST_DISPLAY##*:}; num=${num%%.*}
[[ "$num" =~ ^[0-9]+$ && -S /tmp/.X11-unix/X$num ]] || { rm -rf -- "$BASE"; echo 'SKIP: host X socket unavailable'; exit 77; }
touch "$BASE/.X11-unix/X$num"
AUTH=${XAUTHORITY:-$HOME/.Xauthority}
if [[ -n "${XAUTHORITY:-}" && ! -r "$AUTH" ]]; then rm -rf -- "$BASE"; echo 'SKIP: Xauthority unavailable'; exit 77; fi
if [[ -r "$AUTH" ]]; then cp "$AUTH" "$BASE/Xauthority"; chmod 600 "$BASE/Xauthority"; fi
cleanup() {
  if [[ ${PI_BRAVE_KEEP_LOGS:-0} == 1 ]]; then echo "Isolated logs: $BASE"; else rm -rf -- "$BASE"; fi
}
trap cleanup EXIT
# Clear inherited browser/DBus/AT-SPI settings. /tmp is private, including its X11
# sockets; only the host Xephyr backing socket is explicitly rebound, read-only.
# --unshare-pid ensures GIO-spawned browsers cannot outlive the test namespace.
set +e
bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / / --bind "$BASE" /tmp \
  --ro-bind "/tmp/.X11-unix/X$num" "/tmp/.X11-unix/X$num" \
  --dev-bind /dev /dev --proc /proc --clearenv \
  --setenv PATH /usr/bin:/bin --setenv HOME /tmp/home --setenv TMPDIR /tmp \
  --setenv DISPLAY "$HOST_DISPLAY" --setenv XAUTHORITY /tmp/Xauthority \
  --setenv DAEMON_BIN "$DAEMON_BIN" --setenv PI_BRAVE_BIN "$BRAVE" \
  --setenv PI_BRAVE_FORCE_A11Y "${PI_BRAVE_FORCE_A11Y:-0}" \
  --setenv PI_BRAVE_A11Y_MODE "${PI_BRAVE_A11Y_MODE:-plain}" \
  --setenv PI_BRAVE_BROWSER_GTK_MODULES "${PI_BRAVE_BROWSER_GTK_MODULES:-1}" \
  --setenv PI_BRAVE_CASE "${PI_BRAVE_CASE:-}" \
  --setenv PI_BRAVE_TEST_ROOT "$ROOT" --setenv PI_BRAVE_HOST_NUM "$num" \
  --setenv GSETTINGS_BACKEND memory --setenv GTK_USE_PORTAL 0 \
  -- timeout --signal=TERM --kill-after=5s 650s dbus-run-session -- bash "$ROOT/tests/test-brave-desktop-isolation.sh" --worker
rc=$?
set -e
echo "Brave isolated matrix exit: $rc"
exit "$rc"
