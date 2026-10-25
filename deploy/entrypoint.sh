#!/usr/bin/env bash
# Single-container start for the RunPod image (see deploy/runpod/README.md).
# 1. SPARC articulation collector on 127.0.0.1:$ARTICULATION_PORT (internal only, never exposed).
# 2. Phone-recognition service on 127.0.0.1:$PHONES_PORT (internal only; the backend relays /phones/*).
#    Downloads the gated model into $PHONES_MODELS_DIR once when HF_TOKEN is set.
# 3. FastAPI app (API + built frontend) on $HOST:$PORT.
# SIGTERM/SIGINT are forwarded to all. The API's exit decides the container's; a collector or phones
# crash only disables that feature (the backend treats it as unavailable).
set -uo pipefail

: "${HOST:=0.0.0.0}"
: "${PORT:=8000}"
: "${ARTICULATION_PORT:=8010}"
: "${ARTICULATION_MODELS_DIR:=/app/models}"
export ARTICULATION_MODELS_DIR
: "${PHONES_PORT:=8020}"
: "${PHONES_MODELS_DIR:=/workspace/phones-models}"
: "${PHONES_ENGINES_DIR:=/workspace/phones-engines}"
: "${PHONES_MODEL_ID:=KoelLabs/xlsr-english-01}"
export PHONES_MODELS_DIR PHONES_ENGINES_DIR PHONES_MODEL_ID
PHONES_SRC="${PHONES_SRC:-/app/services/phones}"

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
phones_pid=""
forward() {
  echo "entrypoint: stopping" >&2
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null
  [ -n "$art_pid" ] && kill -TERM "$art_pid" 2>/dev/null
  [ -n "$phones_pid" ] && kill -TERM "$phones_pid" 2>/dev/null
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

# Phones: the model dir is models_dir/<model id with / -> -->. Download needs HF_TOKEN (gated model).
phones_dir="${PHONES_MODELS_DIR}/${PHONES_MODEL_ID//\//--}"
phones_ready() {
  [ -f "${phones_dir}/config.json" ] && { [ -f "${phones_dir}/model.safetensors" ] || compgen -G "${phones_dir}/*.bin" >/dev/null; }
}
if ! phones_ready && [ -z "${HF_TOKEN:-}" ]; then
  echo "entrypoint: phone model missing in ${phones_dir} and HF_TOKEN is not set; phones not started (/phones returns 503, app shows basic view)" >&2
else
  echo "entrypoint: phones on 127.0.0.1:${PHONES_PORT} models=${PHONES_MODELS_DIR}" >&2
  (
    if ! phones_ready; then
      echo "entrypoint: downloading ${PHONES_MODEL_ID} (~1.2 GB) into ${phones_dir}" >&2
      python "${PHONES_SRC}/scripts/download_model.py" \
        || echo "entrypoint: phone model download failed" >&2
    fi
    if phones_ready; then
      exec python -m uvicorn phones.app:app --app-dir "${PHONES_SRC}/src" \
        --host 127.0.0.1 --port "${PHONES_PORT}" --no-access-log
    fi
    echo "entrypoint: phone model unavailable; phones not started" >&2
  ) &
  phones_pid=$!
fi

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
if [ -n "$phones_pid" ]; then
  kill -TERM "$phones_pid" 2>/dev/null
  wait "$phones_pid" 2>/dev/null
fi
exit "$status"
