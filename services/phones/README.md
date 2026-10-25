# Articulate phones service

Local GPU IPA phone recognition: a wav2vec2 CTC model (default `KoelLabs/xlsr-english-01`) exported to ONNX and
built into a TensorRT FP16 engine, streamed to the browser over a WebSocket. Falls back automatically to
torch FP16 on CUDA, then torch CPU; the active one is reported by `/health` and the WS `ready` message.

**Licensing / access.** `KoelLabs/xlsr-english-01` is AGPL-3.0 and gated on Hugging Face (accept the terms on the
model page and provide `HF_TOKEN`). Weights, ONNX and engines are NOT committed (`models/`, `engines/`, `.venv/`
are gitignored). Any Wav2Vec2ForCTC phone model works via `PHONES_MODEL_ID` (e.g. the ungated Apache-2.0
`facebook/wav2vec2-lv-60-espeak-cv-ft`); the code path is identical.

## Setup (Windows, RTX 50-series needs CUDA 12.8 torch and TensorRT >= 10.8)

```
cd services/phones
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/Scripts/python.exe transformers onnx onnxruntime "tensorrt-cu12<11" fastapi "uvicorn[standard]" numpy soundfile scipy pytest httpx websockets
export HF_TOKEN=...            # gated model; or `hf auth login`
.venv/Scripts/python.exe scripts/download_model.py
.venv/Scripts/python.exe scripts/export_onnx.py      # verifies ONNX vs PyTorch
.venv/Scripts/python.exe scripts/build_engine.py     # TensorRT FP16, profile 8000/32000/64000 samples; verifies vs PyTorch
.venv/Scripts/python.exe scripts/bench.py
```

If FP16 diverges, rebuild with `build_engine.py --fp32-layers "regex"` to pin matching layers (plus all
normalization/softmax layers) to FP32.

## Run

```
services/phones/.venv/Scripts/python.exe -m uvicorn phones.app:app --app-dir services/phones/src --host 127.0.0.1 --port 8020
```

Settings (env): `PHONES_MODEL_ID`, `PHONES_BACKEND` (auto|tensorrt|torch-fp16|torch-cpu), `PHONES_HOP_MS=250`,
`PHONES_WINDOW_MS=2000`, `PHONES_MIN_WINDOW_MS=500`, `PHONES_COMMIT_LAG_MS=500`, `PHONES_SILENCE_RMS=0.004`.

## API

- `GET /health` -> `{ok, model, engine, device}`
- `POST /v1/phones` (WAV body, or JSON `{"audio": "<base64 wav>"}`) -> `{phones:[{p,startMs,endMs,conf}], inferMs, model, engine}`
- `WS /ws/phones` (Origin allowlist `http://127.0.0.1:5176`, `http://localhost:5176`)
  - client -> server: binary little-endian Int16 mono 16 kHz PCM, any length; text `{"type":"reset"}` clears buffer and clock
  - server -> client: `{"type":"ready","model","engine","frameMs","sampleRate":16000}`,
    `{"type":"phones","seq","windowEndMs","committed":[...],"provisional":[...],"inferMs"}`, `{"type":"error","message"}`
  - every 250 ms the latest 2 s (>= 500 ms at stream start) is decoded; windows below the RMS gate are skipped
    (an empty `provisional` is sent); phones ending >= 500 ms before the window edge are committed once.

## Test

```
services/phones/.venv/Scripts/python.exe -m pytest services/phones/tests
services/phones/.venv/Scripts/python.exe services/phones/scripts/ws_smoke.py clip.wav
```
