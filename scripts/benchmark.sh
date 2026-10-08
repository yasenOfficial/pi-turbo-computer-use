#!/usr/bin/env bash
set -euo pipefail

COUNT="${1:-100}"
if ! [[ "$COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 [positive-request-count]" >&2
  exit 2
fi
UID_VALUE="$(id -u)"
SOCKET_PATH="${COMPUTER_USE_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$UID_VALUE}/pi-computer.sock}"
python3 - "$SOCKET_PATH" "$COUNT" <<'PY'
import json
import socket
import statistics
import sys
import time

path, count = sys.argv[1], int(sys.argv[2])

def request(payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(30)
        client.connect(path)
        client.sendall(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        response = b""
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                raise RuntimeError("daemon closed without a complete response")
            response += chunk
    result = json.loads(response.split(b"\n", 1)[0])
    if result.get("ok") is not True:
        raise RuntimeError(f"{payload['cmd']} failed: {result}")
    return result

def measure(label, payload):
    samples = []
    for _ in range(count):
        start = time.perf_counter_ns()
        request(payload)
        samples.append((time.perf_counter_ns() - start) / 1_000_000)

    ordered = sorted(samples)
    def percentile(percent):
        return ordered[min(len(ordered) - 1, int(len(ordered) * percent))]

    print(f"{label} round trips: {count}")
    print(
        f"mean {statistics.mean(samples):.3f} ms | "
        f"median {statistics.median(samples):.3f} ms | "
        f"p95 {percentile(0.95):.3f} ms | p99 {percentile(0.99):.3f} ms"
    )

print(f"Socket: {path}")
try:
    measure("IPC ping", {"cmd": "ping"})
    # Prime the accessibility snapshot so subsequent calls measure requests
    # against a clean semantic cache rather than the initial tree traversal.
    request({"cmd": "observe"})
    measure("Cached semantic observe", {"cmd": "observe"})
except (OSError, RuntimeError, json.JSONDecodeError) as error:
    raise SystemExit(f"benchmark failed: {error}")
PY
