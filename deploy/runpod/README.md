# Hosting Articulate on a RunPod GPU Pod

One Docker image runs the whole app on a single RunPod GPU Pod:

| Process | Where | What |
| --- | --- | --- |
| FastAPI (`backend/`) | `0.0.0.0:8000`, exposed | `/v1/*` API, `/health`, `/docs`, and the built React app at `/` |
| SPARC collector (`services/articulation`) | `127.0.0.1:8010`, internal only | after-attempt articulation analysis, on the GPU when one is visible |

The browser talks to Cartesia, OpenAI Realtime and SpacetimeDB directly. It only makes plain HTTPS
requests to our backend, never a WebSocket, so the RunPod HTTP proxy is all we need.

Files: `Dockerfile` and `.dockerignore` at the repo root, `deploy/entrypoint.sh` (starts both
processes and forwards SIGTERM to both), and `deploy/runpod/create-pod.sh` (creates the pod with one API call).

## 1. Build and push

Build from the **repository root**. `web/` imports `../mouth-demo` and `../vowel-mapper`, so the build
context has to include them.

```bash
docker login
docker build -t <dockerhub-user>/articulate:<tag> .
docker push <dockerhub-user>/articulate:<tag>
```

- RunPod hosts are `linux/amd64`. On an Apple Silicon Mac, add `--platform linux/amd64`.
- Build args (all optional):
  - `VITE_SPACETIME_URI` (default `wss://maincloud.spacetimedb.com`) and `VITE_SPACETIME_DATABASE`
    (default `articulate-live`): the SpacetimeDB database the browser connects to. They are baked into
    the JS bundle at build time, so changing them means rebuilding the image.
  - `PREPARE_MODELS=0`: skip baking the model weights into the image (see [Model weights](#model-weights)).
- Base image: `pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime`. It matches the collector's `torch==2.8.0`
  pin, and CUDA 12.8 covers RTX 30xx, 40xx and 50xx cards. The build fails if pip ever swaps in a CPU-only torch.
- Size: the base image alone is about 4.3 GB compressed. ffmpeg plus the Python dependencies add about
  1.5 GB, and the baked weights add 1.27 GB. Expect roughly **6–7 GB compressed** to push and pull, and
  roughly **11–12 GB on disk**. The first pod start spends most of its time pulling the image.

### Model weights

By default the build runs `python -m articulate_models prepare` and bakes the pinned SPARC, ARTI-6 and
Silero weights (about 1.27 GB) into `/app/models`, so a new pod is ready as soon as the image is pulled.

To keep the image smaller, use a volume instead:

1. Build with `--build-arg PREPARE_MODELS=0`.
2. Set `ARTICULATION_MODELS_DIR=/workspace/articulate-models` on the pod. Use a pod volume or a RunPod
   network volume mounted at `/workspace`.
3. On first start the entrypoint finds no `manifest.json` there, downloads the weights once (a few
   minutes), and then starts the collector. Later starts reuse them. Until the download finishes,
   articulation reports unavailable. The rest of the app works during that time.

## 2. RunPod template / pod settings

| Setting | Value |
| --- | --- |
| Container image | `<dockerhub-user>/articulate:<tag>` (if the repo is private, add registry credentials) |
| GPU | 1x RTX 4090 or RTX 3090, Community Cloud. SPARC is small, so a 24 GB consumer card is plenty. Any GPU with CUDA 12.8+ drivers works. |
| Container disk | **30 GB**. The image is about 12 GB unpacked, and pip and runtime caches need headroom. |
| Volume disk | 10 GB at `/workspace`. It holds learner history (`STORE_DIR`) and, optionally, the weights. |
| Expose HTTP ports | `8000` |
| Expose TCP ports | none (add `22` only if you want SSH) |
| Start command | leave empty. The image `ENTRYPOINT` runs `deploy/entrypoint.sh`. |

### Environment variables

First create the secrets in the RunPod console (**Secrets**). Then reference each one as
`{{ RUNPOD_SECRET_<name> }}`. Every secret you reference must exist. A missing one can reach the app as
literal text, and the app would then treat that provider as configured. Delete the lines you don't use.

| Variable | Required? | Value / notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required for real coaching | `{{ RUNPOD_SECRET_anthropic_api_key }}`. Without it the coach uses the disclosed deterministic fallback. |
| `CARTESIA_API_KEY` | required for Ava's voice | `{{ RUNPOD_SECRET_cartesia_api_key }}`. The browser gets short-lived TTS tokens from `/v1/speech/token`. |
| `OPENAI_API_KEY` | optional | `{{ RUNPOD_SECRET_openai_api_key }}`. Enables the realtime persona (`/v1/realtime/session` mints browser secrets). |
| `SPACETIME_URI` | optional | `https://maincloud.spacetimedb.com` (default) |
| `SPACETIME_DATABASE` | optional | `articulate-live`. Without both the database and the token, learner history is stored as local JSON in `STORE_DIR` and backend telemetry is off. |
| `SPACETIME_TOKEN` | optional | `{{ RUNPOD_SECRET_spacetime_token }}` (`spacetime login show --token`) |
| `LIVE_COORDINATION` | optional | Keep `local` (default). `spacetime` queues coach jobs for the standalone workers (`python -m app.live.worker`), and this image does not run them. |
| `LIVE_IDENTITY_SECRET` | only with `LIVE_COORDINATION=spacetime` | `{{ RUNPOD_SECRET_live_identity_secret }}`, at least 32 characters. Unused in `local` mode. |
| `CORS_ORIGINS` | optional | `https://<POD_ID>-8000.proxy.runpod.net`. The app and the API share one origin, so this only matters if a frontend on another origin calls the API. |
| `STORE_DIR` | recommended | `/workspace/articulate-store`. The image default `/app/data/store` sits on the container disk, which is wiped when the pod stops. |
| `ARTICULATION_DEVICE` | optional | `cuda` or `cpu`. By default the entrypoint picks `cuda` when `nvidia-smi` sees a GPU. |
| `ARTICULATION_THREADS` | optional | CPU threads for the collector (default 4) |
| `ARTICULATION_MODELS_DIR` | optional | `/app/models` (baked in). Set it to a `/workspace/...` path for the volume option. |
| `CARTESIA_VOICE_ID` | optional | Overrides the default voice (Ella) |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | optional | Moss cue retrieval. The image doesn't install the `moss` extra, so leave these unset. |
| `LIVE_COACH_MODEL`, `LIVE_*_EFFORT`, `*_TIMEOUT_S`, … | optional | Tuning knobs. See `backend/.env.example`. |

The image already sets `STATIC_DIR=/app/web/dist`, `ARTICULATION_URL=http://127.0.0.1:8010`,
`HOST=0.0.0.0` and `PORT=8000`. Don't override them.

## 3. Create the pod with one command

`deploy/runpod/create-pod.sh` calls `POST https://rest.runpod.io/v1/pods` with `imageName`,
`ports: ["8000/http"]`, `env`, `gpuTypeIds`, `cloudType`, `containerDiskInGb`, `volumeInGb` and
`allowedCudaVersions`. Field names were checked against
<https://docs.runpod.io/api-reference/pods/POST/pods>.

```bash
export RUNPOD_API_KEY=...            # RunPod console > Settings > API Keys
export IMAGE=<dockerhub-user>/articulate:<tag>
DRY_RUN=1 deploy/runpod/create-pod.sh   # print the request body first
deploy/runpod/create-pod.sh
```

You can override these with environment variables: `NAME`, `GPU_TYPES` (comma-separated, default
`NVIDIA GeForce RTX 4090,NVIDIA GeForce RTX 3090`), `CLOUD_TYPE` (`COMMUNITY`/`SECURE`),
`CONTAINER_DISK_GB` (30), `VOLUME_GB` (10), `CUDA_VERSIONS` (`12.8,12.9,13.0`) and
`SPACETIME_DATABASE`. The script references the `anthropic_api_key`, `cartesia_api_key`,
`openai_api_key` and `spacetime_token` secrets. Create all four first, or edit the `env` block to drop any you don't use.

## 4. Find the URL

The app is served at `https://<POD_ID>-8000.proxy.runpod.net/`. The script prints the pod id. You can also
open the pod in the console and click **Connect → HTTP Service [Port 8000]**. RunPod's proxy provides
HTTPS, which the browser requires for camera and microphone access.

## 5. Smoke test

1. `curl https://<POD_ID>-8000.proxy.runpod.net/health` returns `{"status":"ok",...}`. Check
   `anthropic_configured` and `cartesia_configured`.
2. Open `https://<POD_ID>-8000.proxy.runpod.net/#/dashboard?demo`. The system-view dashboard should
   replay the demo telemetry.
3. Open `https://<POD_ID>-8000.proxy.runpod.net/`. Start a practice. The browser should prompt for camera
   and microphone (HTTPS), the mouth and vowel graph should render, and Ava should speak.
4. Finish an attempt. The coach request (`POST /v1/live/coach` in the network tab) should return 200 with a cue.
5. SPARC inside the pod: open the web terminal (or SSH) and run
   `curl -s localhost:8010/v1/articulation/models`. Each model should show as prepared or loaded. After one
   attempt, the pod logs show the collector loading on `device=cuda`, and `nvidia-smi` lists the Python process.
6. `curl -s localhost:8000/docs` inside the pod confirms the API docs still load (the frontend doesn't shadow them).

## Known limits

- **100 s proxy timeout.** RunPod's HTTP proxy cuts any request after 100 s. The backend's own budgets
  stay under that (coach 15 s, overall 45 s, insight 45 s, articulation 30 s). Keep any new endpoint
  well below 100 s.
- **The URL contains the pod id.** Terminating a pod and creating a new one changes the id, and with it
  the URL (and any `CORS_ORIGINS` value). To pause, **stop** the pod rather than terminating it. A stopped
  pod keeps its id and `/workspace` volume, but the container disk is reset.
- **Cold start.** The first request after a start loads WavLM/SPARC onto the GPU, which takes several
  seconds. That happens in the background analysis path, not in the coach round trip.
- **One collector at a time.** The collector analyzes one clip at a time. If it is busy it returns 503,
  and the backend queues at most `ARTICULATION_MAX_QUEUE` (2) jobs.
- **Single replica.** `LIVE_COORDINATION=local` keeps sessions in this one process's memory, so don't
  scale it to several pods. Shared mode needs the standalone workers.
