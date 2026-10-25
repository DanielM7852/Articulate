#!/usr/bin/env bash
# Single-container start for the RunPod image (see deploy/runpod/README.md).
# 1. SPARC articulation collector on 127.0.0.1:$ARTICULATION_PORT (internal only, never exposed).
# 2. FastAPI app (API + built frontend) on $HOST:$PORT.
# SIGTERM/SIGINT are forwarded to both. The API's exit decides the container's; a collector
# crash only disables background articulation analysis (the backend treats it as unavailable).
set -uo pipefail

: "${HOST:=0.0.0.0}"
: "${PORT:=8000}"
: "${ARTICULATION_PORT:=8010}"
: "${ARTICULATION_MODELS_DIR:=/app/models}"
export ARTICULATION_MODELS_DIR

# The collector reads ARTICULATION_DEVICE (cpu|cuda). Default to cuda only when a GPU is visible.
if [ -z "${ARTICULATION_DEVICE:-}" ]; then
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    ARTICULATION_DEVICE=cuda
  else
    ARTICULATION_DEVICE=cpu
  fi
fi
export ARTICULATION_DEVICE

api_pid=""
art_pid=""
forward() {
  echo "entrypoint: stopping" >&2
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null
  [ -n "$art_pid" ] && kill -TERM "$art_pid" 2>/dev/null
}
trap forward TERM INT

echo "entrypoint: articulation on 127.0.0.1:${ARTICULATION_PORT} device=${ARTICULATION_DEVICE} models=${ARTICULATION_MODELS_DIR}" >&2
(
  # An image built with PREPARE_MODELS=0 downloads the weights once into the (network) volume instead.
  if [ ! -f "${ARTICULATION_MODELS_DIR}/manifest.json" ]; then
    echo "entrypoint: no prepared weights in ${ARTICULATION_MODELS_DIR}; downloading (~1.3 GB)" >&2
    python -m articulate_models prepare \
      || echo "entrypoint: model prepare failed; articulation will report unavailable" >&2
  fi
  exec python -m uvicorn articulate_models.api:app --host 127.0.0.1 --port "${ARTICULATION_PORT}" --no-access-log
) &
art_pid=$!

cd /app/backend || exit 1
python -m uvicorn app.main:app --host "${HOST}" --port "${PORT}" \
  --proxy-headers --forwarded-allow-ips='*' &
api_pid=$!

wait "$api_pid"
status=$?
# `wait` returns early (status > 128) when a trapped signal arrives; keep waiting for the real exit.
while kill -0 "$api_pid" 2>/dev/null; do
  wait "$api_pid"
  status=$?
done
kill -TERM "$art_pid" 2>/dev/null
wait "$art_pid" 2>/dev/null
exit "$status"
