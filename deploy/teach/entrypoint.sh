#!/bin/sh
set -eu

mkdir -p /var/lib/spacetimedb /app/backend/.local_store

spacetime start \
  --listen-addr 0.0.0.0:3000 \
  --data-dir /var/lib/spacetimedb \
  --non-interactive \
  --page_pool_max_size 268435456 &
stdb_pid=$!

python3 - <<'PY'
import socket
import sys
import time

for _ in range(90):
    try:
        socket.create_connection(("127.0.0.1", 3000), 2).close()
        sys.exit(0)
    except OSError:
        time.sleep(1)
sys.exit("classroom database did not start")
PY

spacetime publish articulate-classroom \
  --server local \
  --module-path /app/spacetimedb \
  --yes=skip-login \
  --break-clients

python3 - <<'PY'
import json
import time
from pathlib import Path

def token_from_config() -> str:
    path = Path("/root/.config/spacetime/cli.toml")
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("spacetimedb_token"):
            continue
        raw = line.split("=", 1)[1].strip().strip('"').strip("'")
        if " " not in raw and raw.count(".") == 2 and len(raw) > 20:
            return raw
    return ""

token = ""
for _ in range(20):
    token = token_from_config()
    if token:
        break
    time.sleep(1)

if not token:
    raise SystemExit("classroom publisher token was not created")

Path("/app/backend/.local_store/classroom_owner.json").write_text(
    json.dumps(
        {
            "token": token,
            "database": "articulate-classroom",
            "uri": "http://127.0.0.1:3000",
        }
    ),
    encoding="utf-8",
)
PY

/opt/classroom/bin/uvicorn app.classroom.serve:app --app-dir /app/backend --host 127.0.0.1 --port 8000 &
api_pid=$!

stop() {
  kill "$stdb_pid" "$api_pid" 2>/dev/null || true
}
trap stop TERM INT

nginx -g 'daemon off;' &
nginx_pid=$!
wait "$nginx_pid"
stop
