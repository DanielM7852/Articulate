/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { extractFrame, landmarkBox, measureImageQuality } from "./features";
import type { ModelInfo, VisionImageSample } from "./types";

// MediaPipe 0.10.17's wasm loader calls importScripts, including in Vite module workers.
const nativeImportScripts = self.importScripts.bind(self);
self.importScripts = (...urls: (string | URL)[]) => {
  try {
    return nativeImportScripts(...urls);
  } catch {
    /* Module workers need the classic wasm glue evaluated globally. */
  }
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", String(url), false);
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300)
      throw new Error(`Unable to load MediaPipe wasm glue (${xhr.status})`);
    (0, eval)(xhr.responseText);
  }
};
let landmarker: FaceLandmarker | null = null;
let model: ModelInfo;
let timeOriginUnixMs = 0;
let stopped = false;
const pageNow = () =>
  performance.timeOrigin + performance.now() - timeOriginUnixMs;
self.onmessage = async (event: MessageEvent) => {
  const d = event.data;
  if (d.type === "init") {
    timeOriginUnixMs = d.timeOriginUnixMs;
    try {
      const files = await FilesetResolver.forVisionTasks(d.wasmBaseUrl);
      let delegate: "GPU" | "CPU" = "GPU";
      const create = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: d.modelAssetPath, delegate },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      try {
        landmarker = await create("GPU");
      } catch {
        delegate = "CPU";
        landmarker = await create("CPU");
      }
      model = {
        name: "MediaPipe Face Landmarker",
        runtimeVersion: d.runtimeVersion,
        modelRevision: d.modelRevision,
        delegate,
        runningMode: "VIDEO",
      };
      if (stopped) {
        landmarker.close();
        return;
      }
      postMessage({ type: "ready", model });
    } catch (err) {
      postMessage({
        type: "error",
        fatal: true,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (d.type === "frame") {
    const bitmap: ImageBitmap = d.bitmap;
    try {
      if (!landmarker || stopped) throw new Error("CV model is unavailable");
      const started = pageNow();
      const result = landmarker.detectForVideo(bitmap, d.captureMonotonicMs);
      const ended = pageNow();
      const faces = result.faceLandmarks ?? [];
      const box = landmarkBox(faces[0] ?? [], 0.1);
      const qc = new OffscreenCanvas(96, 96),
        ctx = qc.getContext("2d", { willReadFrequently: true })!;
      const qbox = box ?? { x: 0, y: 0, width: 1, height: 1 };
      ctx.drawImage(
        bitmap,
        qbox.x * bitmap.width,
        qbox.y * bitmap.height,
        qbox.width * bitmap.width,
        qbox.height * bitmap.height,
        0,
        0,
        96,
        96,
      );
      const quality = measureImageQuality(
        ctx.getImageData(0, 0, 96, 96).data,
        96,
        96,
        box ? "face" : "image",
      );
      const frame = extractFrame({
        streamId: d.streamId,
        sequence: d.sequence,
        model,
        captureMonotonicMs: d.captureMonotonicMs,
        timeOriginUnixMs,
        mediaTimeMs: d.mediaTimeMs,
        inferenceStartedMonotonicMs: started,
        inferenceEndedMonotonicMs: ended,
        width: bitmap.width,
        height: bitmap.height,
        faces,
        blendshapes: result.faceBlendshapes?.[0]?.categories,
        matrix: result.facialTransformationMatrixes?.[0]?.data,
        imageQuality: quality,
      });
      let imageSample: VisionImageSample | undefined;
      if (d.includeImage && frame.quality.usable && frame.mouthBox) {
        // Square source crop prevents stretching the lips when resizing to the JPEG dimensions.
        const box = frame.mouthBox,
          side = Math.min(
            bitmap.width,
            bitmap.height,
            Math.max(box.width * bitmap.width, box.height * bitmap.height),
          );
        const x = Math.max(
          0,
          Math.min(
            bitmap.width - side,
            (box.x + box.width / 2) * bitmap.width - side / 2,
          ),
        );
        const y = Math.max(
          0,
          Math.min(
            bitmap.height - side,
            (box.y + box.height / 2) * bitmap.height - side / 2,
          ),
        );
        const crop = {
          x: x / bitmap.width,
          y: y / bitmap.height,
          width: side / bitmap.width,
          height: side / bitmap.height,
        };
        const canvas = new OffscreenCanvas(256, 256),
          context = canvas.getContext("2d")!;
        context.drawImage(
          bitmap,
          crop.x * bitmap.width,
          crop.y * bitmap.height,
          crop.width * bitmap.width,
          crop.height * bitmap.height,
          0,
          0,
          256,
          256,
        );
        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: 0.8,
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        imageSample = {
          streamId: d.streamId,
          sequence: d.sequence,
          captureMonotonicMs: d.captureMonotonicMs,
          source: "webcam",
          mimeType: "image/jpeg",
          width: 256,
          height: 256,
          crop,
          dataBase64: btoa(binary),
        };
      }
      postMessage({ type: "observation", observation: { frame, imageSample } });
    } catch (err) {
      postMessage({
        type: "error",
        fatal: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      bitmap.close();
    }
  } else if (d.type === "close") {
    stopped = true;
    landmarker?.close();
    landmarker = null;
  }
};
