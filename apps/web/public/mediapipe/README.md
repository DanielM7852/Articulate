# Local vision assets

`face_landmarker.task` is the existing project copy of Google's Face Landmarker float16 v1 model.
Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

MediaPipe code/model provenance: Google MediaPipe, Apache-2.0. Preserve source attribution when redistributing.
The model is used for facial landmarks and blendshapes, not clinical assessment.

`wasm/` is generated from the pinned `@mediapipe/tasks-vision@0.10.17` package by
`node scripts/prepare-vision-assets.mjs` (automatically before dev/build). It is not checked in.
Inference and assets are local; the collector does not need a CDN or backend.
