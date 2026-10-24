# Audio articulation collectors

An independent Python library/local service collects pretrained model data for a
later reasoning agent. It does not add coaching, scoring, synthesis, or session flow.

| Model      | Outputs                                                                | Interpretation                                                                              |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| SPARC      | 12 tongue/lip/lower-incisor coordinates; pitch, periodicity, amplitude | Audio estimates in a canonical model space, not personalized anatomy.                       |
| ARTI-6     | Lip aperture, tongue tip/body, **velum, tongue root, larynx**          | Experimental MRI-region intensity proxies, not physical coordinates or larynx height.       |
| Silero VAD | Speech probabilities and intervals                                     | Speech activity, distinct from pitch periodicity. Never used to delete other model outputs. |

MediaPipe continues to collect observed facial motion separately. Its geometry and
SPARC's estimated coordinates have different units/reference spaces.

## Install and prepare

Use Python 3.12 (package supports 3.11–3.13; verified on Windows/Python 3.12).
From `services/articulation`:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e ".[models,dev]"
.venv\Scripts\python -m articulate_models prepare
```

Preparation explicitly downloads about 1.27 GB, mostly a shared WavLM backbone.
Other checkpoints are small. `.models/` is git-ignored; `ARTICULATION_MODELS_DIR`
can relocate it. PyTorch/dependencies consume additional space.

`articulate_models/models.lock.json` pins upstream code/checkpoint revisions and
official large-file checksums. Preparation records SHA-256/size for every artifact;
loading verifies them. Inference is offline and never downloads during an attempt.
Missing packages/weights produce explicit unavailable results.

SPARC installs from its pinned official git commit. ARTI-6's pinned architecture
is fetched during preparation instead of being copied into this repository. Its
adapter fixes the upstream repeated-filtered-checkpoint load: the separate filtered
and LoRA files are loaded and all learned output/LoRA keys are checked. It does not
load synthesis or speaker-identification models.

## Run

```powershell
.venv\Scripts\python -m articulate_models analyze input.wav --output observations.json --strict
# Optional subset:
.venv\Scripts\python -m articulate_models analyze input.wav --output sparc.json --models sparc
```

`--strict` returns nonzero if any requested model fails/skips, while still writing
partial observations. CPU is the default and verified device. `--device cuda` can
select an installed CUDA-capable PyTorch. `ARTICULATION_THREADS` defaults to four.

These are **after-attempt** models. WavLM uses whole-clip context; SPARC also uses
bidirectional filtering. Cold starts include loading and first-use compilation.
They must not drive the live acoustic cursor. Load/inference times are measured.

## Python interface

```python
from pathlib import Path
from articulate_models import Collector

collector = Collector()  # Reuse it: model loading is lazy and cached.
result = collector.analyze(
    Path("attempt.wav").read_bytes(),
    names=["sparc", "arti6", "silero_vad"],
    # Optional: same UUID and original audio capture clock as the camera attempt.
    attempt_id="00000000-0000-4000-8000-000000000001",
    capture_start_monotonic_ms=1234.0,
    time_origin_unix_ms=1790000000000.0,
)
```

Both clock fields must be supplied together. They refer to the first captured audio
sample, never upload/processing time. For unrelated recordings omit both; output
then contains relative times without claiming synchronization to the camera.

One collection runs at a time to bound memory and protect stateful VAD. Concurrent
library calls raise `ModelBusy`. Missing/failed models return empty series and
explicit errors. Successful execution does not mean correct speech.

## HTTP/browser interfaces

```powershell
.venv\Scripts\python -m uvicorn articulate_models.api:app --host 127.0.0.1 --port 8010
```

- `GET /v1/articulation/models`: unavailable/prepared/loaded status and provenance.
- `POST /v1/articulation/analyze`: raw WAV body, `Content-Type: audio/wav`.
- Query: `models=sparc,arti6,silero_vad`, `attempt_id`,
  `capture_start_monotonic_ms`, `time_origin_unix_ms`.
- `/docs`: interactive request documentation.

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8010/v1/articulation/analyze?models=sparc,arti6,silero_vad' -ContentType 'audio/wav' -InFile input.wav
```

The web workspace proxies `/v1/articulation` to localhost:8010 in dev/preview. It
does not start the service or automatically upload microphone data. A typed helper
lives in `apps/web/src/articulation/index.ts`:

```ts
import { analyzeArticulation, encodeMonoWav } from "./articulation";

const result = await analyzeArticulation(
  encodeMonoWav(capturedSamples, sampleRate),
  {
    attemptId,
    captureStartMonotonicMs: firstAudioSampleTime,
    timeOriginUnixMs: performance.timeOrigin,
    models: ["sparc", "arti6", "silero_vad"],
    signal: abortController.signal,
  },
);
```

The helper encodes actual mono samples as PCM16 WAV, avoiding browser-dependent
MediaRecorder WebM/Opus. Caller owns capture, pacing, cancellation and agent wiring.
HTTP 400 means bad parameters; 422 invalid audio; 413 oversized input; 503 busy
(Retry-After provided). Model failures appear inside a 200 partial response:
inspect `models[name].status`, not just HTTP status.

## Contract: articulate.articulation/1

The bundle preserves attempt UUID; original WAV SHA-256/sample rate/subtype/channels/
duration; preprocessing, capture flags, optional clock and runtime versions; and
independent model results. Audio is not embedded in the response or persisted.

Each result has status/error, provenance, timings, series and segments. Series have
named channels, units, interpretation, native values, nominal timestamps, hop/offset
in 16 kHz samples, and descriptive statistics. Native frame counts are preserved;
no stretching/interpolation forces models to have matching timelines.

- SPARC EMA order: TDX/TDY, TBX/TBY, TTX/TTY, LIX/LIY, ULX/ULY, LLX/LLY.
  Coordinates retain the learned canonical space, not calibrated millimeters.
- ARTI-6: lip_aperture, tongue_tip, tongue_body, velum, tongue_root, larynx.
  These are single-speaker MRI-region proxies, labeled experimental estimates.
- Pitch is CREPE-tiny F0 in Hz. Periodicity is its model coefficient. Amplitude
  is mean absolute **z-scored** waveform amplitude, not calibrated loudness.
- Nominal sample centers: EMA `39.5 + i*320` after upstream zero-padding;
  ARTI-6 `199.5 + i*320`; averaged pitch/periodicity `119.5 + i*320`;
  amplitude `-0.5 + i*320`. These are model-window centers, not measured anatomy.
- `withinAudio` marks centers inside the recording. Edge/padding rows remain in
  values; summaries exclude outside-audio centers. It does not imply voiced/valid speech.
- VAD: 512-sample windows (32 ms), start/end times, valid sample counts on padded
  tails, raw probabilities and speech intervals. State resets before/after each clip.
  VAD may miss quiet/unusual vowels; other model results remain available regardless.

Input is bounded at 8 MiB/30 seconds, 8–96 kHz mono/stereo WAV. Quality is measured
before channel mixing/resampling; nonfinite/out-of-range float samples are rejected.
Audio is mixed to mono and polyphase-resampled to 16 kHz. Silence, constant signal,
and clips under 0.5 seconds explicitly skip inversion to avoid normalization/filter
failures. VAD still runs if available. Clipping is flagged, not replaced by invented data.

Existing F1/F2 tracking supplies formants independently. General point trackers and
MRI-input segmentation add no verified new speech signal for this webcam/mic setup
and are not included.

## Tests

```powershell
.venv\Scripts\python -m pytest -m 'not models'
.venv\Scripts\ruff check articulate_models tests
# Explicit real checkpoint test; prepare first and provide a local speech WAV.
$env:ARTICULATION_SMOKE_WAV = 'C:/path/to/speech.wav'
.venv\Scripts\python -m pytest -m models
```

The real-model test runs all three models, checks dimensions/finite values and LoRA
loading, and verifies VAD does not carry speech into a silent second attempt.
Unit/API tests cover decoding/resampling, flags, timing, missing/failed models,
clock validation, concurrency and asset checks. Tests never download models implicitly.

Sources: [SPARC](https://github.com/Berkeley-Speech-Group/Speech-Articulatory-Coding),
[ARTI-6](https://github.com/lee-jhwn/arti-6), [Silero](https://github.com/snakers4/silero-vad).
SPARC's package and Silero declare MIT. ARTI-6's inspected repository has no standalone
license; no reuse license is asserted here. Predictions have not been validated for
therapy outcomes or individual DHH learners.
