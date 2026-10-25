#!/bin/bash
set -euo pipefail
umask 077
export DISPLAY=:99 HOME=/home/browser XDG_RUNTIME_DIR=/run/user/browser XDG_SESSION_TYPE=x11 MOZ_ACCESSIBILITY_ENABLED=1
Xvfb :99 -nolisten tcp -screen 0 1280x800x24 -ac >/dev/null 2>&1 &
xpid=$!
# This file lives in container-private tmpfs, never the host IPC mount.
printf '%s\n' "$$" > "$XDG_RUNTIME_DIR/browser-session.pid"
cleanup() {
  # WM_DELETE_WINDOW is the desktop's normal close request, not SIGTERM.
  # This targets only Firefox-class windows on the private :99 display and
  # gives its profile/sessionstore a chance to flush while X11 + D-Bus live.
  if [[ -n "${fp:-}" ]] && kill -0 "$fp" 2>/dev/null; then
    /usr/local/bin/browser-close >/dev/null 2>&1 || :
    for attempt in {1..120}; do
      kill -0 "$fp" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$fp" 2>/dev/null; then
      printf 'browser-session: Firefox window did not close; session recovery may be needed\n' >&2
      kill -TERM "$fp" 2>/dev/null || :
      for attempt in {1..30}; do
        kill -0 "$fp" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if kill -0 "$fp" 2>/dev/null; then
      printf 'browser-session: Firefox did not exit within grace period; session recovery may be needed\n' >&2
      kill -KILL "$fp" 2>/dev/null || :
    fi
  fi
  for child in "${dp:-}" "${rp:-}" "${wp:-}" "${vp:-}" "${op:-}" "$xpid"; do
    [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null || :
  done
  for attempt in {1..20}; do
    alive=0
    for child in "${dp:-}" "${rp:-}" "${wp:-}" "${vp:-}" "${op:-}" "$xpid"; do
      [[ -z "$child" ]] || { kill -0 "$child" 2>/dev/null && alive=1 || :; }
    done
    (( alive )) || break
    sleep 0.1
  done
  for child in "${dp:-}" "${rp:-}" "${wp:-}" "${vp:-}" "${op:-}" "$xpid"; do
    [[ -n "$child" ]] && kill -KILL "$child" 2>/dev/null || :
  done
  wait 2>/dev/null || :
  rm -f -- "$XDG_RUNTIME_DIR/browser-session.pid" "$XDG_RUNTIME_DIR/browser-daemon.pid"
}
trap cleanup EXIT
trap 'exit 0' TERM INT
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
# An enabled bridge uses only the private /ipc socket; it never opens a host
# X socket or receives host DISPLAY/XAUTHORITY. It is a critical child.
if [[ -n "${COMPUTER_USE_CLIPBOARD_BRIDGE:-}" ]]; then
  /usr/local/bin/pi-turbo-daemon --clipboard-bridge-relay "$COMPUTER_USE_CLIPBOARD_BRIDGE" >/dev/null 2>&1 & rp=$!
fi
# No VNC password: the viewer is explicitly unauthenticated. Docker publishes
# 6080 on host 127.0.0.1 only; VNC itself is container-loopback only.
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet >/dev/null 2>&1 & vp=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 & wp=$!
# Do not pass a URL: doing so can replace/restack Firefox's saved tabs.
firefox-esr --no-remote --profile "$HOME/profile" >/dev/null 2>&1 & fp=$!
# Other child exits are terminal. Only an explicit supervisor signal permits
# a daemon-only restart without touching Firefox, Xvfb, VNC or the viewer.
while :; do
  /usr/local/bin/pi-turbo-daemon >/dev/null 2>&1 & dp=$!
  printf '%s\n' "$dp" > "$XDG_RUNTIME_DIR/browser-daemon.pid"
  ended= status=0
  critical=("$xpid" "$dp" "$vp" "$wp" "$fp" "$op")
  [[ -z "${rp:-}" ]] || critical+=("$rp")
  wait -n -p ended "${critical[@]}" || status=$?
  rm -f -- "$XDG_RUNTIME_DIR/browser-daemon.pid"
  if (( !restart_requested )); then
    role=unknown
    case "$ended" in
      "$xpid") role=xvfb ;; "$dp") role=daemon ;; "$rp") role=clipboard-bridge-relay ;; "$vp") role=vnc ;;
      "$wp") role=viewer ;; "$fp") role=firefox ;; "$op") role=window-manager ;;
    esac
    # Fixed metadata only: no page URLs, titles, profile paths or stderr.
    printf 'browser-session: %s exited (status %s)\n' "$role" "$status" >&2
    exit 1
  fi
  restart_requested=0
  wait "$dp" 2>/dev/null || :
  for critical in "$xpid" "${rp:-}" "$vp" "$wp" "$fp" "$op"; do
    kill -0 "$critical" 2>/dev/null || exit 1
  done
done
