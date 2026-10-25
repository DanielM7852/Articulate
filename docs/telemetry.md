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
