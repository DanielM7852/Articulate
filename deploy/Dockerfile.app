# syntax=docker/dockerfile:1
# Slim CPU image for the public demo box (AWS Lightsail, 2 GB RAM, x86_64): the built React app plus the
# FastAPI backend on one HTTP port, 8000. No torch/CUDA. The phone model and SPARC run on a separate GPU
# box; with PHONES_URL / ARTICULATION_URL blank the app shows its "Phone model offline" basic view.
# Build from the repository root (web/ aliases ../mouth-demo and ../vowel-mapper):
#   docker build -f deploy/Dockerfile.app -t articulate-app:dev .

# ---- web: static frontend -> /src/web/dist (same stage as the root Dockerfile) -------------------
FROM node:20-alpine AS web
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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
COPY spacetimedb/src spacetimedb/src
# true = MVP demo flow (no survey, fixed lessons track -> sheep -> rent); false = the full app.
# Like the ARGs above, it is visible to the build as an env var, so Vite bakes it into the bundle.
ARG VITE_DEMO_MVP=true
RUN cd web && npm run build

# ---- runtime: python only ------------------------------------------------------------------------
FROM python:3.12-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1
# libsndfile1: soundfile. ffmpeg: librosa/audioread decoding of browser webm/opus uploads. curl: healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Editable on purpose: the backend reads app/demo.html, app/live/*.json and data/ next to the code.
COPY backend backend
RUN pip install -e ./backend

COPY --from=web /src/web/dist /app/web/dist

# Non-root; STORE_DIR is a named volume (a fresh volume copies this directory's ownership).
RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /app/data/store \
 && chown -R app:app /app/data
ENV STATIC_DIR=/app/web/dist \
    STORE_DIR=/app/data/store \
    HOST=0.0.0.0 \
    PORT=8000
USER app
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD curl -fsS "http://127.0.0.1:8000/health" || exit 1
# '*' for forwarded-allow-ips is safe ONLY because port 8000 is never published to the host; the only
# peer that can reach it is Caddy on the compose network.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
