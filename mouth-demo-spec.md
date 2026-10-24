# Implementation brief: 3D mouth demonstration for cue practice

You are implementing one component of a hackathon demo for a visual speech coach aimed at deaf and hard-of-hearing learners. When the learner is practicing a cue (for example "Round your lips"), this component shows a 3D face that **demonstrates the mouth movement**, plus an optional side-view cutaway of the tongue.

The face is a **silent demonstration model**, not a conversational character. It does not speak or lip-sync. It should still look alive (blinking, breathing, small natural head and eye movement), which is why the primary approach uses the TalkingHead library to animate it. Visually, the face is rendered as a **glowing pink holographic point cloud** made of broken horizontal scanlines, inspired by a neon jellyfish reference (§13).

**The goal is a demonstration that looks great and never breaks on stage, not clinical accuracy.** Prefer hardcoded and scripted solutions over general ones.

## 1. What it does

The practice screen (built by another component) mounts this model in a panel and asks it to demonstrate a cue. The face moves from relaxed into the target mouth shape, holds it while a highlight ring pulses around the lips, then relaxes. It loops calmly while the learner practices. The learner can:

- replay the movement,
- watch it at half speed,
- switch to a side view, where the camera orbits to a profile and a stylized cutaway of the mouth and tongue fades in and morphs into the same position,
- drag to rotate the head a little to see the lips from other angles.

## 2. Approach: TalkingHead first, plain three.js as fallback

Build the component on a **shared three.js scene** (renderer, camera, lights, orbit controls, highlight ring, timeline) and put everything avatar-specific behind a small **driver** interface with two implementations:

- **`TalkingHeadDriver` (primary):** TalkingHead animates the avatar in its *avatar-only mode*, inside our scene. It provides natural idle life: blinking, breathing, eye movement, subtle head motion and smooth body posture. We override only the mouth shapes.
- **`ThreeDriver` (fallback):** loads the same GLB with `GLTFLoader` and sets mouth shapes directly on the morph targets, with simple scripted blinking. Less lifelike, but has almost nothing that can go wrong.

Both drivers use **the same avatar file and the same cue data**, so switching between them changes nothing else.

### 2.1 Decision gate

1. Build the shared scene and the `TalkingHeadDriver` first. **Timebox this spike to 3 hours.**
2. Switch the default to `ThreeDriver` if, at the end of the timebox, any of these is still true:
   - avatar-only mode does not render or animate correctly inside our scene;
   - mouth overrides jitter, get pulled back by TalkingHead's own animation, or can't hold a pose steadily;
   - the head turns back toward the camera (or drifts out of frame) during the side view, and settings can't stop it;
   - loading or bundling errors you can't fix.
3. Either way, keep both drivers working. The fallback also protects the live demo (§11.5).

## 3. Scope

### Must have (in priority order)
1. Shared scene + `TalkingHeadDriver` spike, then the decision gate (§2.1).
2. `ThreeDriver` fallback with the same interface.
3. Cue player that animates the mouth from authored keyframes, for the cue `round-lips` ("oo").
4. Calm loop of the cue while practicing, with a pause between repetitions.
5. Lip highlight ring anchored to the head bone, so it stays on the lips in every view.
6. Replay and slow-mo (0.5x).
7. Side view: camera orbits to a profile, and the 2D SVG cutaway fades in and morphs neutral → "oo", in sync.
8. A clean JavaScript API and events the practice screen can use (§11.4).
9. Hologram look (§13): point-cloud shader, bloom, background particles, materialize-in and cue ripple effects, plus a `style: "solid"` option.

### Nice to have (only after everything above works)
- Cues `spread-lips` ("ee") and `open-jaw` ("ah"), each with a cutaway pose.

### Out of scope — do not build
- Speech, audio, text-to-speech, lip-sync, Cartesia.
- Conversation, coach personality, moods beyond the demo mood, hand gestures, celebrations.
- The practice screen, the acoustic feedback cursor, microphone input.
- Throat, larynx, voicing or airflow animation.
- Any claim of anatomical or clinical accuracy in UI copy.

## 4. Tech stack

- **Vite + vanilla JavaScript (ES modules).**
- **three.js `0.180.0`** with `GLTFLoader`, `OrbitControls` and `RoomEnvironment` from `three/addons`.
- **TalkingHead `1.7.x`** (`@met4citizen/talkinghead` on npm; docs at github.com/met4citizen/TalkingHead). Read its README before starting, especially the class options, Appendix D (moods), Appendix F (controlling blend shapes) and Appendix H (avatar-only mode).
- Install everything locally with npm. **Nothing at runtime may depend on a CDN or network.**
- Font: self-host **Atkinson Hyperlegible** (designed for legibility; fits the audience), e.g. via `@fontsource/atkinson-hyperlegible`.

## 5. Assets

- **Avatar:** `brunette.glb` from the `avatars/` folder of the TalkingHead repository. It has the Mixamo-compatible rig plus the ARKit and Oculus blend shapes TalkingHead requires, so it works with both drivers. Place it at `public/avatars/brunette.glb`. It is licensed CC BY-NC 4.0 (non-commercial; created with Ready Player Me), which is fine for a hackathon demo. Put the attribution in the README. Note that the TalkingHead library itself ships no avatars; this file is a separate asset.
- **Cutaway SVG:** hand-authored, stylized. See §9.

## 6. File structure

```
/index.html                     standalone harness page for developing and demoing this component
/src/mouth-demo.js              public entry: createMouthDemo(container, options)
/src/scene.js                   renderer, camera, lights, controls, render loop
/src/drivers/talkinghead.js     TalkingHeadDriver (primary)
/src/drivers/three.js           ThreeDriver (fallback)
/src/views.js                   front/side camera orbit, head-following pivot
/src/highlight.js               3D lip highlight ring + calibration
/src/hologram.js                point-cloud hologram materials, depth prepass, bloom
/src/particles.js               background drifting pixel particles
/src/cutaway.js                 SVG cutaway: show/hide and morphing
/src/timeline.js                tween engine with a speed multiplier
/src/cues.js                    cue definitions (data only)
/src/harness.js                 keyboard shortcuts and buttons for the harness page
/src/styles.css
/public/avatars/brunette.glb
/README.md                      how to run, API, drivers, shortcuts, attributions
```

## 7. Drivers

### 7.1 Interface (both drivers implement this)

```js
{
  name,                 // "talkinghead" | "three"
  root,                 // THREE.Object3D containing the avatar (already added to the scene)
  headBone,             // THREE.Object3D for the head
  setShape(name, v),    // set an ARKit blend shape, v in [0, 1]
  releaseShapes(names), // hand these shapes back to normal (0 or idle animation)
  update(dtMs),         // called every frame by the shared render loop
  dispose(),
}
```

Find the head bone with `getObjectByName("Head")`, falling back to `"mixamorigHead"`.

The cues only use these ARKit names: `jawOpen`, `mouthPucker`, `mouthFunnel`, `mouthSmileLeft`, `mouthSmileRight`, `mouthStretchLeft`, `mouthStretchRight`, `mouthLowerDownLeft`, `mouthLowerDownRight`, `mouthUpperUpLeft`, `mouthUpperUpRight`. If any is missing from the model, log a warning naming it rather than crashing.

### 7.2 `TalkingHeadDriver` (primary)

Use TalkingHead's **avatar-only mode**, which is marked experimental in its README. In this mode TalkingHead does not create its own scene, camera or renderer; it builds the avatar and we call its update function from our render loop.

```js
const head = new TalkingHead(container, {
  avatarOnly: true, avatarOnlyCamera: camera, avatarOnlyScene: scene,
  lipsyncModules: [],                       // no speech, so load no lip-sync modules
  modelMovementFactor: 0.2,                 // keep the upper body calm
  avatarIdleHeadMove: 0.15, avatarIdleEyeContact: 0.3, avatarIgnoreCamera: true,
});
await head.showAvatar({ url: "/avatars/brunette.glb", body: "F", avatarMood: "neutral" });
// root = head.armature; update(dt) => head.animate(dt); dispose() => head.dispose()
```

**Demo mood without random mouth movement.** TalkingHead's mood templates can include a `mouth` animation that randomly moves shapes like `mouthPucker` and `mouthStretchLeft`, which would interfere with the demonstrations. Make a copy of the neutral mood with that entry removed and use it:

```js
const neutral = head.animMoods["neutral"];
head.animMoods["demo"] = { ...neutral, anims: neutral.anims.filter(a => a.name !== "mouth") };
head.setMood("demo");
```

Inspect `head.animMoods["neutral"]` in the console first to confirm its structure.

**Setting mouth shapes.** Use the real-time override on `head.mtAvatar`, which applies values without TalkingHead's smoothing so our timeline controls the timing exactly:

```js
setShape(name, v)   { const mt = head.mtAvatar[name]; if (mt) Object.assign(mt, { realtime: v, needsUpdate: true }); }
releaseShapes(names){ for (const n of names) { const mt = head.mtAvatar[n]; if (mt) Object.assign(mt, { realtime: null, needsUpdate: true }); } }
```

If this jitters or fights the idle animation, try `head.setFixedValue(name, v)` / `head.setFixedValue(name, null)` instead (smoother, with less timing control), before declaring the gate failed.

**Side view.** During the side view the head must stay in profile rather than turning toward the camera. Start with `avatarIgnoreCamera: true` and low eye contact (above). If the head still turns, call `head.lookAhead(ms)` at the start of each side-view phase.

### 7.3 `ThreeDriver` (fallback)

- Load the GLB with `GLTFLoader`, add it to the scene, and use the scene root as `root`.
- The face is split across several meshes (head, teeth, and others), each with its own morph targets. Apply every shape to **every** mesh that has it, or the teeth and face will disagree:

```js
const morphMeshes = [];
model.traverse(o => { if (o.isMesh && o.morphTargetDictionary) morphMeshes.push(o); });
function setShape(name, v) {
  for (const m of morphMeshes) { const i = m.morphTargetDictionary[name]; if (i !== undefined) m.morphTargetInfluences[i] = v; }
}
```

- `releaseShapes` sets the given shapes to 0.
- Add simple life in `update`: a blink (`eyeBlinkLeft`/`eyeBlinkRight` to 1 and back over ~150 ms) at random intervals of 3–6 s.
- The model loads in its rest pose (arms out). The camera only frames the head, so this doesn't matter.
- On load, log every mesh with morph targets and its morph target names, for tuning.

## 8. Scene, framing and views (`src/scene.js`, `src/views.js`)

- One `WebGLRenderer`, one perspective camera (~30° vertical FOV), one shared `requestAnimationFrame` loop. Each frame: advance the timeline, call `driver.update(dt)`, update the pivot and highlight, render.
- **Lighting:** only matters for `style: "solid"` (§13.6): `RoomEnvironment` through a PMREM generator plus one key directional light from front and slightly above, so the inside of the mouth is not black. The hologram materials are unlit.
- **Pivot:** the head bone's world position plus a small offset down and forward, toward the mouth. With TalkingHead the head moves gently, so **follow it smoothly**: each frame, move the pivot 10% of the way toward the head's current position. The camera looks at and orbits around the pivot, about 0.55 m away, so the face fills most of the panel and the mouth sits slightly below center.
- Check which direction the model faces (Ready Player Me models usually face +Z) and set the front view accordingly.
- **Orbit controls:** `OrbitControls` targeted at the pivot. Let the learner drag to rotate, limited to about ±60° horizontally and ±20° vertically. Disable pan and zoom. Disable dragging while a view change is animating.
- `setView("front" | "side", { animate })` orbits the camera to azimuth 0° or 90° over ~1.2 s with ease-in-out, keeping the same distance. Pick the profile (left or right) that looks best; the cutaway is mirrored to match.
- Under `prefers-reduced-motion`, change views with a quick crossfade instead of an orbit.

## 9. Cutaway (2D SVG, `src/cutaway.js`)

A clean, stylized side view of the mouth reads better on a projector than a realistic one. **Draw your own simple version** (do not trace or copy a published diagram).

- `viewBox="0 0 400 400"`, rendered in an HTML panel beside the 3D canvas (not in the 3D scene). Mirror it with `transform: scaleX(-1)` so it faces the same way as the avatar's profile.
- **Static layer** (never moves): outline of the nose and nasal cavity, hard palate, upper teeth, back of the throat. Thin neon-pink stroke with an SVG glow filter (`feGaussianBlur` merged under the stroke), no fill.
- **Animated layer** (morphs between poses): `tongue` (filled with an SVG `<pattern>` of broken horizontal pink dashes, matching the face's scanlines), `upperLip`, `lowerLipJaw` (lower lip, lower teeth and jaw line as one path).
- **Poses** (one `d` string per animated element per pose):
  - `neutral`: relaxed, mouth slightly closed, tongue resting low and flat.
  - `oo`: back of tongue raised high toward the soft palate, lips pushed forward and rounded into a small opening, jaw nearly closed.
  - `ee` (nice to have): front of tongue raised high toward the hard palate, lips spread, jaw nearly closed.
  - `ah` (nice to have): tongue low and flat, jaw open wide.
- **Morphing:** every pose of a given element must use the *same sequence of path commands with the same number of points*, so morphing is a plain number-by-number interpolation. Write a ~20-line helper: extract the numbers from both `d` strings, lerp them, rebuild the string using the first one as a template. No morphing library needed.
- While a pose is held, give the moving part (the tongue for `oo`) a soft highlight in the highlight color.
- A small, quiet label in the panel corner: "Illustrative view".
- API: `cutaway.show(t)` (opacity 0–1), `cutaway.setPose(from, to, t)`.

## 10. Lip highlight ring (`src/highlight.js`)

- A thin ring mesh (`RingGeometry`, `MeshBasicMaterial`, transparent, `depthTest: false`, high `renderOrder`) added as a **child of `driver.headBone`**, at an offset that places it around the lips. It follows the head automatically, including TalkingHead's idle movement and every camera angle.
- Each frame, make it face the camera.
- It pulses in **cyan** (scale 1 → 1.08, opacity 0.5 → 1, ~900 ms loop) only while a pose is held. Cyan contrasts with the pink face, so the cue highlight never blends in, and fades out otherwise.
- **Calibration mode:** press `G` to toggle. Arrow keys nudge the offset up/down/left/right, `[` and `]` resize, and the current values are logged to the console for pasting into config. The offset should be the same for both drivers, since they use the same model; check it in both.

## 11. Cues, choreography and API

### 11.1 Cue data (`src/cues.js`)

```js
export const CUES = {
  "round-lips": {
    sound: "oo", caption: "Round your lips, like saying \u201coo\u201d.",
    shapes: { mouthPucker: 0.85, mouthFunnel: 0.5, jawOpen: 0.15 },
    cutawayPose: "oo",
  },
  "spread-lips": {   // nice to have
    sound: "ee", caption: "Spread your lips, like a small smile.",
    shapes: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, jawOpen: 0.1 },
    cutawayPose: "ee",
  },
  "open-jaw": {      // nice to have
    sound: "ah", caption: "Drop your jaw and open wide.",
    shapes: { jawOpen: 0.65, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
    cutawayPose: "ah",
  },
};
```

These values are starting points. **Tune them by eye until the shape is unmistakable on a projector — exaggerate.** Check the tuned values in both drivers; they should look nearly the same.

### 11.2 Choreography (at speed 1.0)

**Front loop** (plays when a cue is demonstrated, and repeats while practicing):

| Phase | Duration | Face | Highlight |
|---|---|---|---|
| in | 0.6 s | neutral → target shapes | fade in |
| hold | 2.0 s | hold | pulse |
| out | 0.6 s | target → neutral, then release shapes | fade out |
| rest | 1.5 s | idle (TalkingHead's natural movement shows here) | hidden |

**Side view** (when the learner taps Side view while a cue is active):

| Phase | Duration | Camera | Face | Cutaway |
|---|---|---|---|---|
| swing | 1.2 s | front → side | neutral → target | fade in, morph neutral → pose |
| hold | 2.5 s | side | hold | hold, tongue highlighted |
| relax | 0.6 s | side | target → neutral | morph back to neutral |
| rest | 1.5 s | side | idle | neutral |

While in side view, repeat **(neutral → target, 0.6 s) → hold → relax → rest** so face and cutaway loop together. Tapping Front view orbits back and fades the cutaway out.

Use ease-in-out (cubic) for every transition. Slow-mo multiplies all durations by 2.

### 11.3 Timeline engine (`src/timeline.js`)

A tiny engine driven by the shared render loop: a global `speed` multiplier and phases made of tweens `{ duration, onUpdate(t) }` that run in sequence and can loop. Provide `play(phases, { speed, loop })`, `stop()`, and a promise that resolves when a non-looping sequence ends. Starting a new cue cancels the current one cleanly and releases every shape the previous cue used.

### 11.4 Public API (`src/mouth-demo.js`)

```js
const demo = await createMouthDemo(containerElement, {
  avatarUrl: "/avatars/brunette.glb",
  driver: "auto",              // "auto" (TalkingHead, falling back to three) | "talkinghead" | "three"
  style: "hologram",           // "hologram" | "solid"
});

demo.showCue(cueId)            // play the cue once from the front, then keep looping it
demo.replay()                  // restart the current cue from the beginning
demo.setSpeed(0.5 | 1)         // slow-mo on or off; applies immediately
demo.setView("front" | "side") // animated; side view shows the cutaway
demo.stop()                    // return to neutral and stop looping
demo.dispose()                 // free GPU resources and remove the canvas
demo.driverName                // "talkinghead" or "three"
```

- `createMouthDemo` builds its own layout inside the container: the 3D canvas, the cutaway panel (hidden until side view), and a caption line showing the cue's text.
- Dispatch `CustomEvent`s on the container: `demo:ready` with `{ driver }` after loading, and `cue:phase` with `{ cueId, phase }`. The practice screen can use these, for example to prompt "Your turn" after the first demonstration.
- Built-in controls under the model: **Replay**, **Slow-mo** (toggle), **Side view** (toggle). Add an option `controls: false` so the host screen can provide its own buttons instead.

### 11.5 Driver selection and automatic fallback

- `driver: "auto"` (the default) tries `TalkingHeadDriver`. If creating it or loading the avatar throws, or the avatar hasn't loaded within 10 s, log the reason, dispose what was created, and start `ThreeDriver` instead. The learner should never see a broken panel.
- The URL parameter `?driver=three` or `?driver=talkinghead` overrides the option, so the presenter can switch without code changes.
- After the decision gate (§2.1), set the `"auto"` behavior to whichever driver won.

## 12. Harness page and shortcuts

`index.html` is a simple page that mounts the component full-screen for development and as a fallback demo. Keyboard shortcuts (list them in the README; show an overlay with the current driver name only with `?debug` in the URL):

| Key | Action |
|---|---|
| 1 / 2 / 3 | Show cue round-lips / spread-lips / open-jaw |
| R | Replay |
| S | Toggle slow-mo |
| V | Toggle side view |
| G | Highlight calibration mode |
| H | Toggle hologram / solid style |
| 0 | Stop and reset to neutral |

## 13. Look: holographic point-cloud face

The face is rendered as a glowing hologram made of **broken horizontal scanlines and dots**, like a neon pink jellyfish: dark background, hot-pink light, streaky bands that wrap the surface, floating pixel particles behind. The look is the memorable part of the demo; the motion should feel fluid and calm, never glitchy enough to hide the mouth.

### 13.1 Technique: shader on the real meshes, not a separate point cloud

Keep the avatar's own meshes and replace their materials with a custom hologram material. Skinning and morph targets keep working in both drivers, so the mouth shapes, TalkingHead's idle motion and the highlight ring all still work unchanged. The "points" are produced in the fragment shader by discarding everything except dashes and dots on the surface.

Do **not** build a literal `THREE.Points` copy of the mesh: points don't follow skinning, so they would drift off the face whenever the head moves.

Build the material by extending `MeshBasicMaterial` with `onBeforeCompile`, so three.js's skinning and morph-target shader chunks stay included:

- **Stable pattern coordinates.** In the vertex shader, capture the position *after morph targets and before skinning* (insert right after `#include <morphtarget_vertex>`) into a varying `vRestPos`. The pattern then sticks to the skin: the dashes on the lips move with the lips, and the bands don't swim across the face when the head turns. Also pass a view-space normal for the rim effect.
- **Bands:** `band = fract(vRestPos.y * uBandFreq + uTime * uScroll)`; keep fragments where `band < uDuty`. Start around 180 bands per metre with a duty of 0.35 and a slow upward scroll.
- **Dashes:** break each band into segments with a hash of `(floor(vRestPos.x * uDashFreq), bandIndex)`; discard segments whose hash is below a threshold (~0.3). Let the threshold drift slowly per band over time so the dashes shimmer softly.
- **Dots:** inside kept segments, optionally round the ends to dots for a finer point-cloud texture.
- **Rim:** add brightness with a fresnel term `pow(1.0 - abs(dot(normal, viewDir)), 2.0)`. This outlines the silhouette, which makes the lip profile readable in the side view.
- **Color:** pink base `#FF2BA6`, brightening toward a hot core `#FFD1EC` with the rim and with emphasis (below). Output with additive blending, `transparent: true`, `depthWrite: false`.
- **Mouth emphasis (important for readability):** uniforms `uMouthCenter` (rest-space position of the mouth, calibrated like the highlight ring) and `uMouthRadius` (~4 cm). Inside that radius, double the band frequency, raise the duty and brightness, and lower the dash discard threshold, so the lips are the densest, clearest part of the face.
- **Depth prepass:** add a second copy of each visible mesh (sharing geometry and skeleton) with a plain material that has `colorWrite: false` and writes depth, rendered first (`renderOrder` lower). This hides the back of the head and the inside of the mouth behind the visible surface, so the face reads as a solid hologram instead of a tangle of overlapping lines. Teeth seen through open lips still render.
- **Which meshes:** head, teeth and eyes get the hologram material (eyes brighter and denser). Hair gets a sparser, dimmer version. **Hide clothing and body meshes**; the floating head is part of the look.

Apply the materials after the avatar has loaded, by traversing `driver.root`. With TalkingHead, check that it doesn't reset materials later.

### 13.2 Post-processing and background

- `EffectComposer` with `RenderPass` and `UnrealBloomPass` (start at strength 0.9, radius 0.4, threshold 0.1), then `OutputPass`. Tune bloom down if the lips start to smear together.
- Background: a dark plum gradient behind the head.
- `src/particles.js`: a few hundred small square points far behind the head, drifting slowly up with slight sideways sway and twinkling, low opacity, mostly in the upper corners like the reference. Keep them out of the area behind the mouth.

### 13.3 Fluid animations

All effect timing uses the timeline's speed, so slow-mo slows the effects too.

- **Materialize on load:** a reveal height sweeps from chin to crown over 1.2 s; bands appear as it passes, with a bright leading edge.
- **Idle:** bands scroll slowly upward; dashes shimmer; every ~6–8 s one brighter band glides up the face. Never during a hold.
- **Cue "in" phase:** a soft ring of brightness ripples outward from the mouth across the face (uniform `uRippleTime`, brightness peaking where distance from `uMouthCenter` matches the ripple radius).
- **Cue hold:** the mouth region gently pulses brighter in sync with the cyan highlight ring.
- **View swing:** band scroll speeds up briefly during the orbit and settles when the camera stops; particles drift past for a sense of motion.
- **Reduced motion:** no shimmer, glide or ripple; static bands and an instant view change.

### 13.4 Panel design

The audience is deaf and hard-of-hearing learners, and text must stay perfectly legible even though the scene is dark and glowing. **Never apply glow or bloom to text.**

- **Type:** Atkinson Hyperlegible throughout. The cue caption is 28–34 px, weight 700, one line where possible, in near-white `#F6EFF4` on a solid dark caption strip.
- **Palette:**
  - Stage background "Deep plum" `#140A16` fading to `#25102A`
  - Hologram "Neon pink" `#FF2BA6`, hot core `#FFD1EC`
  - Cue highlight "Cyan" `#3CF2FF`
  - Text `#F6EFF4`
  - Buttons: outlined in neon pink with text in `#F6EFF4`; filled pink with dark text when active (e.g. Slow-mo on)
- **Cutaway panel:** same deep plum background, neon line art, dashed-pattern tongue (§9).
- **Layout:**

```
Front view                          Side view
┌───────────────────────────┐       ┌──────────────┬────────────┐
│ ·  ·      ·   ·  ·        │       │              │            │
│     hologram face         │       │ hologram     │  neon      │
│      (front)              │       │ (profile)    │  cutaway   │
├───────────────────────────┤       ├──────────────┴────────────┤
│ Round your lips, like     │       │ Round your lips, like ... │
│ saying "oo".              │       ├───────────────────────────┤
├───────────────────────────┤       │ Replay  Slow-mo  Front    │
│ Replay  Slow-mo  Side view│       └───────────────────────────┘
└───────────────────────────┘
```

- The cutaway panel slides in from the right during the orbit, and the 3D canvas narrows to make room.
- Copy is sentence case with plain verbs. The Side view button changes to "Front view" while the side view is showing.
- Quality floor: visible keyboard focus, `prefers-reduced-motion` respected, works in panels from 360 px to 1200 px wide, and resizes correctly when the container resizes.

### 13.5 Readability guardrails

The hologram must not make the mouth movement harder to see. Before tuning anything else, check from the back of a room on the actual projector:

- Lip rounding, spreading and jaw opening are unmistakable at a glance, from the front and in profile.
- The mouth region is visibly denser and brighter than the rest of the face.
- Bloom doesn't merge the upper and lower lips into one blob when the mouth is nearly closed.

Dark scenes with bloom can look muddy on projectors in bright rooms. If the hologram fails these checks, raise mouth density and rim brightness first, then reduce bloom, before giving up on the look.

### 13.6 `style: "solid"` fallback

`style: "solid"` (or `?style=solid`) restores the avatar's original materials with the lighting from §8, no bloom, and the same dark panel design. Use it if the hologram doesn't read well on the venue's projector.

## 14. Verify early (during the TalkingHead spike)

1. TalkingHead imports and runs under Vite from the npm package, with `lipsyncModules: []`.
2. Avatar-only mode renders the avatar in our scene and animates it when we call `head.animate(dt)`.
3. `head.mtAvatar[name].realtime` holds mouth shapes steadily, and the demo mood has no random mouth movement.
4. In the side view, the head stays in profile and the pivot-following keeps it framed.
5. The avatar's teeth and inner mouth look acceptable during rounding and jaw opening under your lighting.
6. The highlight ring offset puts it around the lips in both front and side views.
7. The hologram material keeps skinning and morph targets working (mouth shapes still visible), and TalkingHead doesn't overwrite the materials.
8. The hologram passes the readability checks in §13.5 on a projector.

## 15. Acceptance checklist

- [ ] `npm install && npm run dev` runs with the network disconnected.
- [ ] Both drivers work, selectable with `?driver=`; forcing a TalkingHead failure falls back to `ThreeDriver` automatically.
- [ ] `showCue("round-lips")` makes the lip rounding obvious from the back of a room on a projector, in both drivers.
- [ ] Face, highlight and cutaway stay in sync at 1x and 0.5x, in both views.
- [ ] The hologram face passes the readability checks in §13.5, and `?style=solid` switches to the plain look.
- [ ] Holds 60 fps with bloom on a typical laptop at 1920×1080.
- [ ] Switching cues, views or speed mid-animation never leaves the mouth stuck in a pose.
- [ ] The loop runs for 10 minutes without errors in the console or noticeable slowdown.
- [ ] The component mounts in a host container, emits its events, and cleans up fully with `dispose()`.
- [ ] README documents the API, drivers, shortcuts, and avatar attribution (CC BY-NC 4.0, created with Ready Player Me, from the TalkingHead repo).

## 16. Framing for the pitch

UI copy and the README describe the demonstrations as illustrative. One line is enough: "Mouth demonstrations are illustrative and would be reviewed by speech therapists before real use."
