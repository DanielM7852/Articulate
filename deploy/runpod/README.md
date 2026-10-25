# Hosting Articulate on a RunPod GPU Pod

One Docker image runs the whole app on a single RunPod GPU Pod:

| Process | Where | What |
| --- | --- | --- |
| FastAPI (`backend/`) | `0.0.0.0:8000`, exposed | `/v1/*` API, `/health`, `/docs`, and the built React app at `/` |
| SPARC collector (`services/articulation`) | `127.0.0.1:8010`, internal only | after-attempt articulation analysis, on the GPU when one is visible |
| Phone service (`services/phones`, model `KoelLabs/xlsr-english-01`) | `127.0.0.1:8020`, internal only | live phone recognition, torch FP16 on CUDA, run from source |

The browser talks to Cartesia, OpenAI Realtime and SpacetimeDB directly. For live phones it opens a
WebSocket to **our backend** at `/phones/ws` (plus plain HTTPS to `/phones/*`), and the backend relays it to
the phone service on the same pod. Port 8020 is never exposed. RunPod's HTTP proxy carries the WebSocket
on port 8000.

Files: `Dockerfile` and `.dockerignore` at the repo root, `deploy/entrypoint.sh` (starts the three
processes and forwards SIGTERM to all), and `deploy/runpod/create-pod.sh` (creates the pod with one API call).

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
  - `VITE_PHONES_WS` and `VITE_PHONES_HTTP` (default `same-origin`): the web app uses the backend relay on
    the page's own origin. Leave them alone for RunPod.
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

### Phone model (downloads at pod start)

The phone model is gated and AGPL-licensed, so it is **not** in the image. On start the entrypoint downloads
it (about 1.2 GB) into `/workspace/phones-models` once, using `HF_TOKEN`. Later starts reuse it, so keep the
volume. The token must come from a Hugging Face account that has accepted the license on the
`KoelLabs/xlsr-english-01` model page. Without `HF_TOKEN` (and no model on the volume) the phone service is
skipped, `/phones/*` returns 503, and the app shows the basic view ("Phone model offline"). The rest of the
app keeps working. The image uses torch FP16 on CUDA (`PHONES_BACKEND=auto`). TensorRT is not installed.

### Environment variables

First create the secrets in the RunPod console (**Secrets**). Then reference each one as
`{{ RUNPOD_SECRET_<name> }}`. Every secret you reference must exist. A missing one can reach the app as
literal text, and the app would then treat that provider as configured. Delete the lines you don't use.

| Variable | Required? | Value / notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | required for Ava and the coach | `{{ RUNPOD_SECRET_openai_api_key }}`. `LIVE_COACH_PROVIDER` defaults to `openai`, so the live coach, Ava and the realtime persona (`/v1/realtime/session`) need it. |
| `HF_TOKEN` | required for live phones | `{{ RUNPOD_SECRET_hf_token }}`. Downloads the gated phone model on first start. |
| `ANTHROPIC_API_KEY` | recommended | `{{ RUNPOD_SECRET_anthropic_api_key }}`. Used where a Claude model is configured (for example the session recap). Without it those paths use the disclosed fallback. |
| `CARTESIA_API_KEY` | required for Ava's voice | `{{ RUNPOD_SECRET_cartesia_api_key }}`. The browser gets short-lived TTS tokens from `/v1/speech/token`. |
| `RESEND_API_KEY`, `RECAP_EMAIL_FROM` | optional | `{{ RUNPOD_SECRET_resend_api_key }}` and a verified sender address. The post-session recap email is sent only when both are set. |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | optional | `{{ RUNPOD_SECRET_azure_speech_key }}` and a region such as `westus2`. Enables Azure pronunciation scoring for the consonant coach. Without both it is skipped. |
| `SPACETIME_URI` | optional | `https://maincloud.spacetimedb.com` (default) |
| `SPACETIME_DATABASE` | optional | `articulate-live`. Without both the database and the token, learner history is stored as local JSON in `STORE_DIR` and backend telemetry is off. |
| `SPACETIME_TOKEN` | optional | `{{ RUNPOD_SECRET_spacetime_token }}` (`spacetime login show --token`) |
| `CLASSROOM_DEV_IDENTITIES` | optional | `true` (set by `create-pod.sh`). Serves the Classroom, School and teacher console on `SPACETIME_DATABASE` using `SPACETIME_TOKEN` as owner, and opens `/v1/dev/classroom/*`, which lets any visitor mint a development teacher or learner identity. A dev login, not production auth. |
| `CLASSROOM_DATABASE` | optional | Classroom database name. Defaults to `SPACETIME_DATABASE`. |
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
`HOST=0.0.0.0`, `PORT=8000`, `PHONES_URL=http://127.0.0.1:8020`, `PHONES_PORT`, `PHONES_BACKEND=auto`,
`PHONES_MODELS_DIR=/workspace/phones-models`, `PHONES_ENGINES_DIR=/workspace/phones-engines` and
`PHONES_PROXY_ORIGIN_REGEX` (lets the relay accept WebSockets from `https://<POD_ID>-8000.proxy.runpod.net`).
Don't override them.

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
`openai_api_key`, `hf_token`, `resend_api_key` and `spacetime_token` secrets. Create all six first
(RunPod console, **Secrets**), or edit the `env` block to drop any you don't use. Set `AZURE_SPEECH_REGION`
in your shell to also pass the Azure pair (secret `azure_speech_key`), and `RECAP_EMAIL_FROM` to pass the
recap sender. Neither is sent when unset. Port 8020 is not in `ports`.

## Build on GitHub (GHCR)

`.github/workflows/runpod-image.yml` builds the root `Dockerfile` (linux/amd64) on every push to
`feature/runpod-phones` that touches the image inputs (or by hand via **Actions > RunPod image > Run workflow**)
and pushes `ghcr.io/danielm7852/articulate:runpod-phones` plus `:sha-<short sha>`, using only the built-in
`GITHUB_TOKEN`. The package is private, so RunPod needs registry credentials to pull it:

1. GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic) > Generate new token
   (classic). Tick only `read:packages`.
2. RunPod console > Settings > Container Registry Auth (label approximate) > add: registry `ghcr.io`,
   username = your GitHub username, password = the token. Note the id it gets.
3. Run the script with `REGISTRY_AUTH_ID=<that id>` (sent as `containerRegistryAuthId`), or pick it under
   "Container Registry Credentials" (approximate label) in a console template.

```bash
IMAGE=ghcr.io/danielm7852/articulate:runpod-phones REGISTRY_AUTH_ID=<id> deploy/runpod/create-pod.sh
```

## 4. Find the URL

The app is served at `https://<POD_ID>-8000.proxy.runpod.net/`. The script prints the pod id. You can also
open the pod in the console and click **Connect → HTTP Service [Port 8000]**. RunPod's proxy provides
HTTPS, which the browser requires for camera and microphone access.

## 5. Smoke test

1. `curl https://<POD_ID>-8000.proxy.runpod.net/health` returns `{"status":"ok",...}`. Check
   `anthropic_configured` and `cartesia_configured`.
2. Phones, after the first-start download (watch the pod logs for `phones on 127.0.0.1:8020`):
   `curl https://<POD_ID>-8000.proxy.runpod.net/phones/health` should report the engine (`torch-fp16`) and
   device `cuda`. A 503 means the model is missing or still downloading. The WebSocket check is the browser
   step below: in the network tab, `/phones/ws` should show status 101.
3. Open `https://<POD_ID>-8000.proxy.runpod.net/#/dashboard?demo`. The system-view dashboard should
   replay the demo telemetry.
4. Open `https://<POD_ID>-8000.proxy.runpod.net/`. Start a practice. The browser should prompt for camera
   and microphone (HTTPS), the mouth and vowel graph should render, and Ava should speak.
5. Finish an attempt. The coach request (`POST /v1/live/coach` in the network tab) should return 200 with a cue.
6. SPARC inside the pod: open the web terminal (or SSH) and run
   `curl -s localhost:8010/v1/articulation/models`. Each model should show as prepared or loaded. After one
   attempt, the pod logs show the collector loading on `device=cuda`, and `nvidia-smi` lists the Python process.
7. `curl -s localhost:8000/docs` inside the pod confirms the API docs still load (the frontend doesn't shadow them).
8. Open `https://<POD_ID>-8000.proxy.runpod.net/#/lesson` and allow the microphone. The phone board should go
   live while you speak, and "Phone model offline · basic view" should not appear.

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
