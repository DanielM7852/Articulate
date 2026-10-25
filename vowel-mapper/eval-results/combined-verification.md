# Combined verification — October 24, 2026

Combined game `dd2a35d` with vowels `447b099`, sharing patched baseline `4657251`. Resolved only App imports (keep game/calibration and cue preview) and equivalent configurable Playwright port syntax. No changes to `src/audio/` relative to the patched baseline.

| Check | Result |
|---|---|
| `npm ci` | Success; audit reported 0 vulnerabilities |
| `npm test` | 70 passed, 2 existing expected failures, 7 files |
| `npm run build` | Typecheck and production build passed |
| Dev Chromium, port 5185 | 12 passed |
| Production Chromium, port 5186 | 11 passed, 1 explicit dev-source API skip |
| Full offline benchmark | 335 clips, five conditions, 112,300 analysed frames, 47,610 eligible frame records |
| Actual-browser real speech | Four fixtures passed; no page errors; Finish held trace |

The expected failures remain the noisy oo probes at 110/250 Hz pitch and 10 dB SNR. Preview skips the reusable capture source import `/src/audio/capture.ts`, which is unavailable in the built app; that check passes in development. All production UI flows run.

Combined compressed frame output SHA-256:
`4eae37f3f1526518af0ab7ee669680c9372590e822e12eef7507565d91512604`.
This exactly matches baseline and Track A final output. Acoustic tables are unchanged, not improved.

## Real-speech capture

| Fixture | Accepted frames during this run | Last tracked F1/F2, Hz |
|---|---:|---:|
| Repeated 150 ms real vowel excerpt | 98 | 349.6 / 2416.4 |
| Original h-V-d word | 65 | 375.5 / 945.1 |
| Natural sentence with nasals | 38 | 434.2 / 1517.6 |
| Original /eɪ/ glide word | 94 | 410.0 / 2257.0 |

These counts vary with browser timing; they are pipeline observations, not accuracy measurements. The repeated excerpt and Chromium file looping are artificial. The UI does not identify the nasal frames.

Visually reviewed combined held-vowel, natural-glide and natural-sentence captures; each lesson screen; 320px active play; 390/768/1280px layouts. Active mobile words precede the plot, extra calibration targets stay independent, nasal lock reason is visible, and no horizontal overflow was observed. Synthetic lesson tests verify all available routes, microphone release, keyboard operation, calibration retention and separate unheard outcomes. These checks do not validate a human player's voice, Safari, noisy venue, or learning outcomes.

Full logs are outside Git at `/Users/Git/Articulate-overnight/logs/combined-*.log`; final screenshots at `/Users/Git/Articulate-overnight/screenshots/combined/`. Public audio remains outside Git. The independent morning report contains adoption and rollback instructions.
