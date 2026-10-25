# Telemetry stream for the backend dashboard

Every subsystem reports small, non-sensitive events to one public SpacetimeDB table.
The dashboard page (`/#/dashboard` in `web/`) subscribes to that table and animates
the system graph. No media, transcripts, profile ids or attempt ids are ever written here.

## Table `telemetry_event` (public)

| column   | type      | notes                                                  |
|----------|-----------|--------------------------------------------------------|
| id       | u64, pk, autoInc |                                                 |
| at       | timestamp | set by the reducer from `ctx.timestamp`                |
| source   | string    | node id, see below                                     |
| target   | string    | node id                                                |
| kind     | string    | dotted event kind, see below                           |
| label    | string    | short human text for the dashboard (<= 120 chars)      |
| payload  | string    | JSON object, <= 2048 bytes                             |

The reducer keeps only the newest 400 rows (deletes the oldest on insert).

## Reducer `emit_telemetry`

Args (positional order matters for the Python HTTP caller):
`source: string, target: string, kind: string, label: string, payload_json: string`

Any identity may call it (browser or backend). Validation: node ids from the list below,
kind matches `^[a-z]+(\.[a-z_]+)+$`, label <= 120 chars, payload_json valid JSON object <= 2048 bytes.

## Node ids

| id        | what it is                                                   | where it runs |
|-----------|--------------------------------------------------------------|---------------|
| camera    | webcam capture                                               | browser       |
| mediapipe | MediaPipe FaceLandmarker -> LipFrame                         | browser worker|
| mic       | microphone capture                                           | browser       |
| audio     | formant / loudness analysis (vowel-mapper worklet)           | browser       |
| stt       | Cartesia Ink speech to text                                  | Cartesia      |
| tts       | Cartesia Sonic text to speech (Ava's voice)                  | Cartesia      |
| backend   | FastAPI app (`backend/`)                                     | server        |
| pitch     | librosa F0 extraction                                        | server        |
| sparc     | SPARC articulatory model service (`services/articulation`)   | server        |
| db        | SpacetimeDB                                                  | maincloud     |
| claude    | Anthropic Claude (coach decisions, notes, insights)          | Anthropic     |
| ui        | the learner's screen                                         | browser       |

## Event kinds and payloads

| kind               | source -> target    | payload (JSON)                                                         |
|--------------------|---------------------|------------------------------------------------------------------------|
| camera.on / camera.off | camera -> mediapipe | `{}`                                                                |
| lip.frame          | mediapipe -> db     | `{ok, opening, width, rounding, spread, jaw, yaw}` numbers 0..1 / deg  |
| lip.batch          | mediapipe -> db     | `{frames, seq}`                                                        |
| audio.frame        | audio -> db         | `{f1, f2, rms, env}` env = 32 floats 0..1 downsampled envelope         |
| audio.batch        | audio -> db         | `{frames, seq}`                                                        |
| stt.open / stt.close | mic -> stt        | `{}`                                                                   |
| stt.transcript     | stt -> ui           | `{text, final}` text truncated to 80 chars                             |
| tts.token          | backend -> tts      | `{}`                                                                   |
| tts.speak          | ui -> tts           | `{chars, voice}`                                                       |
| tts.audio          | tts -> ui           | `{ms}` duration of audio received                                      |
| coach.request      | ui -> backend       | `{sound, mode}`                                                        |
| coach.decision     | backend -> ui       | `{verdict, cue}`                                                       |
| claude.request     | backend -> claude   | `{model, purpose}` purpose in decide, word, notes, insight, session, ask |
| claude.response    | claude -> backend   | `{model, purpose, latencyMs, inputTokens, outputTokens, line}` line <= 120 chars |
| claude.error       | claude -> backend   | `{model, purpose, latencyMs, error}`                                   |
| pitch.extract      | backend -> pitch    | `{seconds}`                                                            |
| pitch.result       | pitch -> backend    | `{f0Mean, f0Min, f0Max, voicedPct, latencyMs}`                         |
| sparc.request      | backend -> sparc    | `{seconds}`                                                            |
| sparc.features     | sparc -> backend    | `{tongueHeight, tongueFront, jawOpen, lipForward, lipAperture, latencyMs}` |
| sparc.skipped      | backend -> sparc    | `{reason}`                                                             |
| db.read / db.write | backend -> db       | `{table, rows}`                                                        |
| video.score        | backend -> ui       | `{verdict, okFrames}`                                                  |
| ui.join            | ui -> db            | `{sid, ua}` ua = coarse device class: phone, tablet or desktop; label "learner joined" |
| ui.ping            | ui -> db            | `{sid}` every 20 s while the tab is visible                            |
| ui.leave           | ui -> db            | `{sid}` on `pagehide`, best effort                                     |
| ui.quality         | ui -> db            | `{tier, level, reason, gpuTier, fps, renderer, isMobile}` the guide's display tier (full, light, simple), on the first decision and every change; label "quality <tier>". level is the rung (full, full-dpr, full-dots, light, simple); reason e.g. software-renderer, gpu-tier-1, url, user, auto, fps-low, fps-high, fps-fallback, 3d-failed; gpuTier is detect-gpu's 0..3 or null; fps is the average that triggered an automatic step, else null; renderer is the WebGL renderer string truncated to 60 chars |

Rates: lip.frame and audio.frame are throttled to at most 5 per second each by the browser.
Everything else is one event per occurrence.

## Session id and presence

Every browser event carries `sid` in its payload: an anonymous per-tab id (8 lowercase hex chars from
`crypto.getRandomValues`, kept in `sessionStorage` under `articulate.telemetry.sid`, in memory if storage is
blocked). It identifies nothing about the person and is not linked to any profile. The client adds it to every
`emit` unless the payload already has one, and emits `ui.join` once the connection is ready (never from the
dashboard page itself).

Presence rule on the dashboard: any event whose payload has a `sid` marks that session live as of the event time.
A session is dropped on `ui.leave` or after 60 s without any event (pings every 20 s keep an idle visible tab alive).
The header shows "N learners live" and the Learner node shows one dot per live session (24 at most, then "+N").

## Browser client

`web/src/telemetry/client.ts` exports:
- `emit(source, target, kind, label, payload)` fire-and-forget, no-op when disconnected. Adds `sid`.
- `emitWhenReady(...)` the same, except an event raised before the connection is ready is held (8 at most)
  and sent once it is (used for `ui.quality`, decided at startup).
- `getSessionId(): string` the anonymous per-tab id.
- `subscribeTelemetry(cb: (e: TelemetryEvent) => void): () => void` live inserts, newest first on backfill.
- `TelemetryEvent = { id: string; at: number; source; target; kind; label; payload: Record<string, unknown> }`

## Python

`backend/app/telemetry.py` exports `emit(source, target, kind, label, payload: dict)`.
Fire-and-forget on the running event loop (thread-safe via `call_soon_threadsafe` when called
from a worker thread). No-op when `spacetime_uri` is not configured. Never raises.

## Publishing the module (teammate's machine)

```
cd spacetimedb
spacetime publish articulate-live --server maincloud        # or the configured server
spacetime generate --lang typescript --out-dir ../web/src/module_bindings --project-path .
```
Commit the regenerated `web/src/module_bindings` and open a PR. The hand-written bindings in
this branch match the generated shape and are a stopgap until then.

## Perception streams (added after PR #13)

Two richer browser events let the dashboard draw the MediaPipe wireframe and a spectrum-reactive
audio node. Both are throttled to 10 Hz per tab and stay well under the 2048-byte payload cap.

| kind           | source -> target  | payload (JSON)                                                              |
|----------------|-------------------|-----------------------------------------------------------------------------|
| lip.mesh       | mediapipe -> db   | `{sid, pts}` pts = flat int array `[x0,y0,x1,y1,...]`, 81 points, 0..255   |
| audio.spectrum | audio -> db       | `{sid, bins, rms}` bins = 32 ints 0..255, rms 0..1                          |

`lip.mesh` point order (MediaPipe FaceLandmarker indices):
1. OUTER_LIP, 20 points: 61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185
2. INNER_LIP, 20 points: 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191
3. FACE_OVAL, 36 points: 10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
4. Eyes, 4 points: 33, 133, 362, 263
5. Nose tip, 1 point: 1

Coordinates are normalised into a square centred on the nose tip (index 1) with half-size
1.6 x the inter-ocular distance (midpoints of 33/133 and 362/263), then quantised to 0..255 and
clamped. x grows to the viewer's right, y grows downward. Emitted only for frames MediaPipe
accepted (a face was found), whether or not the LipFrame quality flags passed.

`audio.spectrum` bins are 32 log-spaced bands from an AnalyserNode (fftSize 1024, smoothing 0.6)
over `getByteFrequencyData`, covering roughly 80 Hz to 8 kHz. Emitted whenever a microphone
stream is open, not only during recording attempts. `rms` is the time-domain RMS of the same block.
