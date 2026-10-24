#!/bin/bash
# Fixed, non-interactive daemon-only resume. No user-supplied PID or command.
set -euo pipefail
if [[ "$#" != 1 || "$1" != restart ]]; then exit 2; fi
pidfile=/run/user/browser/browser-session.pid
[[ -f "$pidfile" && ! -L "$pidfile" && $(stat -c %u "$pidfile") == "$(id -u)" ]] || exit 1
read -r pid < "$pidfile"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ $(stat -c %u "/proc/$pid") == "$(id -u)" ]] || exit 1
[[ $(readlink -f "/proc/$pid/exe") == /usr/bin/bash ]] || exit 1
# Ensure the destination is the actual image-owned session supervisor, not an
# arbitrary same-UID process with a substituted private pidfile.
tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq /usr/local/bin/browser-session || exit 1
daemon_pidfile=/run/user/browser/browser-daemon.pid
[[ -f "$daemon_pidfile" && ! -L "$daemon_pidfile" && $(stat -c %u "$daemon_pidfile") == "$(id -u)" ]] || exit 1
read -r daemon_pid < "$daemon_pidfile"
[[ "$daemon_pid" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ $(stat -c %u "/proc/$daemon_pid") == "$(id -u)" ]] || exit 1
[[ $(readlink -f "/proc/$daemon_pid/exe") == /usr/local/bin/pi-turbo-daemon ]] || exit 1
[[ $(awk '$1 == "PPid:" { print $2 }' "/proc/$daemon_pid/status") == "$pid" ]] || exit 1
kill -USR1 "$pid"
