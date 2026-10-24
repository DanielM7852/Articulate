# Mouth demo

A 3D face that demonstrates a mouth movement for speech cue practice, built for deaf and hard-of-hearing learners. The face is a silent demonstration model (no speech, no lip-sync) rendered as a navy hologram of sphere dots on a light background. It moves from relaxed into the target mouth shape, holds it while a white-and-navy ring pulses around the lips, then relaxes, and loops calmly. A side view swings the camera to profile and fades in a stylized tongue cutaway.

Mouth demonstrations are illustrative and would be reviewed by speech therapists before real use.

## Run

```
npm install
npm run dev      # harness page at the printed local URL
npm run build    # production build in dist/
```

Everything is served locally; nothing depends on a CDN or network at runtime.

## API

```js
import { createMouthDemo } from "./src/mouth-demo.js";

const demo = await createMouthDemo(containerElement, {
  avatarUrl: "/avatars/brunette.glb",
  driver: "auto",       // "auto" | "talkinghead" | "three"
  style: "hologram",    // "hologram" | "solid"
  controls: true,       // false: host provides its own buttons
});
```

The container needs a height (the component fills it). It builds its own layout: 3D canvas, cutaway panel (hidden until side view), caption line and, with `controls: true`, Replay / Slow-mo / Side view buttons.

| Member | Description |
|---|---|
| `showCue(id)` | Demonstrate a cue (`round-lips`, `spread-lips`, `open-jaw`) and keep looping it. Switching cues eases the old shapes out first. |
| `replay()` | Restart the current cue for the current view. |
| `setSpeed(0.5 \| 1)` | Slow-mo on or off; applies immediately to face, camera, cutaway and effects. |
| `setView("front" \| "side")` | Animated camera swing; side view shows the cutaway. Returns a promise that resolves `true` when the swing ends, `false` if interrupted. |
| `speak({ clock, timeline? })` | Lip sync from streamed timestamps (see Lip sync). Returns `{ append(t), end(), stop() }`. |
| `stop()` | Ease back to neutral and stop looping; clears the caption. |
| `setStyle("hologram" \| "solid")` | Switch look at runtime. |
| `toggleCalibration()` / `handleCalibrationKey(e)` | Highlight ring calibration (see below). `handleCalibrationKey` returns `true` if it consumed the key. |
| `dispose()` | Free GPU resources, listeners and DOM. Safe to call twice. |
| `driverName`, `style`, `view`, `speed`, `cueId`, `speaking` | Read-only state. |

Events are dispatched on the container (they bubble):

- `demo:ready` with `detail: { driver }`, fired once after loading (asynchronously, so listeners added after `await` still receive it).
- `speech:start` / `speech:end` (no detail): the first non-negative `clock()` reading, and the end or stop of that speech (only fires if it started).
- `cue:phase` with `detail: { cueId, phase }` at the start of every phase. Phases: `reset`, `in`, `hold`, `out`, `rest`, `swing`, `relax`. `cueId` is `null` for view-only or stop sequences.

## Lip sync

```js
const speech = demo.speak({
  clock: () => audioSecondsSinceStart,   // negative = audio not started yet
  timeline: { phonemes: [{ p: "AA1", start: 0, end: 0.12 }], words: [{ text: "hello", start: 0, end: 0.4 }] },
});
speech.append({ phonemes: [...] });      // more timestamps as they stream in
speech.end();                            // no more data: relax after the last item
speech.stop();                           // or release now (eases to rest)
```

- Timestamps are seconds from audio start; the mouth is read from `clock()` every frame (30 ms ahead, so lips anticipate), so audio and avatar stay together however frames pace. If `clock()` stalls or goes backwards the current shape is held. `setSpeed` does not affect speech.
- Phonemes: IPA or ARPAbet symbols, case and stress digits ignored, unknown symbols get a neutral half-open mouth. Groups: open (aa ae ah), mid (eh ey), spread (iy ih), round (ao ow), pucker (uw w), bilabial (p b m: lips close, jaw shuts), labiodental (f v), postalveolar (sh zh ch jh), sibilant (s z), tongue (t d n l th), velar (k g ng h), r. Non-bilabial jaw never drops below about 0.06. Short gaps inside speech hold the neighbouring shape.
- Words only (no phonemes covering the moment): one open/close per estimated syllable across each word, closed between words.
- Motion is a critically damped spring (about 60 ms) per blend shape, so shapes blend into each other.
- Priority: a cue owns the mouth. While a cue is chosen (`cueId` set) or its shapes are still easing out after `stop()`, speech runs its clock and events but writes no shapes; it eases in from rest afterwards. Calling `speak()` again stops the previous handle.
- Dev only: press `L` on the harness page to play a canned timeline against a `performance.now()` clock (it calls `stop()` first so no cue is active).

## Drivers and fallback

Both drivers use the same avatar and the same cue data.

- `talkinghead`: TalkingHead in avatar-only mode, with natural blinking, breathing and head motion.
- `three`: plain `GLTFLoader` with scripted blinking.
- `auto` (default): tries TalkingHead; if it throws or has not loaded within 10 s, logs a warning, aborts the attempt (a late result is disposed) and starts the three.js driver. Forcing `driver: "talkinghead"` does not fall back; the panel shows an error message and the promise rejects.

URL parameters override options:

| Parameter | Effect |
|---|---|
| `?driver=three\|talkinghead\|auto` | Choose the driver. |
| `?style=solid\|hologram` | Choose the look. |
| `?debug` | Show an overlay with the driver name and style. |
| `?thfail` | Force the TalkingHead attempt to fail, to test the fallback. |

## Keyboard shortcuts (harness page)

| Key | Action |
|---|---|
| 1 / 2 / 3 | Show cue round-lips / spread-lips / open-jaw |
| R | Replay |
| S | Toggle slow-mo |
| V | Toggle side view |
| G | Highlight calibration mode |
| H | Toggle hologram / solid style |
| L | Dev only: canned lip sync timeline, no audio |
| 0 | Stop and reset to neutral |

## Highlight calibration

Press `G` to toggle calibration. Arrow keys nudge the ring up/down/left/right, `[` and `]` resize it, and the current values are logged to the console. Paste them into the highlight tuning config in `src/highlight.js`. Check the result in both drivers (`?driver=three` and `?driver=talkinghead`) and in front and side views.

## Style option

`hologram` renders the avatar as navy sphere dots with bloom and background particles. `solid` restores the original materials with studio lighting, no bloom, and the same light panel. Use `?style=solid` if the hologram does not read well on a projector.

## File map

| File | Purpose |
|---|---|
| `index.html`, `src/harness.js` | Full-screen harness page and keyboard shortcuts |
| `src/mouth-demo.js` | Public entry `createMouthDemo`, driver selection, choreography |
| `src/scene.js` | Renderer, camera, lights, controls, render loop |
| `src/drivers/talkinghead.js`, `src/drivers/three.js` | The two avatar drivers |
| `src/mouth-anchor.js` | Locates the mouth on the avatar |
| `src/views.js` | Front/side camera orbit, head-following pivot |
| `src/highlight.js` | Lip highlight ring and calibration |
| `src/hologram.js` | Hologram materials, depth prepass, bloom |
| `src/particles.js` | Background drifting particles |
| `src/cutaway.js` | SVG cutaway and pose morphing |
| `src/timeline.js` | Tween engine with a speed multiplier |
| `src/lipsync.js` | Timed lip sync: phoneme to viseme table, smoothing, session handling |
| `src/cues.js` | Cue definitions (data only) |
| `src/styles.css` | Panel styles |
| `public/avatars/brunette.glb` | Avatar |

## Attributions

- `brunette.glb`: CC BY-NC 4.0, created with Ready Player Me, from the TalkingHead repository (github.com/met4citizen/TalkingHead). Non-commercial use only.
- TalkingHead (`@met4citizen/talkinghead`): MIT license.
- three.js: MIT license.
- Atkinson Hyperlegible (`@fontsource/atkinson-hyperlegible`): SIL Open Font License.
