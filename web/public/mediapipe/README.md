# MediaPipe assets (served locally for offline use)

- `face_landmarker.task` - MediaPipe Face Landmarker, float16, v1 (committed).
  Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
  License: Apache License 2.0 (Google MediaPipe model card / repository).
- `wasm/` - not committed (git-ignored). `scripts/copy-mediapipe-wasm.mjs` copies it from
  `node_modules/@mediapipe/tasks-vision/wasm` (0.10.17, Apache-2.0) at `npm run dev` / `npm run build` time
  (predev / prebuild hooks).
