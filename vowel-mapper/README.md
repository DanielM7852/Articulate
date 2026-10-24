# Articulate: standalone vowel mapper

First implementation on `Karsten-2d-f1-f2`. React + TypeScript + Vite. All audio
analysis happens on the device; there are no backend calls, API keys, recordings,
or uploads. Start opens the default microphone. Finish releases it and retains
the recent trace. Starting again clears the previous session.
If audio delivery stalls, the old dot fades and the status shows **Audio paused**.

## Run

Use Node.js 22.12+ (tested on 24.12).

```sh
cd vowel-mapper
npm ci
npm run dev
```

Open the printed localhost URL in desktop Chrome and allow microphone access.
Choose the built-in microphone in your OS/browser input settings. Microphone and
AudioWorklet access require localhost or HTTPS. No paid services are required.

## First live check

1. Find a relatively quiet spot and press Start.
2. Hold **eee** (sheep), **ah** (father), and **oo** (boot), separately first.
3. Check for distinct positions: ee should generally be left of oo; ah lower.
   Then glide gradually between them. This is an acoustic orientation check,
   not a pronunciation assessment.
4. Stop speaking. The dot should fade instead of presenting noise as a new vowel.
5. Press Finish. The browser mic indicator should turn off and the trace remain.
6. Press Start again. The old trace should clear.
7. Repeat in the venue and with another adult voice. Note failures rather than
   treating a visually smooth cursor as evidence of accurate formants.

The **Tracking details** disclosure shows raw F1/F2, accepted/analyzed frame
counts, sample rate, and an adjustable formant ceiling. Change the ceiling only
between sessions. Start at 5500 Hz; try 5000 or 6000 if a sustained vowel is
consistently mis-tracked. Fixed axes are F1 180–1200 Hz and F2 500–3500 Hz; they
do not auto-normalize speakers or define individualized target zones.

## Modules and integration

- `src/audio/estimator.ts`: pure `estimateFormants(frame, sampleRate, settings)`.
  Input is 30–100 ms of mono PCM; capture uses 50 ms. Returns a discriminated
  valid/rejected result, raw formants, RMS and periodicity. Confidence is a
  heuristic about tracking, not a probability of correct pronunciation.
- `src/audio/tracker.ts`: `VowelTracker.push(estimate, timestampMs)` acquires
  consecutive voiced frames, smooths measurements, confirms large jumps, and
  separates trail segments across gaps.
- `src/audio/capture.ts`: `createMicrophoneSession({ onFrame, onError, stream?,
  signal?, settings? })` returns `{ stop, sampleRate, deviceLabel }`. When the
  caller supplies a stream, `stop()` disconnects this analysis graph but **does
  not stop the caller's tracks**. Otherwise it owns and releases the microphone.
- `src/components/VowelPlot.tsx`: display-only plot receiving `trace`, `point`,
  and `faded`. Copy it with `plot.ts`, the point type, and relevant styles.
- `src/useVowelSession.ts` and `src/App.tsx`: standalone testing wrapper, with
  Start/Finish, errors, counters, and a bounded in-memory recent trace.

Jordan can pass the shell's microphone stream to the capture API, and pass
tracked points into `VowelPlot`. Omkar's future handoff should summarize an
explicit target-vowel attempt. Do not average a free glide into a single vowel.
No coach, Convex, target scoring, or anatomical outline is integrated yet.

## Zone game (first slice, provisional)

The **Game** switch above the plot turns the mapper into an osu!-style practice round.
A warm-up holds eee, ah and oo; each zone is centred on the median of that phase's
tracked points with a radius in log-frequency space (no textbook values). Four words
follow (`ah` hold, `hi`, `how`, `we` glides). Consonants such as *h* are visual cues,
never scored. Each note ends as **hit**, **miss**, or **not heard clearly** (too few
accepted frames; never counted as a miss). Timing is visual only, and self-paced is the
default; timed rings are optional. A hit means "reached the zone you set," not a
judgement of speech.

- `src/game/zones.ts`, `calibration.ts`, `beatmap.ts`, `run.ts`: pure TypeScript driven
  only by `TrackedFrame`s, unit-tested in `tests/game.test.ts`.
- `src/game/GameMode.tsx`, `GameOverlay.tsx`, `game.css`: UI. The overlay draws through
  `VowelPlot`'s `overlay` slot with `projectVowel`; frames arrive via
  `useVowelSession(settings, { onFrame })`.
- `e2e/game.spec.ts` drives the round with switchable synthetic vowels through the real
  worklet/worker/tracker path.

`MAPPER_PORT` picks the dev/preview port (and the port Playwright starts or reuses), for
example `MAPPER_PORT=5175 npm run dev` or `MAPPER_PORT=5175 npm run test:e2e`.

## Audio approach

AudioWorklet captures 50 ms windows every 25 ms. A Worker performs antialiased
resampling, centering, voicing checks, pre-emphasis, Hann windowing, order-10 Burg
LPC, polynomial root extraction, and frequency/bandwidth filtering. It estimates
several resonances before selecting F1/F2. A one-frame backpressure limit drops
work instead of queuing delayed cursor positions. Accepted estimates use an
80 ms log-domain smoother. No part of the raw mic signal is played back.

This borrows the established Burg LPC approach, **not a complete implementation
or guaranteed match of Praat**. Parameters and windowing differ. References:
[Praat formant analysis](https://www.fon.hum.uva.nl/praat/manual/Sound__To_Formant__burg____.html),
[AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet).

Silence, unvoiced broadband noise, clipping and implausible estimates are gated.
When noise broadens F1 past the bandwidth limit, the frame is rejected rather than
relabelling F2 as F1. Noise can still cause F2 to be dropped and F3 reported as F2
(known gap, covered by expected-fail tests), so a loud room can show a second cluster.
This is **not speaker separation**: nearby voiced speech can still move the dot.
Browser echo cancellation, noise suppression and automatic gain control are
requested off to preserve the spectrum; devices may not honor every constraint.
Do not play a coach's audio through speakers while this prototype is tracking.
Higher-pitched/atypical voices, consonants, transitions, and overlapping speakers
can be mis-tracked. Actual acoustic accuracy and suitability for Deaf users
still require real-voice and user testing. The visual map is not exact anatomy.

## Checks

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
MAPPER_PREVIEW=1 npm run test:e2e -- --grep 'synthetic microphone'
```

Unit tests use independently specified source/filter synthetic vowels, noise,
silence, clipping, invalid input, smoothing/gaps/jumps, and axis orientation.
Playwright sends synthetic vowel audio through Chromium's fake microphone,
exercising the actual worklet, worker and rendering path. It checks capture
release, restart, permission errors/cancellation, externally owned streams,
stalled/resumed audio, and mobile layout/readability. The final command checks
the built production bundle (run the build first). Screenshots are written to
ignored `test-results/`.

These checks do not establish performance on a real built-in microphone or in
the hackathon venue. Dependencies are locked in `package-lock.json`.
