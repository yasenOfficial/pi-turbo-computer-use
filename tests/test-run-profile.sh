#!/usr/bin/env bash
# Offline launcher check; substitutes Cargo and never starts a daemon.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
mkdir "$TMP/bin"
printf '%s\n' '#!/usr/bin/env bash' 'test -f "$COMPUTER_USE_CONFIG"' 'printf "%s\n" "$@" > "$PROFILE_TEST_LOG"' > "$TMP/bin/cargo"
chmod +x "$TMP/bin/cargo"
export PATH="$TMP/bin:$PATH" PROFILE_TEST_LOG="$TMP/args" COMPUTER_USE_CONFIG="$ROOT/config/default.toml"
unset COMPUTER_USE_BUILD_PROFILE
"$ROOT/scripts/run-daemon.sh" --stdio
grep -qx -- '--release' "$TMP/args"
grep -qx -- '--stdio' "$TMP/args"
COMPUTER_USE_BUILD_PROFILE=debug "$ROOT/scripts/run-daemon.sh" --stdio
if grep -qx -- '--release' "$TMP/args"; then echo 'debug unexpectedly uses release' >&2; exit 1; fi
if COMPUTER_USE_BUILD_PROFILE=invalid "$ROOT/scripts/run-daemon.sh" >/dev/null 2>&1; then
  echo 'invalid profile was accepted' >&2; exit 1
fi
printf '%s\n' 'Launcher profile test passed: release by default, explicit debug, invalid profile rejected; no daemon or desktop input.'
