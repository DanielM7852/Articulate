# syntax=docker/dockerfile:1
# One image for a RunPod GPU Pod (see deploy/runpod/README.md):
#   - the built React app (web/) and the FastAPI backend (backend/) on one HTTP port, 8000
#   - the SPARC articulation collector (services/articulation) on 127.0.0.1:8010, inside the container
#   - the phone-recognition service (services/phones, KoelLabs/xlsr-english-01, torch FP16 on CUDA) on
#     127.0.0.1:8020, inside the container; the browser reaches it only via the backend's /phones relay
# Build from the repository root, because web/ aliases ../mouth-demo and ../vowel-mapper:
#   docker build -t <dockerhub-user>/articulate:<tag> .

# ---- web: static frontend -> /src/web/dist ----------------------------------------------------
FROM node:20-alpine AS web
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# The browser talks to SpacetimeDB directly; Vite bakes these into the bundle. Defaults match the app's.
ARG VITE_SPACETIME_URI=wss://maincloud.spacetimedb.com
ARG VITE_SPACETIME_DATABASE=articulate-live
# 'same-origin' = the web app reaches the phone service through the backend relay (/phones/ws, /phones).
ARG VITE_PHONES_WS=same-origin
ARG VITE_PHONES_HTTP=same-origin
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY web web
COPY mouth-demo mouth-demo
COPY vowel-mapper vowel-mapper
# web aliases @lesson-rules to the classroom module's lessonRules.ts.
COPY spacetimedb/src spacetimedb/src
# `build` runs `tsc --noEmit` first, then copies the MediaPipe wasm into public/ and runs vite build.
RUN cd web && npm run build

# ---- runtime: CUDA PyTorch matching services/articulation's torch==2.8.0 pin -------------------
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1
# libsndfile1/ffmpeg: soundfile and librosa decoding. git: SPARC installs from a pinned commit.
# curl: health checks and the smoke test inside the pod.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ffmpeg git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Collector first. torch==2.8.0 is already satisfied by the base image's CUDA build; the cu128 index
# keeps any torch-family package pip still has to fetch on the same CUDA build. The assert fails the
# build if a CPU-only torch ever replaced it.
COPY services/articulation services/articulation
RUN pip install --extra-index-url https://download.pytorch.org/whl/cu128 "./services/articulation[models]" \
 && python -c "import torch, torchaudio; assert torch.version.cuda, torch.__version__; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

# Pinned SPARC / ARTI-6 / Silero weights (~1.27 GB) baked into the image so a pod starts ready.
# Build with --build-arg PREPARE_MODELS=0 to skip this and point ARTICULATION_MODELS_DIR at a
# (network) volume instead; the entrypoint then downloads them there once on first start.
ENV ARTICULATION_MODELS_DIR=/app/models
ARG PREPARE_MODELS=1
RUN if [ "$PREPARE_MODELS" = "1" ]; then python -m articulate_models prepare; fi

# Backend as an editable install: it reads app/demo.html, app/live/*.json and data/ next to the code.
COPY backend backend
RUN pip install -e ./backend

# Phone service, run from source (its pyproject wants Python 3.12, the base image may be older, so it is
# NOT pip-installed). Only what the collector's pins don't already provide: websockets for the /ws stream.
# No onnx/tensorrt: engine.py imports them lazily and PHONES_BACKEND=auto falls back to torch FP16 on CUDA.
# The model is gated and AGPL, so neither the HF token nor the weights are ever baked in; the entrypoint
# downloads them into the /workspace volume at pod start.
COPY services/phones/src services/phones/src
COPY services/phones/scripts services/phones/scripts
RUN python -c "import sys; sys.path.insert(0,'/app/services/phones/src'); import phones.app, phones.engine; print('phones import ok')"

COPY --from=web /src/web/dist /app/web/dist
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
# Strip CRLF in case the context came from a Windows checkout with autocrlf.
RUN sed -i 's/\r$//' /app/deploy/entrypoint.sh && chmod +x /app/deploy/entrypoint.sh \
 && mkdir -p /app/data/store

ENV STATIC_DIR=/app/web/dist \
    ARTICULATION_URL=http://127.0.0.1:8010 \
    STORE_DIR=/app/data/store \
    HOST=0.0.0.0 \
    PORT=8000 \
    PHONES_URL=http://127.0.0.1:8020 \
    PHONES_PORT=8020 \
    PHONES_BACKEND=auto \
    PHONES_MODELS_DIR=/workspace/phones-models \
    PHONES_ENGINES_DIR=/workspace/phones-engines
# Single quotes keep the backslash-free regex and the trailing $ literal (no Docker expansion).
ENV PHONES_PROXY_ORIGIN_REGEX='^https://[a-z0-9]+-8000[.]proxy[.]runpod[.]net$'
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
