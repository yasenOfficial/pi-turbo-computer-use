#!/bin/bash
# Fixed migration-only entrypoint. Only a private, initially empty named volume
# is mounted. Archive bytes are streamed from Docker CLI stdin, never logged.
set -euo pipefail
umask 077
profile=/home/browser/profile
[[ "$#" == 0 && -d "$profile" && ! -L "$profile" ]] || exit 1
[[ $(stat -c %u:%g "$profile") == "$(id -u):$(id -g)" ]] || exit 1
[[ -z $(find "$profile" -mindepth 1 -maxdepth 1 -print -quit) ]] || exit 1
tar --extract --file - --directory "$profile" --no-same-owner --no-same-permissions --no-overwrite-dir >/dev/null 2>&1
# The legacy image always created this settings file. An archive without it is
# not a complete legacy profile; never authorize removal of its source.
[[ -f "$profile/user.js" && ! -L "$profile/user.js" ]] || exit 1
# Firefox process locks cannot be reused by a newly created container. Leave
# all other profile contents, including cookies and SQLite WAL, untouched.
for lock in lock .parentlock parent.lock; do
  [[ ! -d "$profile/$lock" ]] || exit 1
  rm -f -- "$profile/$lock"
done
