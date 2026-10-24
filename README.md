# Articulate — visual speech coach backbone

Select a vowel → capture synthetic features or microphone PCM → watch an independent F1/F2 cursor → receive one validated cue and caption → retry, cancel or pause → recover attempt history.

The backbone lives in `apps/web`, `services/api` and `spacetimedb`. The existing `mouth-demo/` remains a separate visual workstream. The backbone uses a labeled static React Three Fiber placeholder through `ReferenceAdapter`; TalkingHead is not a backbone dependency.

## Run locally

Requirements: Python 3.12, uv, Node 22.12+ (tested with Node 24), npm. From this repository:

```powershell
Copy-Item .env.example .env
uv sync --frozen --extra dev --extra moss
npm ci
uv run --no-sync uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8000 --ws-max-size 65536 --ws-max-queue 8 --no-access-log
```

In another terminal:

```powershell
npm run dev
```

Open **http://127.0.0.1:5173**. Default `MOCK_MODE=true` makes no external provider requests. Synthetic mode produces labeled, deterministic feature frames. Mock audio is a quiet 330 Hz diagnostic tone, **not speech or a vowel example**. The complete interface works with Audio off. Microphone input uses actual Web Audio sample rate and real Parselmouth analysis even when coaching providers are mocked. Microphone access needs localhost or HTTPS; permission errors appear on screen.

Demo: select `/i/`, start, wait a second, finish, read the cue, retry, cancel feedback, pause/resume, then reload to recover history. Enable Audio with a user gesture to exercise progressive PCM playback. Developer diagnostics show server stages and browser-clock visual/playback intervals. Hide target guide for an independent attempt; captions stay visible.

## Implemented behavior

- Version 1 Pydantic contracts, generated TypeScript, canonical schema and drift checks; nullable measurements and approved target/pose registries.
- One controller per session: revision-checked commands, IDs/acknowledgements, attempt/generation identity, pause/cancel/retry, capture repair, stale-decision rejection and snapshot recovery. Authorized event clients observe synchronized state; one audio transport is allowed.
- Moss SDK adapter loads once, warms up, caches/prefetches eligible candidates and uses metadata filters, history exclusions, overfetch and canonical text/version checks. Index preparation is outside the learner request path.
- Direct Anthropic structured proposal call with deadlines, supported observation IDs, bounded history, admissible actions and canonical cue resolution. The controller resolves evidence, text, rationale and poses. Unsupported output uses deterministic content or an unavailable/repair state.
- Reusable Cartesia WebSocket per session, new utterance contexts, complete validated text, `max_buffer_delay_ms=0`, `continue=false`, progressive PCM and normalized timing events. Cancellation clears provider/server/browser work. Exact-content caching stores PCM and matching timings atomically.
- AudioWorklet ring playback: 80 ms default startup buffer, linear sample-rate conversion, bounded buffering, underrun reporting and actual worklet-consumption start signals. A separate worklet uploads 40 ms microphone frames; playback stops before recording.
- Worker-thread Parselmouth Burg formants, rolling 120 ms buffer, capture quality heuristics, raw summaries and display-only EMA smoothing. Camera is explicitly unavailable and supplies no lip evidence.
- Private SpacetimeDB tables/reducer for sessions, attempts, accepted decisions, cue outcomes and idempotency; durable SQLite outbox, bounded retries, confirmed HTTP writes and local crash recovery. Raw recordings are not retained.

## Configure real providers

Fill server-side variables in `.env.example`, set `MOCK_MODE=false`, and use a separate `DATA_DIR` such as `.data/real`. Never put credentials in `VITE_*` variables.

Included cues are **unreviewed engineering drafts**. Real retrieval/indexing refuse them. Have an appropriate reviewer approve actual content, target, language, applicability and pose; then update cue versions/corpus revision and prepare a new index. Source URLs record measurement background, not professional approval. Demonstration target regions are not universal pronunciation standards.

```powershell
uv run --no-sync python scripts/prepare_index.py
uv run --no-sync python scripts/prepare_audio.py
```

Index preparation uses locked `moss==1.21.0` / `inferedge-moss-core==0.35.0`, `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY`. The current cue corpus is revision 2; use `MOSS_INDEX=articulate-cues-v2` and rebuild an approved index when upgrading from revision 1. Audio preparation is idempotent and generates three common observation-plus-cue captions per eligible cue (18 clips for the six mock drafts). It incurs provider usage in real mode. **Listen to generated clips before presenting them as reference speech.** `python scripts/prepare_audio.py --mock` prepares diagnostic tones without calls. History-specific captions stream on demand. Prepared manifests/timings and private clips are prefetched on exercise selection.

Set `CLAUDE_MODEL`, `CARTESIA_MODEL` and `CARTESIA_VOICE` explicitly after checking availability and auditioning output. No alias is silently selected. `/health/live` checks process liveness; `/health/ready` reports configuration, retrieval readiness, mock status and corpus availability. “Configured” is not a successful live smoke test.

SpacetimeDB uses the documented HTTP transport directly from Python:

```text
POST {SPACETIMEDB_URI}/v1/database/{database}/call/commit_event?confirmed=true
Authorization: Bearer {SPACETIMEDB_TOKEN}
Content-Type: application/json
Body: ["<serialized version-1 event>"]
```

Use SpacetimeDB CLI **2.13.0**. These are developer commands; this implementation has not published a database:

```powershell
spacetime build --module-path spacetimedb
spacetime publish --server local --module-path spacetimedb articulate-local
# Only when you intend to publish remotely:
spacetime publish --server maincloud --module-path spacetimedb YOUR_DATABASE_NAME
```

The module records the publishing identity at init and accepts writes only from that identity. Configure its token on the backend. All tables are private; browsers use scoped Python snapshots/events and never receive the database token. Stable event IDs make ambiguous HTTP timeouts safe to retry; sync revisions prevent lost updates. Keep the persistent local spool disk: this MVP recovers controller state from that journal and does not rebuild a lost disk from Maincloud. Run **one API process/worker**; distributed controller leadership is not implemented.

## Protocol and observers

`POST /api/sessions` returns an unguessable capability, URLs, registry and snapshot. HTTP session operations require `Authorization: Bearer <capability>`. On each WebSocket send `{"capability":"..."}` first, within five seconds. Capabilities stay in browser sessionStorage; the server stores hashes. They are never URL parameters. Sessions expire after one hour by default. Origin checks apply to creation and WebSockets.

This is local demo capability authentication, not production accounts or clinician permissions. Anyone explicitly given a capability has that session’s control rights. An observer can connect to the events socket with the granted capability, recover history/state and submit revision-checked commands. The same controller serializes them and acknowledges duplicate IDs. For production, add account authentication, scoped observer grants, creation rate limits, retention controls and HTTPS/WSS.

See [docs/protocol.md](docs/protocol.md) for commands, binary framing, queue bounds and reconnect behavior.

## Verification

Develop the coaching agent independently of capture/UI with:

```powershell
uv run --no-sync python scripts/evaluate_coach.py
```

This replays 15 synthetic scenarios and writes `.data/coaching-evaluation.json` containing selected observations, evidence, rationales, actions, captions and provider status. Default mode makes no external calls. `--live` explicitly opts into Moss/Claude usage and requires credentials and approved cues; Cartesia is not called by this evaluation. See [docs/coaching-agent.md](docs/coaching-agent.md) for the teammate integration boundary, prompt, policy and fixture workflow.

```powershell
uv run --no-sync pytest -q
uv run --no-sync ruff check services/api scripts
uv run --no-sync python scripts/export_contracts.py --check
npm run contracts:check
npm run test:audio
npm run test:database
npm run build
npx playwright install chromium
npm run test:e2e
uv run --no-sync python scripts/benchmark.py --runs 30
```

Regenerate contracts with `python scripts/export_contracts.py` then `npm run contracts`. Browser checks start localhost-only servers and exercise fixture feedback, progressive worklet consumption, cancellation, muted/reduced assistance, reload history, denied permission and a **synthetic silent MediaStream** through the capture worklet. Database tests use the official SpacetimeDB WASM datastore harness for duplicates, ownership, revisions, rollback and unauthorized reducer calls.

Live smoke tests are skipped unless `LIVE_PROVIDERS=1` is explicitly set; missing credentials or approved content also skip them. Opting in can incur API usage. Ordinary tests never charge providers. [docs/latency.json](docs/latency.json) contains the initial backbone's 30-run baseline, before adaptive coaching was added. Rerun the benchmark for current timings. These measure local mock-controller enqueue time, not real-provider latency or hardware sound.

## Containers and deployment

```powershell
docker compose -f deploy/compose.yaml up --build
```

Open http://localhost:8080. The example binds to loopback and persists outbox/cache in a volume. Docker was unavailable in the implementation environment, so image builds remain unverified. For Vultr, terminate TLS in front of Nginx, configure the HTTPS allowed origin, preserve WebSocket Upgrade headers and restrict API access to the proxy. No infrastructure was deployed or purchased.

## Limits and handoff

The mock loop, synthetic silent capture path, Parselmouth quality checks, generated contracts, production frontend build and SpacetimeDB datastore tests have been exercised. External Moss/Claude/Cartesia calls, Maincloud network synchronization, generated speech/timings, Docker images and physical microphone/speaker behavior remain unverified. No provider credentials were used.

Before a live demo, manually check sustained vowels from multiple speakers, silence/noise/clipping, missing camera, permission denial, playback contamination, network interruption and cancellation with queued audio. Camera remains unavailable. Reference poses are illustrative static placeholders; `setPose`, `playTimeline` and `stop` are exposed, with timeline animation falling back to the static pose. No anatomical accuracy, clinical outcomes or learned pronunciation improvements are claimed.
