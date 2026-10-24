# Articulate backend

Python service that compares a learner recording with a reference example and returns one practice cue. Visual rendering and the Cartesia voice agent belong to other teammates. This service returns measurements, progress events, and a short handoff.

## What the first loop does

Synthetic or uploaded audio goes through validation, librosa pYIN pitch tracking, usable-frame checks, relative-pitch comparison, cue retrieval, and a coaching decision. The response includes the pitch contours, the comparison, and `feedback.spoken_text` for Cartesia.

The checked-in reference, `intonation-rising-ready`, is the phrase "Are you ready?" with an intended rising ending. With `CARTESIA_API_KEY` set, the reference clip is spoken by Cartesia and cached locally. Without a key, it is a generated harmonic phrase. Either clip is one example of that pattern, not a norm for every speaker. Learner fixture takes stay synthetic.

## Setup

From this directory, with Python 3.11 or newer (developed on Python 3.14):

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
copy .env.example .env
.venv\Scripts\python -m pytest
.venv\Scripts\python -m uvicorn app.main:app --reload
```

Tested package versions in this environment: FastAPI 0.162.0, Pydantic 2.14.1, NumPy 2.5.4, librosa 1.0.0, Anthropic SDK 2.3.0. librosa 1.0.0 still exposes `librosa.pyin` and `librosa.sequence.dtw` with the parameters this code uses. The 0.11.0 documentation describes that same pYIN contract; `win_length` was removed and is not passed.

Leave API keys blank to run the disclosed local cue library and the deterministic coaching fallback. That fallback is not a Claude or Moss integration.

## Try the loop

```powershell
curl -X POST "http://127.0.0.1:8000/v1/comparisons/fixtures/rising_vs_falling?session_id=demo&attempt_id=demo-1"
```

The fixture response is labeled `fixture_mode: true`. Fixture audio is synthetic.

A real upload is multipart form data:

- `reference_id`
- `attempt_id`
- `session_id`
- `capture_state=learner_recording`
- `learner_audio` (WAV, or another format soundfile can decode)

`capture_state` must be `learner_recording`. Reference playback and agent playback are rejected.

## Configuration

See `.env.example`. Keys stay on the server.

`ANTHROPIC_MODEL` defaults to `claude-sonnet-4-6`, which is in the current structured-output model list. Change it if the account uses a different current model.

Moss is optional. Install it with `pip install -e ".[moss]"`, set `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY`, then preview the index write:

```powershell
.venv\Scripts\python scripts\sync_moss_cues.py
.venv\Scripts\python scripts\sync_moss_cues.py --commit --limit 50
```

The command is a dry-run unless `--commit` is present. It upserts; it does not delete an index.

## Retention

Learner audio is decoded in memory and is not written to disk. The local session store keeps derived contours, metrics, cue ids, and the handoff so a duplicate attempt id can be replayed. Delete that record with `DELETE /v1/sessions/{session_id}`.

Pitch thresholds in `app/config.py` are engineering defaults. They are not clinical standards. Definitions are in `docs/backend-contract.md`.
