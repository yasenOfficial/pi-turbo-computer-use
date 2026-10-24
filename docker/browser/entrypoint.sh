#!/bin/bash
set -euo pipefail
umask 077
export DISPLAY=:99 HOME=/home/browser XDG_RUNTIME_DIR=/run/user/browser
mkdir -p "$HOME/profile" "$HOME/Downloads" "$XDG_RUNTIME_DIR"
chmod 0700 "$HOME" "$XDG_RUNTIME_DIR"
# This dedicated, Docker-managed profile persists across container recreation;
# it is never a host browser profile. Fail closed if a volume is misowned.
[[ -d "$HOME/profile" && ! -L "$HOME/profile" && $(stat -c %u:%g "$HOME/profile") == "$(id -u):$(id -g)" ]] || exit 1
chmod 0700 "$HOME/profile"
# Never follow a profile-controlled user.js symlink onto another mount.
if [[ -L "$HOME/profile/user.js" || ( -e "$HOME/profile/user.js" && ! -f "$HOME/profile/user.js" ) ]]; then exit 1; fi
# Disable first-run onboarding/new-tab feeds before browser launch:
# those can replace the intended page and invalidate live accessibility IDs.
printf '%s\n' \
  'user_pref("accessibility.force_disabled", -1);' \
  'user_pref("browser.aboutwelcome.enabled", false);' \
  'user_pref("browser.startup.homepage_override.mstone", "ignore");' \
  'user_pref("startup.homepage_override_url", "about:blank");' \
  'user_pref("startup.homepage_welcome_url", "about:blank");' \
  'user_pref("startup.homepage_welcome_url.additional", "");' \
  'user_pref("browser.shell.checkDefaultBrowser", false);' \
  'user_pref("browser.startup.page", 3);' \
  'user_pref("browser.startup.homepage", "about:blank");' \
  'user_pref("browser.newtabpage.enabled", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.snippets", false);' \
  'user_pref("browser.newtabpage.activity-stream.showSponsored", false);' \
  'user_pref("browser.sessionstore.resume_from_crash", true);' \
  'user_pref("browser.sessionstore.max_resumed_crashes", 5);' \
  'user_pref("dom.ipc.processCount", 2);' \
  'user_pref("dom.ipc.processCount.webIsolated", 2);' \
  'user_pref("media.ipc.processCount", 1);' \
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);' \
  'user_pref("toolkit.telemetry.enabled", false);' \
  > "$HOME/profile/user.js"
chmod 0600 "$HOME/profile/user.js"
# PID 1 forwards Docker's TERM to the fixed, private browser supervisor so
# Firefox gets a chance to write sessionstore before Docker's stop deadline.
dbus-run-session -- /usr/local/bin/browser-session &
buspid=$!
shutdown() {
  trap '' TERM INT
  local pidfile="$XDG_RUNTIME_DIR/browser-session.pid" pid attempt notified=0
  for attempt in {1..20}; do
    [[ -f "$pidfile" && ! -L "$pidfile" ]] && break
    sleep 0.1
  done
  if [[ -f "$pidfile" && ! -L "$pidfile" && $(stat -c %u "$pidfile") == "$(id -u)" ]]; then
    read -r pid < "$pidfile"
    if [[ "$pid" =~ ^[1-9][0-9]*$ && $(stat -c %u "/proc/$pid" 2>/dev/null) == "$(id -u)" ]] &&
       [[ $(readlink -f "/proc/$pid/exe" 2>/dev/null) == /usr/bin/bash ]] &&
       tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq /usr/local/bin/browser-session; then
      if kill -TERM "$pid" 2>/dev/null; then notified=1; fi
    fi
  fi
  # Leave the private D-Bus alive until Firefox has flushed its profile. If
  # supervisor identity cannot be verified, terminate only our direct child.
  if (( !notified )); then kill -TERM "$buspid" 2>/dev/null || :; fi
  wait "$buspid" 2>/dev/null || :
  exit 0
}
trap shutdown TERM INT
# Propagate an unplanned browser-session failure to Docker instead of
# reporting a healthy exit (which would conceal a dead viewer).
wait "$buspid"
