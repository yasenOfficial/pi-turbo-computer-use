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

"$CARGO" build --manifest-path "$ROOT/daemon/Cargo.toml"
TMP_DIR="$(mktemp -d)"
SOCKET="$TMP_DIR/daemon.sock"
DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
COMPUTER_USE_SOCKET="$SOCKET" "$ROOT/daemon/target/debug/pi-turbo-daemon" >"$TMP_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

python3 - "$SOCKET" <<'PY'
import json
import socket
import sys
import time

path = sys.argv[1]
last_error = None
for _ in range(100):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(path)
            client.sendall(b'{"cmd":"ping"}\n')
            response = b""
            while b"\n" not in response:
                chunk = client.recv(4096)
                if not chunk:
                    raise RuntimeError("daemon closed without a response")
                response += chunk
        parsed = json.loads(response.split(b"\n", 1)[0])
        assert parsed.get("ok") is True, parsed
        print("IPC smoke test passed: ping returned ok=true (no desktop input performed)")
        break
    except (FileNotFoundError, ConnectionRefusedError, TimeoutError, OSError) as error:
        last_error = error
        time.sleep(0.05)
else:
    raise SystemExit(f"daemon did not become ready: {last_error}")
PY
