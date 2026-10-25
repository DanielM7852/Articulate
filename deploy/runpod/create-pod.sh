#!/usr/bin/env bash
# One-shot: create the Articulate GPU pod through the RunPod REST API (POST /v1/pods).
# Usage:
#   RUNPOD_API_KEY=... IMAGE=<dockerhub-user>/articulate:<tag> deploy/runpod/create-pod.sh
#   Private GHCR image: also set REGISTRY_AUTH_ID=<RunPod container registry auth id> (see README).
#   DRY_RUN=1 ... prints the request body without calling the API.
# Secrets are referenced as {{ RUNPOD_SECRET_<name> }}; create them first in the RunPod console
# (Secrets): anthropic_api_key, cartesia_api_key, openai_api_key, hf_token, resend_api_key, spacetime_token
# (plus azure_speech_key when AZURE_SPEECH_REGION is set). Port 8020 (phones) is never exposed. See deploy/runpod/README.md for what each variable does.
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (RunPod console > Settings > API Keys)}"
: "${IMAGE:?set IMAGE, e.g. <dockerhub-user>/articulate:<tag>}"
NAME="${NAME:-articulate}"
# Comma-separated RunPod GPU type ids, tried in order of availability.
GPU_TYPES="${GPU_TYPES:-NVIDIA GeForce RTX 4090,NVIDIA GeForce RTX 3090}"
CLOUD_TYPE="${CLOUD_TYPE:-COMMUNITY}"       # COMMUNITY or SECURE
CONTAINER_DISK_GB="${CONTAINER_DISK_GB:-30}"
VOLUME_GB="${VOLUME_GB:-10}"                # pod volume at /workspace; survives stop/start
# The image is built on CUDA 12.8; only place it on hosts whose driver supports that.
CUDA_VERSIONS="${CUDA_VERSIONS:-12.8,12.9,13.0}"

json_list() {
  printf '%s' "$1" | awk -F, '{for (i = 1; i <= NF; i++) { gsub(/^ +| +$/, "", $i); printf "%s\"%s\"", (i > 1 ? "," : ""), $i }}'
}

# Optional env entries. A RunPod secret reference to a secret that doesn't exist can break pod creation,
# so the Azure pair is added only when AZURE_SPEECH_REGION is set in this shell (key: secret azure_speech_key),
# and RECAP_EMAIL_FROM only when set here.
extra_env=""
if [ -n "${AZURE_SPEECH_REGION:-}" ]; then
  extra_env="${extra_env},
    \"AZURE_SPEECH_KEY\": \"{{ RUNPOD_SECRET_azure_speech_key }}\",
    \"AZURE_SPEECH_REGION\": \"${AZURE_SPEECH_REGION}\""
fi
if [ -n "${RECAP_EMAIL_FROM:-}" ]; then
  extra_env="${extra_env},
    \"RECAP_EMAIL_FROM\": \"${RECAP_EMAIL_FROM}\""
fi

registry_auth=""
if [ -n "${REGISTRY_AUTH_ID:-}" ]; then
  registry_auth="
  \"containerRegistryAuthId\": \"${REGISTRY_AUTH_ID}\","
fi

body=$(cat <<JSON
{
  "name": "${NAME}",
  "imageName": "${IMAGE}",${registry_auth}
  "computeType": "GPU",
  "cloudType": "${CLOUD_TYPE}",
  "gpuTypeIds": [$(json_list "$GPU_TYPES")],
  "gpuCount": 1,
  "allowedCudaVersions": [$(json_list "$CUDA_VERSIONS")],
  "containerDiskInGb": ${CONTAINER_DISK_GB},
  "volumeInGb": ${VOLUME_GB},
  "volumeMountPath": "/workspace",
  "ports": ["8000/http"],
  "env": {
    "ANTHROPIC_API_KEY": "{{ RUNPOD_SECRET_anthropic_api_key }}",
    "CARTESIA_API_KEY": "{{ RUNPOD_SECRET_cartesia_api_key }}",
    "OPENAI_API_KEY": "{{ RUNPOD_SECRET_openai_api_key }}",
    "HF_TOKEN": "{{ RUNPOD_SECRET_hf_token }}",
    "RESEND_API_KEY": "{{ RUNPOD_SECRET_resend_api_key }}",
    "SPACETIME_URI": "https://maincloud.spacetimedb.com",
    "SPACETIME_DATABASE": "${SPACETIME_DATABASE:-articulate-live}",
    "SPACETIME_TOKEN": "{{ RUNPOD_SECRET_spacetime_token }}",
    "CLASSROOM_DEV_IDENTITIES": "true",
    "LIVE_COORDINATION": "local",
    "STORE_DIR": "/workspace/articulate-store"${extra_env}
  }
}
JSON
)

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$body"
  exit 0
fi

response=$(curl -sS -X POST "https://rest.runpod.io/v1/pods" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  -w '\n%{http_code}')
code=${response##*$'\n'}
payload=${response%$'\n'*}

if [ "$code" != "201" ] && [ "$code" != "200" ]; then
  echo "RunPod API returned HTTP ${code}:" >&2
  echo "$payload" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  pod_id=$(printf '%s' "$payload" | jq -r '.id')
else
  # Without jq, take the first "id" field (the pod's own id leads the Pod object).
  pod_id=$(printf '%s' "$payload" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
fi

echo "$payload"
echo
echo "Pod id:  ${pod_id}"
echo "App URL: https://${pod_id}-8000.proxy.runpod.net/  (ready once /health answers; first start pulls ~6 GB; the phone model then downloads ~1.2 GB once)"
echo "Set CORS_ORIGINS=https://${pod_id}-8000.proxy.runpod.net on the pod only if another origin calls this API."
