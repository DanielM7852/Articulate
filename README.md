# Articulate

Visual speech practice for deaf and hard-of-hearing learners who choose spoken
communication. A learner picks a vowel, sees a 3D mouth demonstrate it, holds the
sound while a live F1/F2 cursor shows where their voice sits, and gets one grounded
cue back.

## Layout

| Directory | What it is | Run |
| --- | --- | --- |
| [`web/`](web/README.md) | The practice app (React + Vite). Sign-in, onboarding, practice studio, summary. Hosts the live vowel graph and the 3D mouth reference. | `cd web && npm install && npm run dev` |
| [`backend/`](backend/README.md) | Audio and coaching service (FastAPI). `/v1/coach` phrases the practice feedback, `/v1/speech` speaks lines with Cartesia, `/v1/comparisons` measures intonation against a reference. The web dev server proxies `/v1` here. | see `backend/README.md` |
| [`vowel-mapper/`](vowel-mapper/README.md) | On-device F1/F2 formant engine (AudioWorklet + Worker, Burg LPC) with its own standalone test page and unit/e2e tests. The web app imports `vowel-mapper/src/audio` directly. | `cd vowel-mapper && npm ci && npm run dev` |
| [`mouth-demo/`](mouth-demo/README.md) | 3D hologram mouth demonstration (three.js, optional TalkingHead) with front and side-cutaway views. The web app imports `mouth-demo/src/mouth-demo.js` directly. | `cd mouth-demo && npm install && npm run dev` |
| `apps/web/`, `services/api/`, `spacetimedb/`, `packages/contracts/` | The coaching backbone workstream: a session controller with versioned contracts, Parselmouth formants, Moss retrieval, a Cartesia WebSocket voice and SpacetimeDB persistence. Independent of `web/` and `backend/`. | see [Backbone](#backbone) |
| `docs/` | Contracts and notes: [`backend-contract.md`](docs/backend-contract.md), [`protocol.md`](docs/protocol.md), [`coaching-agent.md`](docs/coaching-agent.md), [`limitations.md`](docs/limitations.md), [`sponsor-integration.md`](docs/sponsor-integration.md), [`live-metrics.md`](docs/live-metrics.md). | |

## CV data collector

See [docs/vision-collector.md](docs/vision-collector.md) for the standalone camera
collector and integration contract. Open `/vision.html` in the `apps/web` workspace to
inspect/export full landmarks, blendshapes, geometry, pose, quality, timing and
optional images without the backend. Import `apps/web/src/cv/index.ts` for integration.

## Audio articulation data: SPARC, ARTI-6 and Silero

The independent [model collector](services/articulation/README.md) adds SPARC tongue,
lip and jaw estimates, ARTI-6 velum/tongue-root/larynx proxies, and Silero speech
activity. It provides a local Python/HTTP interface and typed browser client for
later agent integration. Models use explicitly prepared, pinned local checkpoints.

## Quick start

```powershell
# 1. Practice app
cd web
npm install
npm run dev          # http://localhost:5173

# 2. (Optional) coaching backend, in another terminal
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
copy .env.example .env
.venv\Scripts\python -m uvicorn app.main:app --reload   # http://127.0.0.1:8000
```

The app works without the backend: coaching falls back to a local grounded response
and narration falls back to the browser voice. The vowel graph and the 3D mouth run
entirely in the browser.

`web/` depends on sibling source in `vowel-mapper/src/audio` and `mouth-demo/src`
through Vite aliases, so clone the whole repository rather than `web/` alone.

## Backbone

Requirements: Python 3.12, uv, Node 22.12+.

```powershell
Copy-Item .env.example .env
uv sync --frozen --extra dev --extra moss
npm ci
uv run --no-sync uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8000
npm run dev          # apps/web on http://127.0.0.1:5173
```

Default `MOCK_MODE=true` makes no provider requests. Included cues are unreviewed
engineering drafts; see `content/cues/README.md` and `docs/provider-verification.md`
before configuring real providers. `/health/live` and `/health/ready` report status.

## Honesty notes

- Formant positions are acoustic estimates on fixed axes, not personalised targets
  and not a pronunciation score.
- Mouth demonstrations are illustrative and would be reviewed by speech therapists
  before real use. The avatar (`mouth-demo/public/avatars/brunette.glb`) is CC BY-NC 4.0.
- Recordings stay in memory in the browser; only attempt summaries persist.
