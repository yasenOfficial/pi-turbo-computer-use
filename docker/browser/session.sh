#!/bin/bash
set -euo pipefail
umask 077
export DISPLAY=:99 HOME=/home/browser XDG_RUNTIME_DIR=/run/user/browser XDG_SESSION_TYPE=x11 MOZ_ACCESSIBILITY_ENABLED=1
Xvfb :99 -nolisten tcp -screen 0 1280x800x24 -ac >/dev/null 2>&1 &
xpid=$!
# This file lives in container-private tmpfs, never the host IPC mount.
printf '%s\n' "$$" > "$XDG_RUNTIME_DIR/browser-session.pid"
cleanup() {
  kill "${fp:-}" "${dp:-}" "${wp:-}" "${vp:-}" "${op:-}" "$xpid" 2>/dev/null || :
  wait 2>/dev/null || :
  rm -f -- "$XDG_RUNTIME_DIR/browser-session.pid" "$XDG_RUNTIME_DIR/browser-daemon.pid"
}
trap cleanup EXIT
restart_requested=0
restart_daemon() {
  # Only a signal to this exact supervisor may authorize replacing its child.
  # An unexpected daemon exit remains terminal, never an automatic restart.
  if kill -0 "${dp:-0}" 2>/dev/null; then
    restart_requested=1
    kill -TERM "$dp" 2>/dev/null || restart_requested=0
  fi
}
trap restart_daemon USR1
for attempt in {1..50}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  kill -0 "$xpid" 2>/dev/null || exit 1
  sleep 0.1
done
xdpyinfo -display :99 >/dev/null 2>&1
openbox >/dev/null 2>&1 & op=$!
# Enable the private container AT-SPI registry *before* Firefox starts. Do not
# suppress failure into a silently inaccessible browser. All D-Bus calls use
# dbus-run-session's private session bus, never the host's session bus.
for property in IsEnabled ScreenReaderEnabled; do
  gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
    --method org.freedesktop.DBus.Properties.Set org.a11y.Status "$property" '<true>' \
    >/dev/null 2>&1
done
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -passwdfile "$XDG_RUNTIME_DIR/viewer-password" -quiet >/dev/null 2>&1 & vp=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 & wp=$!
firefox-esr --no-remote --profile "$HOME/profile" about:blank >/dev/null 2>&1 & fp=$!
# Other child exits are terminal. Only an explicit supervisor signal permits
# a daemon-only restart without touching Firefox, Xvfb, VNC or the viewer.
while :; do
  /usr/local/bin/pi-turbo-daemon >/dev/null 2>&1 & dp=$!
  printf '%s\n' "$dp" > "$XDG_RUNTIME_DIR/browser-daemon.pid"
  wait -n "$xpid" "$dp" "$vp" "$wp" "$fp" "$op" || :
  rm -f -- "$XDG_RUNTIME_DIR/browser-daemon.pid"
  if (( !restart_requested )); then exit 1; fi
  restart_requested=0
  wait "$dp" 2>/dev/null || :
  for critical in "$xpid" "$vp" "$wp" "$fp" "$op"; do
    kill -0 "$critical" 2>/dev/null || exit 1
  done
done
