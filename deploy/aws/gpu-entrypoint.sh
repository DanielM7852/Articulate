#!/usr/bin/env bash
# GPU-only container start (see deploy/aws/README-gpu.md).
#   SPARC articulation collector on 0.0.0.0:$ARTICULATION_PORT
#   phone-recognition service on 0.0.0.0:$PHONES_PORT (downloads the gated model into
#   $PHONES_MODELS_DIR once when HF_TOKEN is set; later starts reuse the mounted copy)
# Safe to run on every restart. One service crashing leaves the other running; the container exits
# (non-zero) only when both are gone, or on SIGTERM/SIGINT, which is forwarded to both.
set -uo pipefail

: "${ARTICULATION_PORT:=8010}"
: "${ARTICULATION_MODELS_DIR:=/app/models}"
export ARTICULATION_MODELS_DIR
: "${PHONES_PORT:=8020}"
: "${PHONES_MODELS_DIR:=/data/phones-models}"
: "${PHONES_ENGINES_DIR:=/data/phones-engines}"
: "${PHONES_MODEL_ID:=KoelLabs/xlsr-english-01}"
: "${PHONES_BACKEND:=auto}"
export PHONES_MODELS_DIR PHONES_ENGINES_DIR PHONES_MODEL_ID PHONES_BACKEND
PHONES_SRC="${PHONES_SRC:-/app/services/phones}"
EXPECT_FILE=/tmp/phones_expected

if [ "${1:-}" = "--healthcheck" ]; then
  if [ -f "$EXPECT_FILE" ]; then
    curl -fsS "http://127.0.0.1:${PHONES_PORT}/health" | grep -q '"ok":true'
  else
    curl -fsS "http://127.0.0.1:${ARTICULATION_PORT}/v1/articulation/models" >/dev/null
  fi
  exit $?
fi

if [ -z "${ARTICULATION_DEVICE:-}" ]; then
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    ARTICULATION_DEVICE=cuda
  else
    ARTICULATION_DEVICE=cpu
  fi
fi
export ARTICULATION_DEVICE

rm -f "$EXPECT_FILE"   # the container filesystem survives `docker restart`; drop any stale marker
art_pid=""
phones_pid=""
stopping=0
forward() {
  stopping=1
  echo "gpu-entrypoint: stopping" >&2
  [ -n "$art_pid" ] && kill -TERM "$art_pid" 2>/dev/null
  [ -n "$phones_pid" ] && kill -TERM "$phones_pid" 2>/dev/null
}
trap forward TERM INT

echo "gpu-entrypoint: articulation on 0.0.0.0:${ARTICULATION_PORT} device=${ARTICULATION_DEVICE} models=${ARTICULATION_MODELS_DIR}" >&2
(
  if [ ! -f "${ARTICULATION_MODELS_DIR}/manifest.json" ]; then
    echo "gpu-entrypoint: no prepared weights in ${ARTICULATION_MODELS_DIR}; downloading (~1.3 GB)" >&2
    python -m articulate_models prepare \
      || echo "gpu-entrypoint: model prepare failed; articulation will report unavailable" >&2
  fi
  exec python -m uvicorn articulate_models.api:app --host 0.0.0.0 --port "${ARTICULATION_PORT}" --no-access-log
) &
art_pid=$!

phones_dir="${PHONES_MODELS_DIR}/${PHONES_MODEL_ID//\//--}"
phones_ready() {
  [ -f "${phones_dir}/config.json" ] && { [ -f "${phones_dir}/model.safetensors" ] || compgen -G "${phones_dir}/*.bin" >/dev/null; }
}
if ! phones_ready && [ -z "${HF_TOKEN:-}" ]; then
  echo "gpu-entrypoint: SKIPPING phones: model missing in ${phones_dir} and HF_TOKEN is not set (articulation only)" >&2
else
  echo "gpu-entrypoint: phones on 0.0.0.0:${PHONES_PORT} models=${PHONES_MODELS_DIR} backend=${PHONES_BACKEND}" >&2
  touch "$EXPECT_FILE"
  (
    mkdir -p "${PHONES_MODELS_DIR}" "${PHONES_ENGINES_DIR}" 2>/dev/null
    if ! phones_ready; then
      echo "gpu-entrypoint: downloading ${PHONES_MODEL_ID} (~1.2 GB) into ${phones_dir}" >&2
      python "${PHONES_SRC}/scripts/download_model.py" \
        || echo "gpu-entrypoint: phone model download failed" >&2
    fi
    if phones_ready; then
      exec python -m uvicorn phones.app:app --app-dir "${PHONES_SRC}/src" \
        --host 0.0.0.0 --port "${PHONES_PORT}" --no-access-log
    fi
    echo "gpu-entrypoint: SKIPPING phones: model unavailable after download attempt (articulation keeps running)" >&2
    rm -f "$EXPECT_FILE"
  ) &
  phones_pid=$!
fi

# Supervise: stay up while either service is alive; exit when both are gone.
while true; do
  alive=0
  [ -n "$art_pid" ] && kill -0 "$art_pid" 2>/dev/null && alive=1
  [ -n "$phones_pid" ] && kill -0 "$phones_pid" 2>/dev/null && alive=1
  [ "$alive" = 0 ] && break
  sleep 2 &
  wait $! 2>/dev/null
done
[ -n "$art_pid" ] && wait "$art_pid" 2>/dev/null
[ -n "$phones_pid" ] && wait "$phones_pid" 2>/dev/null
if [ "$stopping" = 1 ]; then exit 0; fi
echo "gpu-entrypoint: both services exited; container exiting so Docker restarts it" >&2
exit 1
