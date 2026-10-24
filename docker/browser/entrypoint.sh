#!/bin/bash
set -euo pipefail
umask 077
export DISPLAY=:99 HOME=/home/browser XDG_RUNTIME_DIR=/run/user/browser
mkdir -p "$HOME/profile" "$HOME/Downloads" "$XDG_RUNTIME_DIR"
chmod 0700 "$HOME" "$XDG_RUNTIME_DIR"
# This is a new, disposable container-only Firefox profile, never a host
# profile. Disable first-run onboarding/new-tab feeds before browser launch:
# those can replace the intended page and invalidate live accessibility IDs.
printf '%s\n' \
  'user_pref("accessibility.force_disabled", -1);' \
  'user_pref("browser.aboutwelcome.enabled", false);' \
  'user_pref("browser.startup.homepage_override.mstone", "ignore");' \
  'user_pref("startup.homepage_override_url", "about:blank");' \
  'user_pref("startup.homepage_welcome_url", "about:blank");' \
  'user_pref("startup.homepage_welcome_url.additional", "");' \
  'user_pref("browser.shell.checkDefaultBrowser", false);' \
  'user_pref("browser.startup.page", 0);' \
  'user_pref("browser.startup.homepage", "about:blank");' \
  'user_pref("browser.newtabpage.enabled", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);' \
  'user_pref("browser.newtabpage.activity-stream.feeds.snippets", false);' \
  'user_pref("browser.newtabpage.activity-stream.showSponsored", false);' \
  'user_pref("browser.sessionstore.resume_from_crash", false);' \
  'user_pref("dom.ipc.processCount", 2);' \
  'user_pref("dom.ipc.processCount.webIsolated", 2);' \
  'user_pref("media.ipc.processCount", 1);' \
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);' \
  'user_pref("toolkit.telemetry.enabled", false);' \
  > "$HOME/profile/user.js"
chmod 0600 "$HOME/profile/user.js"
# Traditional VNC password authentication uses only the first eight bytes.
# Eight printable base64 characters give 48 bits of entropy; generating a long
# hex string would silently provide only 32 bits. Never log or mount the secret.
openssl rand -base64 6 > "$XDG_RUNTIME_DIR/viewer-password"
chmod 0600 "$XDG_RUNTIME_DIR/viewer-password"
exec dbus-run-session -- /usr/local/bin/browser-session
