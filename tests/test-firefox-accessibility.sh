#!/usr/bin/env bash
# Disposable/offline Firefox AT-SPI smoke test. All profiles live in a private /tmp tree.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)

worker() {
  set -eu
  case "$PI_A11Y_MODE" in
    auto) unset GNOME_ACCESSIBILITY GTK_A11Y ;;
    gnome) export GNOME_ACCESSIBILITY=1 ;;
  esac
  xephyr_pid= browser_pid= gtk_pid=
  cleanup_worker() {
    [[ -z "$browser_pid" ]] || { kill -TERM "$browser_pid" 2>/dev/null || true; wait "$browser_pid" 2>/dev/null || true; }
    [[ -z "$gtk_pid" ]] || { kill -TERM "$gtk_pid" 2>/dev/null || true; wait "$gtk_pid" 2>/dev/null || true; }
    [[ -z "$xephyr_pid" ]] || { kill -TERM "$xephyr_pid" 2>/dev/null || true; wait "$xephyr_pid" 2>/dev/null || true; }
  }
  trap cleanup_worker EXIT
  trap 'exit 130' INT TERM

  # Pick an unused display number inside this private /tmp namespace.
  display_num=93
  while [[ -e "/tmp/.X${display_num}-lock" || -S "/tmp/.X11-unix/X${display_num}" ]]; do
    ((display_num += 1))
  done
  nested_display=":$display_num"
  # Isolate app windows on a tiny nested X server; do not touch host windows.
  Xephyr -ac -noreset -no-host-grab -screen 1x1 "$nested_display" -display "$DISPLAY" -auth "$XAUTHORITY" >/dev/null 2>&1 &
  xephyr_pid=$!
  for _ in $(seq 1 100); do
    xdpyinfo -display "$nested_display" >/dev/null 2>&1 && break
    sleep .1
  done
  if ! xdpyinfo -display "$nested_display" >/dev/null 2>&1; then
    echo 'FAIL: nested X server unavailable'; return 2
  fi
  export DISPLAY="$nested_display"
  unset XAUTHORITY

  firefox --no-remote --profile /tmp/profile "file://$PI_A11Y_PAGE" &
  browser_pid=$!
  python3 - <<'GTK' &
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk
window = Gtk.Window(title="Pi isolated GTK accessibility probe")
window.set_default_size(1, 1)
window.set_accept_focus(False)
window.set_focus_on_map(False)
window.set_skip_taskbar_hint(True)
window.set_skip_pager_hint(True)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
entry = Gtk.Entry()
entry.get_accessible().set_name("Pi GTK probe input")
button = Gtk.Button(label="Pi GTK probe button")
box.add(entry); box.add(button); window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all(); Gtk.main()
GTK
  gtk_pid=$!
  python3 - <<'PY'
import os, sys, time
import pyatspi

desktop = pyatspi.Registry.getDesktop(0)
want = {"Pi test name input", "Pi test action button",
        "Pi GTK probe input", "Pi GTK probe button"}
deadline = time.monotonic() + 30
found = set()
seen_firefox = False
last_error = None
while time.monotonic() < deadline:
    try:
        todo = [desktop]
        visited = 0
        while todo and visited < 5000:
            obj = todo.pop()
            visited += 1
            try:
                name = (obj.name or "").strip()
                role = obj.getRoleName()
                if role.lower() == "application" and "firefox" in name.lower():
                    seen_firefox = True
                if name in want:
                    found.add(name)
                for i in range(min(obj.childCount, 500)):
                    todo.append(obj[i])
            except Exception as e:
                last_error = e
        if found == want:
            if os.environ.get("PI_A11Y_EXPECT") == "diagnostic":
                print("DIAGNOSTIC PASS (non-gating): Firefox and GTK controls exposed over AT-SPI.")
            else:
                print("PASS: Firefox local-page controls and GTK probe controls are exposed over AT-SPI.")
            sys.exit(0)
    except Exception as e:
        last_error = e
    time.sleep(.5)
print("Firefox application node observed:", seen_firefox)
print("found controls:", sorted(found))
if last_error:
    print("last AT-SPI error:", type(last_error).__name__, str(last_error)[:160])
gtk_controls = {"Pi GTK probe input", "Pi GTK probe button"}
if os.environ.get("PI_A11Y_EXPECT") == "diagnostic" and gtk_controls <= found:
    if seen_firefox and want <= found:
        print("DIAGNOSTIC PASS (non-gating): force0 Firefox and GTK controls exposed.")
    else:
        print("INCONCLUSIVE/UNAVAILABLE (non-gating): GTK probe works, Firefox AT-SPI tree unavailable in force0 case.")
    sys.exit(0)
print("FAIL: required Firefox/GTK controls not all discoverable over AT-SPI.")
sys.exit(1)
PY
}

if [[ ${1-} == --worker ]]; then
  worker
  exit $?
fi
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --matrix ) ]]; then
  echo "Usage: $0 [--matrix]" >&2; exit 2
fi
matrix=0
[[ ${1-} == --matrix ]] && matrix=1

BWRAP=$(command -v bwrap || true)
FIREFOX=$(command -v firefox || true)
DBUS_RUN=$(command -v dbus-run-session || true)
XEPHYR=$(command -v Xephyr || true)
XDPY=$(command -v xdpyinfo || true)
AUTH_SOURCE=${XAUTHORITY:-$HOME/.Xauthority}
HOST_DISPLAY=${DISPLAY:-:0}
DISPLAY_NUM=${HOST_DISPLAY##*:}; DISPLAY_NUM=${DISPLAY_NUM%%.*}
if [[ -z "$FIREFOX" ]]; then
  echo 'SKIP: Firefox is not installed/on PATH.'; exit 77
fi
if [[ -z "$BWRAP" || -z "$DBUS_RUN" || -z "$XEPHYR" || -z "$XDPY" ]] || ! python3 -c 'import gi, pyatspi' >/dev/null 2>&1; then
  echo 'SKIP: requires bwrap, dbus-run-session, Xephyr, xdpyinfo, PyGObject, and pyatspi.'; exit 77
fi
if [[ ! -r "$AUTH_SOURCE" || ! -S "/tmp/.X11-unix/X$DISPLAY_NUM" ]]; then
  echo 'SKIP: cannot access the current X11 socket/auth for the isolated nested display.'; exit 77
fi
if ! "$BWRAP" --unshare-net --ro-bind / / --dev-bind /dev /dev --proc /proc /bin/true >/dev/null 2>&1; then
  echo 'SKIP: bubblewrap network namespace unavailable; refusing non-isolated browser test.'; exit 77
fi

BASE=$(mktemp -d "${TMPDIR:-/tmp}/pi-firefox-a11y.XXXXXX")
chmod 700 "$BASE"
trap 'rm -rf -- "$BASE"' EXIT INT TERM
cat > "$BASE/page.html" <<'HTML'
<!doctype html><html lang="en"><meta charset="utf-8"><title>Pi isolated accessibility check</title>
<body><h1>Local accessibility test</h1>
<label for="test-input">Pi test name input</label><input id="test-input" type="text">
<button type="button">Pi test action button</button></body></html>
HTML

run_case() {
  local name=$1 pref=$2 activation=$3 dir="$BASE/$1"
  mkdir -m 700 "$dir" "$dir/home" "$dir/runtime" "$dir/config" "$dir/cache" "$dir/profile" "$dir/.X11-unix"
  chmod 700 "$dir/runtime"
  touch "$dir/.X11-unix/X$DISPLAY_NUM"
  cp "$AUTH_SOURCE" "$dir/Xauthority"; chmod 600 "$dir/Xauthority"
  cp "$BASE/page.html" "$dir/page.html"
  cat > "$dir/profile/user.js" <<PREFS
user_pref("accessibility.force_disabled", $pref);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("app.update.enabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.prefetch-next", false);
user_pref("network.http.speculative-parallel-limit", 0);
PREFS
  echo "CASE $name (accessibility.force_disabled=$pref, activation=$activation)"
  "$BWRAP" --unshare-net --ro-bind / / --bind "$dir" /tmp \
    --ro-bind "/tmp/.X11-unix/X$DISPLAY_NUM" "/tmp/.X11-unix/X$DISPLAY_NUM" \
    --dev-bind /dev /dev --proc /proc --clearenv \
    --setenv PATH /usr/bin:/bin --setenv HOME /tmp/home --setenv TMPDIR /tmp \
    --setenv XDG_CONFIG_HOME /tmp/config --setenv XDG_CACHE_HOME /tmp/cache \
    --setenv XDG_RUNTIME_DIR /tmp/runtime --setenv GSETTINGS_BACKEND memory \
    --setenv DISPLAY "$HOST_DISPLAY" --setenv XAUTHORITY /tmp/Xauthority \
    --setenv GTK_MODULES gail:atk-bridge --setenv GTK_USE_PORTAL 0 \
    --setenv PI_A11Y_MODE "$activation" --setenv PI_A11Y_PAGE /tmp/page.html \
    --setenv PI_A11Y_EXPECT "${PI_A11Y_EXPECT:-required}" \
    -- dbus-run-session -- /bin/bash "$ROOT/tests/test-firefox-accessibility.sh" --worker
}

status=0
run_case automatic -1 auto || status=1
if (( matrix )); then
  run_case gnome-accessibility -1 gnome || status=1
  echo 'CASE force0-diagnostic (non-gating; outcome may be inconclusive/unavailable)'
  PI_A11Y_EXPECT=diagnostic run_case force0-diagnostic 0 auto || status=1
fi
if (( status )); then echo 'RESULT: a gating isolated Firefox accessibility case failed.'; exit 1; fi
echo 'RESULT: all gating isolated Firefox accessibility checks passed.'
