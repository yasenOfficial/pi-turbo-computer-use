#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v cargo >/dev/null 2>&1; then
  CARGO="$(command -v cargo)"
elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO="$HOME/.cargo/bin/cargo"
else
  echo "cargo not found (looked for cargo and ~/.cargo/bin/cargo)" >&2
  exit 1
fi

DEST_DIR="${PI_TURBO_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST_DIR"
"$CARGO" build --release --manifest-path "$ROOT/daemon/Cargo.toml"
install -m 0755 "$ROOT/daemon/target/release/pi-turbo-daemon" "$DEST_DIR/pi-turbo-daemon"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-computer"
mkdir -p "$CONFIG_DIR"
if [[ ! -e "$CONFIG_DIR/config.toml" ]]; then
  install -m 0644 "$ROOT/config/default.toml" "$CONFIG_DIR/config.toml"
  printf 'Installed default config %s\n' "$CONFIG_DIR/config.toml"
fi
printf 'Installed %s\n' "$DEST_DIR/pi-turbo-daemon"
if [[ ":$PATH:" != *":$DEST_DIR:"* ]]; then
  printf 'Add this to PATH if needed: export PATH="%s:$PATH"\n' "$DEST_DIR"
fi
