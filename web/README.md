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

Every visit starts at sign-in and always runs through welcome, the quiz, setup and the plan before practice. Sign-in and onboarding progress are session-only; preferences and attempt summaries persist.

| Route | Figma frame |
| --- | --- |
| `#/` | Sign in with the mock account (`demo@articulate.app` / `articulate`, set in `src/state/auth.ts`) |
| `#/welcome` | New learner welcome |
| `#/quiz/1` to `#/quiz/3` | Goals, Routine, Comfort |
| `#/setup` | Setup and baseline (live mic meter, optional camera, recorded first try) |
| `#/plan` | Suggested starting plan |
| `#/practice` | Lesson ready, Recording, Feedback and retry (one screen, state machine) |
| `#/summary` | Independent attempt and session summary |

## How the pieces connect

- **F1/F2 vowel graph**: `src/components/VowelGraph.tsx` draws the cursor, trail, target region and hold ring. `src/audio/useVowelTracking.ts` feeds it from the vowel-mapper engine (`../vowel-mapper/src/audio`, imported through the `@vowel-mapper` alias in `vite.config.ts`), running on the same microphone stream `useMicrophone` opens. Target regions live in `src/vowel/targets.ts` and are generic orientation regions, not personalised targets.
- **3D mouth reference**: `src/components/MouthReference.tsx` mounts the mouth-demo hologram (`../mouth-demo/src/mouth-demo.js`, alias `@mouth-demo`) and maps each sound to its cue (ee → spread lips, oo → round lips, ah → open jaw). three.js and the avatar load on first use.
- **Coaching agents (Claude)**: practice posts `{ attempt, history }` to `/v1/coach`. The Vite dev server proxies that to the FastAPI app in `../backend`. The response uses the `CoachResponse` shape in `src/services/coach.ts`. If the request fails, the screen keeps its local wording.
- **Cartesia narration**: `useSpeech` posts the line to `/v1/speech` and plays the WAV. Without a Cartesia key, that call returns unavailable and the browser `speechSynthesis` voice is used.
- **Formant metrics**: guided attempts in Practice fill `timeInTargetSec` and `longestHoldSec` from the on-device tracker. Baseline and independent attempts leave them `null`, since no target is shown.

Because `web/` imports sibling source, clone the whole repository rather than this folder alone.

## What the browser measures today

Input amplitude and a voiced-duration estimate (capture quality: silence, clipping, too short), plus F1/F2 estimates from a Burg LPC tracker that gates silence, noise, clipping and implausible frames. Formant positions are acoustic estimates on fixed axes and are not a pronunciation score. Recordings stay in memory and are never persisted.

## Changes from the Figma

- Sign-in copy now describes speech practice for DHH learners.
- One set of lesson step labels and one lesson title across all practice states.
- Captions and audio are working toggles in the nav, shared across screens.
- Photos replaced with type, icons, SVG, or the live camera; no raster images ship.
- Responsive layout, 12px minimum text, keyboard focus states, ARIA roles on choices.
