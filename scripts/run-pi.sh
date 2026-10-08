#!/usr/bin/env bash
# Explicit extension loading from any working directory; no desktop action or daemon startup.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pi >/dev/null 2>&1; then
  echo 'Pi CLI not found on PATH.' >&2
  exit 1
fi
exec pi --extension "$ROOT/.pi/extensions/computer-use/index.ts" "$@"
