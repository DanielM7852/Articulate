# CV collector: integration handoff

This work lives on `cv` in `Articulate-cv`. Import `apps/web/src/cv/index.ts` for
the reusable collector; `cv/types.ts` defines its public contract. It has no dependency
on the session API, reasoning agent, audio pipeline, target vowels, or React.
`apps/web/src/cv-lab/` provides a standalone local inspector/export UI.

## Run

```powershell
npm ci
npm run dev --workspace apps/web
# Open http://127.0.0.1:5173/vision.html
```

Start camera, Begin attempt, Finish attempt, Export attempt JSON. Images are off
by default and can be enabled before an attempt. This page does not open a microphone,
contact an API, persist observations, or upload images. The preview alone is mirrored.
Coordinates and JPEGs are not mirrored. The model is local; predev/prebuild copies
the wasm runtime from pinned MediaPipe 0.10.17.

If the Windows sandbox blocks esbuild while traversing parent directories, use
`npm run build --workspace apps/web -- --configLoader runner`, then
`npm run preview --workspace apps/web -- --configLoader runner`.

## Consume observations

```ts
import { VisionCapture, VisionRecorder } from "./cv";

const recorder = new VisionRecorder({ maxFrames: 1800, maxImages: 48 });
let imagesEnabled = false; // Set from the caller's explicit image preference.
const capture = new VisionCapture({
  maxFps: 20,
  includeImages: () => imagesEnabled && recorder.recording,
  onObservation: (observation) => {
    recorder.push(observation);
    // Or stream observation.frame to your own consumer here.
    // Optional imageSample contains pixels from this exact inferred frame.
  },
  onStatus: (status, detail) => {
    /* Display capture state and repair errors. */
  },
});

// Caller owns the camera stream: attach it to video and await video.play().
await capture.start(video);
recorder.begin(
  crypto.randomUUID(),
  performance.now(),
  performance.timeOrigin,
  "attempt label",
);

// Optional measured markers from your audio/controller layer, on the same clock:
recorder.mark("speech.start", performance.now(), { source: "audio-vad" });

// When the controller ends the attempt:
recorder.closeWindow(performance.now());
await capture.drain(); // Includes the last in-flight result captured before cutoff.
const attempt = recorder.finish(undefined, capture.stats);

capture.stop(); // Worker only; stop the caller-owned camera tracks separately.
```

`subscribe(callback)` supports additional consumers. New attempts do not restart the
camera/model. Starting a collector creates a new `streamId`, with increasing sequence
numbers. Start a new collector stream if the camera changes. Stopped-worker results
are ignored. Capture failure stops inference and is reported through `onStatus`;
no generated observation replaces missing data.

## Frame contract: articulate.cv/1

Each `VisionObservation` has `frame` and optionally `imageSample`:

| Field                      | Contents                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                    | Model/runtime revision, GPU/CPU delegate, VIDEO mode.                                                                                                                    |
| `timing`                   | Original capture time, approximate Unix time, video media time, inference start/end and receipt time.                                                                    |
| `image`                    | Source dimensions, `mirrored: false`.                                                                                                                                    |
| `raw.landmarks`            | Every primary-face landmark, normally 478, unrounded x/y/z in original model order.                                                                                      |
| `raw.blendshapes`          | Every emitted category, normally 52. No geometric substitutes for missing coefficients.                                                                                  |
| `raw.transformationMatrix` | Original 4x4 column-major matrix, or null. Translation is not calibrated physical position.                                                                              |
| `raw.faceCount`            | Detected faces, up to the configured limit of 2. Multiple faces reject the frame for learner analysis.                                                                   |
| `geometry`                 | Normalized lip opening/outer height/width/aspect ratio, relative-depth proxy, nose-to-chin distance, inner-mouth area, roll-corrected corner asymmetry and mouth center. |
| `pose`                     | Euler pitch/yaw/roll after removing matrix scale, or null.                                                                                                               |
| `mouthBox`                 | Normalized lower-face bounds, independent of preview mirroring.                                                                                                          |
| `quality`                  | Usability, rejection reasons, warnings and image-quality heuristics.                                                                                                     |

All monotonic times share the page's performance clock. Worker timestamps are converted
to that clock before emission. `captureUnixMs = performance.timeOrigin + captureMonotonicMs`.
For audio alignment use capture time, not inference completion or receipt time.
The recorder preserves those timestamps and rejects pre-attempt/out-of-order frames.

Coordinates: x points right in the source image, y down. Model z is relative, uses the
image-width scale, and smaller values are nearer the camera. Geometry converts x/z to
image-height units before normalization. Eye-center distance uses 33/133 and 263/362.
Distances are dimensionless; areas use squared interocular units. There is no silent
cosine correction. Mouth center uses eye midpoint as origin and a roll-corrected axis.
Pose convention: `R = Ry(yaw) Rx(pitch) Rz(roll)`; verify signs against your camera
convention before interpreting them. Blendshapes are model coefficients, not
probabilities of correct articulation or evidence of emotions.

Raw points remain available on poor-angle, clipped, distant and multiple-face frames.
Malformed/nonfinite landmark arrays are omitted and flagged so export stays finite JSON.
Derived geometry can still be present on rejected frames: honor `quality.usable`.
Missing measurements are null, never invented zeros.

Rejections: missing/invalid landmarks, invalid dimensions, multiple faces, mouth/chin
clipping, too-small eye distance, yaw beyond 25 degrees or pitch beyond 20 degrees.
Missing pose/blendshapes, low light, low contrast and overexposure are warnings.
These are engineering heuristics, not validated clinical thresholds. Image quality
is computed on a 96x96 face crop (whole image if no face). Laplacian variance measures
sharpness at that resolution, not model confidence.

## Attempt contract

`VisionAttempt` includes original frames, start/end times, stream/model provenance,
optional label/annotations, image samples, keyframe references, statistics and caps.
`captureStatsAtEnd` contains counters since the camera stream started, not just the attempt.

- Scalar geometry, blendshapes and pose get count, mean, min/max, median, p10/p90 and
  standard deviation on retained usable frames only.
- Quality fractions/counts and temporal coverage cover all accepted observations,
  including those omitted by the cap. `droppedFrames` makes truncation explicit.
- Motion summaries are maximum absolute changes per second between adjacent usable
  frames in the same stream. They never bridge rejected frames or gaps over 250 ms.
  Raw data lets your agent compute additional features later.
- Timing summaries include inference duration, receipt latency and capture intervals.
  Frame counts are not voiced duration; these timings are not acoustic latency.
- Defaults retain the first 1800 frames (about 90 seconds at 20 Hz), count omitted
  frames and keep up to 48 images with replacement. Limits are configurable. Stream
  to your consumer for long sessions rather than using unbounded memory.
- Optional 256x256 JPEGs are requested at most every 250 ms and use the exact frozen
  inference bitmap. Square source crops preserve aspect ratio. No overlays/HUD or
  mirroring are applied. Samples reference stream, sequence, timestamp and source crop.
  Replacement/omission is counted.
- Keyframes reference retained samples: first usable, largest visible excursion,
  late usable. Excursion = jawOpen + mouthPucker + lipOpening. They are visual samples,
  not claims about voiced onset/nucleus/hold. Use external audio timing to select
  speech-specific frames later. Annotation count is bounded at 128 per attempt.

There are no pronunciation verdicts, inferred tongue/throat coordinates, emotion
labels, target-dependent measurements or coaching text. SPARC/ARTI-6 are not part
of this camera collector. The separate [audio model collector](../services/articulation/README.md)
now supplies their estimates and Silero speech activity. Your agent can consume the
two versioned datasets independently and align their original capture clocks.

## Existing backbone camera

The older `CameraTile` keeps its compact API. Live-mode synthetic fallback is removed:
busy workers skip frames, and unavailable tracking yields invalid measurements.
Its keyframes now crop real unannotated video. That compact API is not the rich
contract above: integrate from `cv/index.ts` for the full dataset.

## Verify

```powershell
npm run test:vision
npm run build --workspace apps/web -- --configLoader runner
npm run test:vision:e2e
```

E2E uses installed Chrome and the built app. It checks permission denial, actual
MediaPipe inference on Chrome's fake-camera feed, honest missing-face exports and
repeated attempts on one stream. The optional real-face test runs when
`CV_TEST_PORTRAIT` points to a local JPEG. A public Google fixture is available at
https://storage.googleapis.com/mediapipe-assets/portrait.jpg; download separately,
set the environment variable and rerun. Only the test browser injects fixture pixels.

Unit tests cover aspect/scale/roll behavior, relative-depth scaling, matrix scale,
missing outputs, quality gating, caps, stale frames, attempt boundaries, worker errors,
timeouts, disabled image sampling and draining in-flight inference. Physical-device
accuracy and usefulness to speech therapy still require evaluation.
