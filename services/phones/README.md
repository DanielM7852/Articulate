# Articulate phones service

Local GPU IPA phone recognition: a wav2vec2 CTC model (default `KoelLabs/xlsr-english-01`) exported to ONNX and
built into a TensorRT FP16 engine, streamed to the browser over a WebSocket. Falls back automatically to
torch FP16 on CUDA, then torch MPS (Apple GPU), then torch CPU; the active one is reported by `/health` and the WS `ready` message.

**Licensing / access.** `KoelLabs/xlsr-english-01` is AGPL-3.0 and gated on Hugging Face (accept the terms on the
model page and provide `HF_TOKEN`). Weights, ONNX and engines are NOT committed (`models/`, `engines/`, `.venv/`
are gitignored). Any Wav2Vec2ForCTC phone model works via `PHONES_MODEL_ID` (e.g. the ungated Apache-2.0
`facebook/wav2vec2-lv-60-espeak-cv-ft`); the code path is identical.

## Setup (macOS, Apple silicon)

Runs on the Apple GPU through torch MPS (no ONNX/TensorRT needed). Backend order on a Mac: `torch-mps`, then `torch-cpu`.

```
brew install uv
cd services/phones
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python "torch>=2.8" "transformers>=4.50" fastapi "uvicorn[standard]" numpy soundfile scipy huggingface_hub pytest httpx websockets
```

Model access: accept the terms at https://huggingface.co/KoelLabs/xlsr-english-01, then log in with
`.venv/bin/hf auth login` (or `export HF_TOKEN=...`), then download the weights into `models/`:

```
.venv/bin/python scripts/download_model.py
```

Run (from `services/phones`), then check `curl http://127.0.0.1:8020/health` (expect `"engine":"torch-mps"`):

```
.venv/bin/python -m uvicorn phones.app:app --app-dir src --host 127.0.0.1 --port 8020
```

Notes: MPS runs fp32 (fp16 can diverge for wav2vec2; opt in with `PHONES_MPS_FP16=1`). Force it with
`PHONES_BACKEND=torch-mps`. If streaming lags, raise `PHONES_HOP_MS` (e.g. 150 or 200). The first request after
start is warmed up at load.

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

Measured with KoelLabs on an RTX 5070 Ti: TensorRT FP16 agrees with PyTorch fp32 on 99.8% of argmax frames
(no FP32 pinning needed), about 3.8 ms per 2 s window. Its vocab is 79 symbols (the fallback has 392): no length or
stress marks, aspiration as separate tokens (`kʰ`, `pʰ`), affricates without tie bars (`tʃ`, `dʒ`). The web
PhoneStrip folds `r` to `ɹ` and aspirated stops to the plain stop.

If FP16 diverges, rebuild with `build_engine.py --fp32-layers "regex"` to pin matching layers (plus all
normalization/softmax layers) to FP32.

## Run

```
services/phones/.venv/Scripts/python.exe -m uvicorn phones.app:app --app-dir services/phones/src --host 127.0.0.1 --port 8020
```

Settings (env): `PHONES_MODEL_ID`, `PHONES_BACKEND` (auto|tensorrt|torch-fp16|torch-mps|torch-cpu), `PHONES_MPS_FP16=1`, `PHONES_HOP_MS=100`,
`PHONES_WINDOW_MS=2000`, `PHONES_MIN_WINDOW_MS=500`, `PHONES_COMMIT_LAG_MS=300`, `PHONES_SILENCE_RMS=0.004`.

## API

- `GET /health` -> `{ok, model, engine, device}`
- `POST /v1/phones` (WAV body, or JSON `{"audio": "<base64 wav>"}`) -> `{phones:[{p,startMs,endMs,conf}], inferMs, model, engine}`
- `POST /v1/phones/score` JSON `{"audioBase64": "<base64 wav>", "targets": ["t","ɹ","æ","k"]}` ->
  `{targets:[{p,startMs,endMs,peakMs,post,gop,best,bestPost}], phones, alignLogProb, inferMs, model, engine}`.
  CTC forced alignment of the targets (`src/phones/align.py`); `post` is the mean target posterior over its aligned
  frames (aspirated `Xʰ` folded into `X`, `r` accepted as `ɹ`), `gop` the log ratio against the best other phone.
  The lesson board's verdicts come from this (thresholds in `web/src/live/phoneJudge.ts`).
- `WS /ws/phones` (Origin allowlist `http://127.0.0.1:5176`, `http://localhost:5176`)
  - client -> server: binary little-endian Int16 mono 16 kHz PCM, any length; text `{"type":"reset"}` clears buffer and clock
  - server -> client: `{"type":"ready","model","engine","frameMs","sampleRate":16000}`,
    `{"type":"phones","seq","windowEndMs","committed":[...],"provisional":[...],"frames":[...],"inferMs"}`, `{"type":"error","message"}`
  - every hop (100 ms) the latest 2 s (>= 500 ms at stream start) is decoded; windows below the RMS gate are skipped
    (an empty `provisional` is sent); phones ending >= 300 ms before the window edge are committed once.
  - `frames`: the frames new since the last message, `{t, mass (1 - blank), top: [[sym, p], ...<=5]}`; the board's
    phone-map cursor is their probability-weighted average place (`web/src/game/ghost/phone-map.json`).

## Scripts

- `scripts/build_word_timing.py`: force-aligns the word recordings and writes the median per-phone timing to
  `web/src/game/ghost/models/recorded-timing.json` (the board's "track" timing).
- `scripts/phone_map_check.py`: checks how close the recordings' centroids land to their places on the phone map.

## Test

```
services/phones/.venv/Scripts/python.exe -m pytest services/phones/tests
services/phones/.venv/Scripts/python.exe services/phones/scripts/ws_smoke.py clip.wav
```
