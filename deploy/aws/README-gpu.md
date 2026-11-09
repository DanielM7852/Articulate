# GPU-only image (AWS g4dn.xlarge, NVIDIA T4)

Runs only the two GPU services; the web app and FastAPI backend live on a separate box.

| Service | Port | Endpoints |
| --- | --- | --- |
| phone recognition (`KoelLabs/xlsr-english-01`) | 8020 | `GET /health`, `POST /v1/phones`, `POST /v1/phones/score`, `WS /ws/phones` |
| SPARC articulation collector | 8010 | `GET /v1/articulation/models`, `POST /v1/articulation/analyze` |

Both bind `0.0.0.0`; restrict them with the instance security group (private web box only). There is no auth.

## Build (from the repo root, for EC2 = linux/amd64)

```
docker buildx build --platform linux/amd64 -f deploy/Dockerfile.gpu -t articulate-gpu:dev --load .
```

SPARC/ARTI-6/Silero weights are baked in. The phone model (gated, AGPL) is never baked in.

## Run (EC2, with the NVIDIA container toolkit)

```
sudo mkdir -p /opt/articulate/data
docker run -d --name articulate-gpu --restart unless-stopped --gpus all \
  -p 8020:8020 -p 8010:8010 \
  -v /opt/articulate/data:/data \
  -e HF_TOKEN="$HF_TOKEN" \
  articulate-gpu:dev
```

| Env | Default | Notes |
| --- | --- | --- |
| `HF_TOKEN` | none | Needed only for the first download. With the model already in the volume it can be omitted. Without both, phones is skipped and articulation still runs. |
| `PHONES_MODEL_ID` | `KoelLabs/xlsr-english-01` | |
| `PHONES_MODELS_DIR` / `PHONES_ENGINES_DIR` | `/data/phones-models` / `/data/phones-engines` | Keep under the `/data` mount so the ~1.2 GB model survives stop/start. |
| `PHONES_PORT` / `ARTICULATION_PORT` | `8020` / `8010` | |
| `PHONES_BACKEND` | `auto` | Falls back to torch FP16 on CUDA (no TensorRT). `torch-cpu` forces CPU. |
| `ARTICULATION_DEVICE` | auto | `cuda` when `nvidia-smi` sees a GPU, else `cpu`. |

Behaviour: the first start downloads the model into the mount; every later start (including after the instance is stopped and restarted) reuses it. If one service crashes the other keeps running; the container exits non-zero only when both are gone. `docker stop` (SIGTERM) stops both.

The backend relay opens its WebSocket with `origin=None` (`backend/app/api/phones_proxy.py`), and the phones service only checks Origin when one is present, so no `PHONES_ALLOWED_ORIGINS` is set. Backend env: `PHONES_URL=http://<gpu-private-ip>:8020`, `ARTICULATION_URL=http://<gpu-private-ip>:8010`.

Healthcheck: passes when phones `/health` returns `ok:true`; if phones is intentionally absent (no model and no token) it checks articulation instead. 10-minute start period covers the first download.

## Smoke test (on the instance, after `docker run`)

```
deploy/aws/gpu-smoke.sh [container-name] [clip.wav]
```

Checks both services from the host's published ports, prints engine/device (expect `torch-fp16` / `cuda`), scores a clip against `t ɹ æ k` and prints `inferMs`, and streams it over `/ws/phones`. Without a WAV it uses a synthetic clip (tests the path, not the transcript). Exits non-zero on failure. For a CPU test run: `EXPECT_ENGINE=torch-cpu EXPECT_DEVICE=cpu deploy/aws/gpu-smoke.sh`.
