#!/usr/bin/env bash
# Isolated Xed editor regression: no host-window input, no default daemon socket.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)

worker() {
  export GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1
  export GSETTINGS_BACKEND=memory GTK_USE_PORTAL=0
  export COMPUTER_USE_SOCKET="$PI_XED_BASE/daemon.sock" COMPUTER_USE_OVERLAY=0
  export XDG_CONFIG_HOME="$PI_XED_BASE/config" XDG_CACHE_HOME="$PI_XED_BASE/cache"
  export XDG_DATA_HOME="$PI_XED_BASE/data"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  wm_pid= xed_pid= daemon_pid=
  cleanup_inner() {
    for pid in "$daemon_pid" "$xed_pid" "$wm_pid"; do
      [[ -z "$pid" ]] || { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
    done
  }
  trap cleanup_inner EXIT
  metacity --no-composite >"$PI_XED_BASE/wm.log" 2>&1 & wm_pid=$!
  title="pi-xed-editor-$(basename "$PI_XED_BASE")"
  : >"$PI_XED_BASE/$title.txt"
  xed --standalone --new-window --geometry=980x700 "$PI_XED_BASE/$title.txt" >"$PI_XED_BASE/xed.log" 2>&1 & xed_pid=$!
  "$ROOT/daemon/target/debug/pi-turbo-daemon" >"$PI_XED_BASE/daemon.log" 2>&1 & daemon_pid=$!
  for i in $(seq 1 100); do [[ -S "$COMPUTER_USE_SOCKET" ]] && break; sleep .1; done
  [[ -S "$COMPUTER_USE_SOCKET" ]] || { echo 'FAIL: isolated daemon did not start'; return 1; }
  PI_XED_TITLE="$title" python3 - <<'PY'
import json, os, socket, time

sock = os.environ['COMPUTER_USE_SOCKET']
title = os.environ['PI_XED_TITLE']
def request(payload):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(40)
        client.connect(sock)
        client.sendall((json.dumps(payload) + '\n').encode())
        response = json.loads(client.makefile('rb').readline())
        if not response.get('ok'):
            raise RuntimeError(response)
        return response

deadline = time.monotonic() + 65
nodes = []
while time.monotonic() < deadline:
    response = request({'cmd': 'observe'})
    windows = response.get('windows', [])
    if not any(title in w.get('title', '') for w in windows):
        time.sleep(.5)
        continue
    nodes = response.get('snapshot', {}).get('nodes', [])
    by_id = {n['id']: n for n in nodes}
    editors = []
    for node in nodes:
        if node.get('role') != 'text' or node.get('visible') is False:
            continue
        ancestors = []
        parent = node.get('parent')
        while parent in by_id:
            ancestor = by_id[parent]
            ancestors.append(ancestor.get('name', ''))
            parent = ancestor.get('parent')
        if any(title in name for name in ancestors):
            editors.append(node)
    if editors:
        break
    time.sleep(.5)
else:
    raise AssertionError(f'own Xed editor absent; observed {len(nodes)} nodes, text nodes: '
                         f'{[(n.get("name"), n.get("visible")) for n in nodes if n.get("role") == "text"][:12]}')
assert len(editors) == 1, f'ambiguous owned editor: {editors}'
editor = editors[0]
assert editor.get('focused') is True, f'owned multiline editor is not focused: {editor}'
assert editor.get('value') == '', f'expected empty test document: {editor}'
print(f'Focused empty Xed editor exposed: id={editor["id"]}, nodes={len(nodes)}', flush=True)
# Revalidate the exact owned X11 title, fresh tree, and editor ancestry just before input.
fresh = request({'cmd': 'observe'})
assert any(title in w.get('title', '') for w in fresh.get('windows', []))
fresh_nodes = fresh.get('snapshot', {}).get('nodes', [])
assert any(n.get('id') == editor['id'] and n.get('focused') is True for n in fresh_nodes)
text = 'Привет, мир — українська ї'
request({'cmd': 'set_text', 'id': editor['id'], 'text': text})
updated = request({'cmd': 'observe'})
latest = updated.get('snapshot', {}).get('nodes', [])
if not latest:
    latest = [request({'cmd': 'inspect', 'id': editor['id']})['node']]
assert any(n.get('id') == editor['id'] and n.get('value') == text for n in latest), \
    f'Unicode semantic text was not reflected: {[n for n in latest if n.get("id") == editor["id"]]}'
print('PASS: isolated Xed editable text accepts and exposes Unicode')
PY
}
if [[ ${1-} == --worker ]]; then worker; exit $?; fi
for tool in Xephyr xdpyinfo dbus-run-session xed metacity python3; do
  command -v "$tool" >/dev/null || { echo "SKIP: $tool unavailable"; exit 77; }
done
if ! python3 -c 'import gi, pyatspi' >/dev/null 2>&1; then
  echo 'SKIP: Python GTK/AT-SPI bindings unavailable'; exit 77
fi
if ! xdpyinfo -display "${DISPLAY:-:0}" >/dev/null 2>&1; then
  echo 'SKIP: no host X server for nested Xephyr'; exit 77
fi
CARGO=${CARGO:-$HOME/.cargo/bin/cargo}
"$CARGO" build --manifest-path "$ROOT/daemon/Cargo.toml" >/dev/null
BASE=$(mktemp -d "${TMPDIR:-/tmp}/pi-xed-editor.XXXXXX")
chmod 700 "$BASE"
XEPHYR_PID=
cleanup() {
  [[ -z "$XEPHYR_PID" ]] || { kill "$XEPHYR_PID" 2>/dev/null || true; wait "$XEPHYR_PID" 2>/dev/null || true; }
  rm -rf -- "$BASE"
}
trap cleanup EXIT
number=93
while [[ -e "/tmp/.X${number}-lock" || -S "/tmp/.X11-unix/X${number}" ]]; do number=$((number+1)); done
Xephyr -ac -noreset -no-host-grab -screen 1100x800 ":$number" -display "${DISPLAY:-:0}" >"$BASE/xephyr.log" 2>&1 &
XEPHYR_PID=$!
for i in $(seq 1 100); do
  xdpyinfo -display ":$number" >/dev/null 2>&1 && break
  sleep .1
done
xdpyinfo -display ":$number" >/dev/null 2>&1 || { echo 'FAIL: Xephyr unavailable'; exit 1; }
DISPLAY=":$number" XAUTHORITY= PI_XED_BASE="$BASE" \
  timeout --signal=TERM --kill-after=3s 100s dbus-run-session -- bash "$0" --worker
