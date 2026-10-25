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
| payload  | string    | JSON object, <= 2048 bytes live (4096 in the unpublished source) |

The reducer keeps at most 400 rows. The deployed module deletes the oldest on insert; the source on
this branch (pending a republish) uses the retention rule in "Retention" below.

## Reducer `emit_telemetry`

Args (positional order matters for the Python HTTP caller):
`source: string, target: string, kind: string, label: string, payload_json: string`

Any identity may call it (browser or backend). Validation: node ids from the list below,
kind matches `^[a-z]+(\.[a-z_]+)+$`, label <= 120 chars, payload_json valid JSON object <= 2048 bytes
(the deployed module; the source says 4096 but has not been republished). The live reducer reports every
rejection with the generic text "The instance encountered a fatal error.", not the thrown message.

### Retention (module source, applies after the next publish)

At most 400 rows. When an insert pushes the count over, the oldest rows among the high-rate kinds
(`lip.frame`, `lip.mesh`, `audio.frame`, `audio.spectrum`, `ui.ping`) are deleted first. Low-rate rows
(everything else: `camera.on`, `ui.join`, `stt.*`, ...) are deleted, oldest first, only while more than
150 of them remain. One pass partitions the ids, then each list is sorted, so a busy lesson streaming at
10 Hz no longer pushes the session's join and camera events out of the table.

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
| backend.up         | backend -> db       | `{provider, model, articulation, pitchTable, coordination, telemetryIdentity}` once at startup when telemetry goes live; label "backend online"; telemetryIdentity is `anonymous` or `configured` |
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

Delivery is visible in the console. In SpacetimeDB 2.13 each reducer accessor
(`conn.reducers.emitTelemetry(...)`) returns a `Promise<void>` that resolves when the reducer commits and
rejects with `SenderError` (the reducer threw) or `InternalError` (host failure), or with an error when the
connection is down. The client counts the outcome per kind and keeps the counters on
`window.__telemetryStats` (always set; it holds no payloads):

```
window.__telemetryStats
// { "lip.mesh": { sent, accepted, rejected, dropped, lastError }, "lip.frame": {...}, ... }
```

- `sent`: reducer calls made; `accepted` / `rejected`: their outcome; `lastError`: the last rejection text.
- `dropped`: emits skipped because the connection was not ready or 20 calls were already in flight
  (throttled emits are not counted).
- The first rejection of each kind logs one `console.warn` with the kind and the payload byte length; a
  subscription error logs once.

## Python

`backend/app/telemetry.py` exports `emit(source, target, kind, label, payload: dict)`.
Fire-and-forget on the running event loop (thread-safe via `call_soon_threadsafe` when called
from a worker thread). Never raises. No-op until `configure` (called from the app lifespan) is live:

- `TELEMETRY_ENABLED=false` turns it off entirely.
- With `SPACETIME_DATABASE` and `SPACETIME_TOKEN` set, events go to that database with that token.
- With no `SPACETIME_TOKEN`, the backend mints an anonymous identity (`POST {SPACETIME_URI}/v1/identity`,
  5 s timeout) in a background task at startup, caches it in the gitignored
  `<STORE_DIR>/telemetry_identity.json` so restarts keep one identity, and emits to `SPACETIME_DATABASE`
  or `TELEMETRY_DATABASE` (default `articulate-live`). The table and reducer are public, so no owner token is
  needed. A failure logs one INFO line and leaves telemetry off; app startup is never blocked.

Once live, the backend emits `backend.up` with its live configuration.

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

## Full face mesh (lip.mesh v3, live)

`lip.mesh` payload version 3 is what the browser emits. It carries all 478 FaceLandmarker points
(468 + 10 iris) so the dashboard can render the learner's face as a barycentric dot cloud over the
canonical tesselation, like Ava's head.

| field | meaning |
|-------|---------|
| v     | 3 |
| n     | 478 (468 when the model returns no iris points) |
| pts   | base64 of n records of 3 bytes: x uint8, y uint8, z uint8 |
| yaw, pitch, roll | head pose in degrees from the LipFrame, one decimal |

Normalisation: the same nose-centred square as v1 and v2 (centre = landmark 1, half-size = 1.6 x
inter-ocular), x and y quantised to 0..255 across the square and clamped; z = landmark z divided by
inter-ocular, mapped from [-0.6, 0.6] to 0..255 (0 = nearest the camera). The dashboard decodes x and y
as byte / 255, the same 0..1 square as v2.

Size: 478 x 3 = 1,434 bytes = 1,912 base64 chars. The worst-case payload with pose and `sid`
(`{v:3,n:478,pts,yaw:-123.4,pitch:-123.4,roll:-123.4,sid:"8626a337"}`) is 1,995 bytes. The browser drops
any mesh payload that would exceed 2,000 bytes (`MAX_PAYLOAD_BYTES` in `useLipTracking.ts`, logged once
at debug level).

Why: the deployed `emit_telemetry` still caps `payload_json` at 2048 bytes. A v2 payload is about
3,256 bytes with the sid, so every v2 emit was rejected and the dashboard's MediaPipe card read "no face"
forever. The 8-bit grid is 1/255 of a square 3.2 inter-oculars wide, about 0.013 x the inter-ocular
distance, finer than the dot face needs. v1 (81 points) is still emitted when fewer than 468 landmarks
exist. Rate stays 10 Hz per tab.

## lip.mesh v2 (replay only)

Version 2 is no longer emitted. The dashboard still decodes it so `web/public/telemetry-demo.json`
(recorded in v2) replays unchanged.

| field | meaning |
|-------|---------|
| v     | 2 |
| n     | 478 |
| pts   | base64 of n records of 5 bytes: x uint16 LE, y uint16 LE, z uint8 |
| yaw, pitch, roll | head pose in degrees from the LipFrame (optional) |

Normalisation: same nose-centred square as v1 (centre = landmark 1, half-size = 1.6 x inter-ocular),
x and y quantised to 0..65535 across the square and clamped; z = landmark z divided by inter-ocular,
mapped from [-0.6, 0.6] to 0..255 (0 = nearest the camera). A v2 payload is about 3.3 KB, which needs
the 4096-byte cap in the module source; the deployed module's 2048-byte cap rejects it. v1 (81 points,
`pts` as an int array) remains valid; the dashboard accepts v1, v2 and v3 and prefers a full mesh.
