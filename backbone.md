# Visual Speech Coach Backbone Implementation Brief

## Mission

Implement the working backbone of a visual speech-practice application for a Cal Hacks demo. The learner selects a vowel, makes a short attempt, sees measured visual feedback, receives one grounded cue, and retries. Optimize the delay between an attempt ending and useful feedback appearing or playing.

This brief is an implementation instruction for a coding agent. Build and verify code, not merely a plan. Inspect the existing repository and its instructions first; preserve working components and adapt the proposed layout to its conventions. If no repository exists, create a small monorepo. Do not deploy paid infrastructure or publish publicly without authorization. Missing credentials must not prevent a runnable mock mode, but mocks must be visibly labeled and must never be reported as real integrations.

The core assignment is the Moss–Claude–Cartesia feedback pipeline, browser playback, session coordination, SpacetimeDB persistence, and instrumentation. Supply a minimal UI and feature-input adapters to exercise the complete loop. Full anatomical modeling and neural articulation estimation are separate workstreams.

## Locked technology choices

| Layer | Choice | Responsibility |
| --- | --- | --- |
| UI | React, Vite, TypeScript | Practice screen, captions, audio controls, diagnostics |
| Styling | Tailwind; shadcn/ui where useful | Simple accessible controls |
| Browser media | Web Audio, AudioWorklet, Canvas | Microphone capture, progressive playback, cursor |
| Python service | FastAPI, asyncio, Pydantic | Feature ingestion, orchestration, validated events |
| Acoustic adapter | Parselmouth and NumPy | F1/F2 and capture-quality features |
| Camera adapter | MediaPipe Face Landmarker | Optional visible lip metrics, computed in a worker |
| Reasoning | Direct Anthropic Python SDK | One bounded coaching decision per attempt |
| Retrieval | Moss Python SDK | In-process retrieval from a loaded cue index |
| Speech | Direct Cartesia SDK/API | Cached cue generation and live streaming TTS |
| Shared state | SpacetimeDB TypeScript module | Sessions, attempts, accepted decisions, observer synchronization |
| Reference viewer interface | React Three Fiber, Three.js, Drei | Consume approved pose IDs; minimal placeholder initially |
| Hosting target | Vultr plus SpacetimeDB Maincloud | Frontend/Python on Vultr; database module on Maincloud |

Do not add Fetch.ai, Convex, Vercel, a second vector database, or an agent framework. Runpod/SPARC and TalkingHead are out of scope. Pipecat is a reference implementation, not a required dependency. Verify current SDK signatures and pin compatible versions in lockfiles; examples in documentation may target different versions.

## Architecture and ownership

There are two independent paths:

1. Continuous feedback: microphone samples → acoustic worker → feature events → browser cursor. Camera metrics are optional and local to the browser. This path never waits for retrieval, an LLM, TTS, or database persistence.
2. Attempt feedback: finalized features → loaded Moss index → bounded Claude decision → controller validation → captions/reference pose plus cached audio or streamed Cartesia audio. Persistence follows through an asynchronous outbox.

The Python controller owns the active attempt and accepts or rejects coaching proposals. SpacetimeDB stores durable shared state, but a database outage must not freeze a local practice attempt. Observer commands are validated and serialized by the controller; do not allow two independent authorities to change the active exercise.

Keep API keys server-side. Browser connections must be authenticated or scoped to an unguessable development session capability; document the difference between local demo authentication and production authentication. Validate ownership on every session operation. Database read restrictions must prevent one session from subscribing to another session's private records.

## Deliverable layout

Suggested structure; adapt if the repository already has conventions:

```text
apps/web/src/           practice UI, capture, playback, event client
services/api/app/      routes, controller, schemas, providers, metrics
services/api/tests/    meaningful unit and integration tests
spacetimedb/           tables, reducers, permissions, generated bindings
packages/contracts/   versioned schemas and shared fixtures
content/cues/          reviewed cue records and provenance
scripts/               index preparation, audio preparation, benchmarks
fixtures/              labeled synthetic features and permitted recordings
deploy/                Docker and reverse-proxy configuration
README.md              setup, modes, commands, limitations
.env.example           placeholders only
```

## Shared contracts

Use schema version 1, UUIDs for IDs, and integer sequence numbers. Generate TypeScript types from a canonical schema or add a contract test to prevent Pydantic/TypeScript drift. Do not duplicate untested definitions.

Every JSON event uses:

```json
{
  "schema_version": 1,
  "type": "coach.decision",
  "session_id": "uuid",
  "attempt_id": "uuid-or-null",
  "generation_id": "uuid-or-null",
  "event_id": "uuid",
  "seq": 12,
  "payload": {}
}
```

Define and validate these records:

| Record | Required information |
| --- | --- |
| Session | owner, target ID/version, language, audio enabled, assistance level, controller revision |
| FeatureFrame | sample-relative timestamp, F1/F2 or null, optional F0, validity, quality flags, optional normalized lip metrics |
| AttemptSummary | target/version, capture interval, usable duration/fraction, acoustic statistics, target distance if defined, visible metrics, quality flags, evidence field IDs |
| Cue | stable ID, version, reviewed text, target IDs, language, difficulty, applicability conditions, source URL, review status, pose ID |
| CoachingDecision | observation text, evidence field IDs, cue ID/version, pose ID, next action, optional brief narration |
| AudioManifest | exact text hash, cue/version, model ID, voice ID, language, generation settings, encoding, sample rate, audio location/hash, optional timing location |

Never encode missing measurements as zero. Optional metrics must remain absent/null when unavailable. Store observed video metrics separately from acoustic estimates. Do not represent F1/F2 as measured tongue or throat coordinates.

Allow next actions only from: repeat, change_cue, simplify, reduce_assistance, next_target, pause, repair_capture. Any new target or pose must exist in the approved registry.

Validate returned evidence references against the current summary. Reject unknown cues, wrong target/language/version, unapproved content, stale attempt IDs, and expired generation IDs. Schema-valid text is not automatically factually supported: restrict observation wording to supported fields and do not permit unsupported anatomical corrections.

## Session lifecycle and APIs

Implement a small explicit state machine:

```text
ready → capturing → analyzing → coaching → presenting → ready
```

Pause/cancel is available from every active state. Invalid capture routes to repair_capture without treating the attempt as a pronunciation failure. A new attempt cancels obsolete feedback work. The microphone must not score coach playback as learner speech.

Provide:

- POST /api/sessions: create an authorized session; return session ID and connection details.
- WebSocket /api/sessions/{id}/events: commands and JSON feature/feedback/status events.
- WebSocket /api/sessions/{id}/audio: PCM transport with explicitly negotiated formats and binary framing.
- GET /api/sessions/{id}/snapshot: recover current state after reconnect.
- GET /api/audio/{cache_key}: serve approved cached audio with appropriate authorization/cache policy.
- GET /health/live and /health/ready: distinguish process liveness from provider readiness.

Commands: session.configure, attempt.start, attempt.end, feedback.cancel, session.pause, session.resume. Events: session.state, features.frame, attempt.summary, coach.decision, audio.start, audio.end, audio.cancelled, provider.status, error.

Document binary framing, generation identity, sequence, sample offset, channel count, encoding, and sample rate. Separate upload and playback frame types so microphone bytes cannot be mistaken for TTS audio. Bound queues and reject malformed frames. Drop obsolete frames by generation ID; never replay a queue of stale cues after reconnection.

## Moss integration

1. Prepare the cue index outside the learner request path. Index only content explicitly approved for use; mark seed demonstration content honestly if it has not received professional review.
2. Load it once per Python worker at startup, await readiness, and perform a warm-up query. Do not create or reload the index per attempt.
3. Use built-in local embeddings initially. Keep queries and results in the process that calls Claude.
4. Construct the query directly from target, permitted observations, and requested cue style. Do not make an extra LLM call just to decide whether to retrieve or write the retrieval query.
5. Filter by target, language, review status, and difficulty using verified SDK capabilities. Exclude previously unsuccessful cue IDs in application code where needed. Retrieve a small configurable candidate set, initially three eligible cues; overfetch if exclusions would otherwise remove every result.
6. Provide exact reviewed text, applicability conditions, source IDs, and pose IDs to Claude. Similarity score is not confidence that a cue is appropriate.
7. Prefetch likely candidates when an exercise is selected. Cache by target/version, language, difficulty, corpus revision, and relevant history revision; revalidate against finalized measurements before selection.
8. Empty results trigger a configured approved fallback or a clear unavailable state. Never fabricate a cue or source.

Moss documents in-memory retrieval and hardware-dependent sub-10 ms expectations. Measure our deployed runtime; do not claim that number as our result.

## Claude decision path

Use one short structured decision call for immediate feedback. The prompt includes a compact finalized summary, eligible cue candidates, recent cue outcomes, and the allowed output schema. Do not send raw camera frames or long recordings for the initial demo.

Prefer selecting an existing cue ID over rewriting its instructions. Resolve the canonical text and pose server-side. Keep optional personalized narration to one or two sentences. Captions and audio must correspond to the accepted content.

Never send partial JSON or an unvalidated decision to TTS. Validate the complete short decision first. For this MVP, this means dynamic narration is fully available before synthesis; stream audio output immediately. Implement incremental sentence input only as a later mode if each sentence can be independently validated before speaking. Do not promise token-level streaming while simultaneously waiting for a final JSON object.

Set configurable deadlines and handle rate limits. Retry only while the attempt/generation remains current. Use a reviewed deterministic fallback where applicable. Curriculum planning may run after the immediate cue is accepted; it must not delay playback or overwrite a newer user action.

## Cartesia audio preparation and caching

Create an idempotent preparation script that generates reviewed cue audio and word/phoneme timestamps where supported. Inspect actual generated examples before presenting them as reference speech. Generated examples are demonstrations, not universal acoustic targets.

Use a cache key derived from exact text, cue/content version, model, voice, language, speed/emotion/volume settings, output format, and any pronunciation settings. Audio and timing metadata must be an atomic matched pair. Never reuse stale timings with regenerated audio.

Preload the likely cue clips and timing data in the browser on exercise selection. A cached cue should still be selected from the current accepted decision. Common capture and control messages may use deterministic rules plus cached clips without an LLM call.

## Cartesia live output

- Open a reusable TTS WebSocket for each active practice session; connect before feedback is needed. Clean up idle/disconnected sessions and respect provider concurrency limits.
- Use a new provider context ID for each utterance and track it against generation_id.
- Our initial path supplies a complete validated sentence or short utterance. Explicitly use custom buffering with max_buffer_delay_ms = 0; signal the final input with continue: false or the SDK equivalent.
- If incremental text is later added, retain one context for that utterance, preserve spaces/punctuation, and finalize it. Do not reuse expired contexts.
- Do not combine application-side sentence aggregation with Cartesia's default managed buffering. The documented managed default is a maximum 3000 ms window, not a guaranteed three-second delay. Setting zero is appropriate only because we provide coherent text chunks ourselves.
- Stream returned audio through the backend immediately. Normalize the provider's response into the documented binary client protocol; do not expose credentials.
- Normalize word/phoneme timing events into generation-relative offsets for the frontend. Missing phoneme timing must not block captions or audio; use a static pose fallback.
- Cancel generation when interrupted, but also clear backend and browser queues. Cancellation at the provider alone cannot retract already-buffered audio.

Do not hardcode a model alias without checking availability and listening to it. Pin the chosen model/voice in configuration and include them in metrics and cache keys.

## Browser playback and reference interface

Implement a progressive PCM queue/ring buffer in an AudioWorklet. Convert encoding and resample if the actual AudioContext rate differs. Handle underruns, bounded buffering, cancellation, and reconnect. Do not accumulate the full response and then create one AudioBuffer before playback.

Make startup buffer configurable; begin testing around 60–120 ms, then tune from measured underruns. This is an experimental setting, not a latency guarantee. Resume AudioContext from a user gesture. Display an audio-unavailable state if autoplay is blocked.

Record audio.playback_started when the first samples are actually scheduled/consumed, not when the first network packet arrives. Use the playback clock for captions and authored pose timing. Packet arrival time is not animation time. Reset all offsets on cancellation.

Expose a reference adapter with setPose(pose_id), playTimeline(generation_id, timings), and stop(generation_id). A labeled static placeholder is acceptable for backbone completion. Do not imply the placeholder represents the learner's anatomy.

The complete interface must work muted. Display accepted captions and the reference cue immediately without waiting for TTS. Keep display timing and audible timing as separate metrics.

## Feature adapters

Provide a fixture mode and a real microphone path. Fixtures must be clearly labeled synthetic or recorded.

For real capture, negotiate the actual sample rate; do not assume the browser honors the requested rate. Send bounded PCM chunks with sample indices. Run Parselmouth analysis in a worker/executor, not on the WebSocket event loop. Maintain a rolling analysis buffer, with configurable frame/window parameters and speaker-appropriate formant ceiling. Validate settings against the underlying Praat API.

Emit F1/F2 and quality indicators; silence, clipping, implausible values, and insufficient usable speech produce invalid frames. The cursor pauses/fades for invalid input. Apply documented smoothing without pulling the cursor toward the target. Aim initially for 20–30 feature updates/second and measure performance.

Targets have explicit provenance/version and configurable regions. Initial calibration does not establish correct pronunciation. If microphone tracking is unreliable, retain the feature-input adapter so another measurement implementation can replace it without changing coaching contracts.

MediaPipe integration is secondary to the feedback backbone. Its adapter may be unavailable, but must then supply no lip evidence. Reject coaching claims based on absent video measurements.

## SpacetimeDB integration

Tables: sessions, attempts, coaching_decisions, cue_outcomes, and optionally observer_commands. Store compact summaries, not raw audio, video, or every feature frame.

Reducers validate ownership, expected revision, IDs, and allowed transitions. Use stable event IDs for idempotent writes. Duplicate writes must not duplicate attempts. Only the authorized backend may commit accepted coaching decisions; a browser cannot forge a measured result.

Keep external provider calls in Python. Implement a durable local outbox (SQLite is acceptable as a retry spool, not a competing application database). Persist pending events locally before acknowledging durability, retry with bounded backoff, expose pending-sync state, and reconcile on reconnect.

Verify the supported Python-to-SpacetimeDB API for the pinned version. If a typed Node bridge is needed, keep it small and authenticate it. Document the exact chosen transport; do not invent SDK methods. Observer commands need IDs, revisions, and acknowledgements so duplicate subscriptions cannot restart attempts.

## Instrumentation and evaluation

Log structured timestamps, statuses, versions, cache hit/miss, and identifiers. Avoid raw media, full prompts, and sensitive user content in ordinary logs.

Measure:

| Interval | Purpose |
| --- | --- |
| Capture end → summary ready | End detection and measurement latency |
| Moss query start → results ready | Retrieval latency |
| Claude request → validated decision | Useful reasoning latency |
| TTS submission → first provider audio | Synthesis and provider network latency |
| Browser first audio receipt → playback start | Playback buffering |
| Attempt end → visible feedback | Visual experience |
| Attempt end → audible feedback | Spoken experience |

Use monotonic clocks within each process. Do not subtract timestamps from unsynchronized browser/server clocks. Measure user-visible end-to-end intervals on the browser clock; correlate server stage spans by IDs. Report output sample scheduling separately from measured hardware sound if loopback measurement is unavailable.

Benchmark cold start, warm uncached TTS, and warm cached cues separately. Use repeatable fixtures, at least 30 runs per comparison when feasible, and report median, p95, failures, cache state, and environment. No invented benchmark numbers or therapy outcomes. Measure correct first feedback, not filler speech that merely masks a wait.

## Build order and completion gates

1. Repository audit, contracts, configuration, and labeled mock providers. Gate: one fixture attempt yields captions and a reference-pose event.
2. Browser progressive audio playback and cancellation. Gate: delayed-chunk fixture plays before completion and stops without stale audio.
3. Real Moss loading and retrieval. Gate: approved candidate retrieval, history exclusions, empty-result behavior, startup readiness.
4. Claude bounded decisions. Gate: validated cue selection; malformed and unsupported responses fall back safely.
5. Cartesia preparation/cache and live streaming. Gate: cached and uncached paths work, timings align, cancel clears all queues.
6. Real microphone adapter and independent cursor. Gate: usable features update during a slow mocked LLM call.
7. SpacetimeDB persistence and observer synchronization. Gate: retries are idempotent, unauthorized reads/writes fail, disconnect recovery works.
8. Integration tests, latency report, Docker setup, and README. Gate: another developer can run mock mode and configure real mode from documented commands.

Keep a single executable vertical slice working after each step. If blocked on credentials or unavailable APIs, complete independent work and report the exact unverified integration.

## Required checks

- Contract/schema tests cover missing metrics and invalid enums.
- Retrieval tests cover target/language filtering, stale corpus versions, exclusions, and no eligible result.
- Decision tests reject unknown cues, unsupported evidence, wrong poses, and stale attempts.
- Audio tests cover format negotiation, chunk ordering, queue limits, partial playback, and interruption with queued data.
- Session tests cover rapid retries, target changes, muted mode, cancellation during Claude/TTS, and provider timeouts.
- Persistence tests cover duplicate events, restart with pending outbox items, authorization, and revision conflicts.
- End-to-end test proves a fixture attempt produces a cue, caption, pose event, audio, and persisted summary.
- Live-provider smoke tests are opt-in and skipped explicitly without credentials. Do not charge APIs during ordinary tests.
- Manual microphone check covers silence, noisy capture, unavailable camera, speaker playback contamination, and browser permission denial.

## Configuration and handoff

Provide .env.example with ANTHROPIC_API_KEY, configured Claude model, MOSS_PROJECT_ID, MOSS_PROJECT_KEY, cue index name, CARTESIA_API_KEY, configured Cartesia model/voice, SpacetimeDB URI/database/backend credentials, allowed origins, cache directory, provider deadlines, playback buffer, and MOCK_MODE. Use actual supported credential names in the implemented adapters and document mappings.

Supply exact install, index preparation, cue-audio preparation, development, test, benchmark, and container commands. Use HTTPS/WSS outside localhost, configure reverse-proxy WebSocket upgrades, and document microphone permissions. Do not place secrets in Vite-exposed environment variables.

Final handoff must state what works with real providers, what is mocked, tests run, measured latency, known limits, and commands to reproduce. Include a small demo script: select target → attempt → cue → retry → cancel → view synchronized attempt history.

## Sources and verification notes

Research checked October 23, 2026. These are implementation references, not proof our code has been tested. Recheck current SDK/API signatures before implementation. Core architecture and cache choices above are our design recommendations.

- Moss core concepts: https://docs.moss.dev/docs/start/core-concepts
- Moss SDK/examples: https://github.com/usemoss/moss
- Moss–Pipecat integration with Cartesia example: https://github.com/usemoss/pipecat-moss
- Cartesia endpoint comparison: https://docs.cartesia.ai/use-the-api/compare-tts-endpoints
- Cartesia buffering: https://docs.cartesia.ai/use-the-api/tts-websocket/buffering
- Cartesia contexts: https://docs.cartesia.ai/use-the-api/tts-websocket/contexts
- Cartesia WebSocket schema and cancellation: https://docs.cartesia.ai/api-reference/tts/websocket
- Cartesia phoneme timestamps: https://docs.cartesia.ai/examples/tts-sse-with-phoneme-timestamps
- Cartesia browser example: https://docs.cartesia.ai/examples/tts-websocket-stream-audio (inspect playback behavior; the reviewed example accumulated chunks before playback)
- Claude structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- SpacetimeDB TypeScript client: https://spacetimedb.com/docs/clients/typescript/
- SpacetimeDB reducers: https://spacetimedb.com/docs/functions/reducers/
- SpacetimeDB Maincloud: https://spacetimedb.com/docs/how-to/deploy/maincloud/
- Parselmouth API: https://parselmouth.readthedocs.io/en/stable/api_reference.html
- MediaPipe Face Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
