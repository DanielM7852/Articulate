# Articulate web app

Frontend for the Visual Speech Coach, built from the CalHacks Figma file (Design page).

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

Use Chrome or Edge and allow microphone access. The app uses a hash router, so the built `dist/` folder works on any static host.

## Routes

| Route | Figma frame |
| --- | --- |
| `#/` | Sign in (returning learners go straight to practice) |
| `#/welcome` | New learner welcome |
| `#/quiz/1` to `#/quiz/3` | Goals, Routine, Comfort |
| `#/setup` | Setup and baseline (live mic meter, optional camera, recorded first try) |
| `#/plan` | Suggested starting plan |
| `#/practice` | Lesson ready, Recording, Feedback and retry (one screen, state machine) |
| `#/summary` | Independent attempt and session summary |

## Where teammates plug in

- **F1/F2 vowel graph** and **3D mouth reference**: replace the placeholders in `src/integrations/slots.tsx`. The props (`sound`, `mode`, `stream`, `view`) are already passed by every screen.
- **Coaching agents (Claude)**: set `VITE_COACH_URL` to an endpoint that accepts `{ attempt, history }` and returns the `CoachResponse` shape in `src/services/coach.ts`. Without it, a local response is generated from measured fields only.
- **Cartesia narration**: swap the browser `speechSynthesis` call in `src/audio/useSpeech.ts`.
- **Formant metrics**: `timeInTargetSec` and `longestHoldSec` on `Attempt` stay `null` until the measurement service fills them; the UI shows "—" until then.

## What the browser measures today

Input amplitude and a voiced-duration estimate (capture quality only: silence, clipping, too short). Nothing here is a pronunciation score. Recordings stay in memory and are never persisted.

## Changes from the Figma

- Sign-in copy now describes speech practice for DHH learners.
- One set of lesson step labels and one lesson title across all practice states.
- Captions and audio are working toggles in the nav, shared across screens.
- Photos replaced with type, icons, SVG, or the live camera; no raster images ship.
- Responsive layout, 12px minimum text, keyboard focus states, ARIA roles on choices.
