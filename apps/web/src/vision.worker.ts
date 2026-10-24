import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { computeVisionTelemetry } from "./vision";

let landmarker: FaceLandmarker | null = null;
let initFailed = false;

async function ensureLandmarker(wasmBaseUrl?: string, modelAssetPath?: string) {
  if (landmarker || initFailed) return landmarker;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      wasmBaseUrl ||
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm",
    );
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          modelAssetPath ||
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    postMessage({ type: "ready" });
    return landmarker;
  } catch (err) {
    initFailed = true;
    postMessage({
      type: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "init") {
    await ensureLandmarker(data.wasmBaseUrl, data.modelAssetPath);
    return;
  }
  if (data.type === "frame" && data.bitmap) {
    const bitmap: ImageBitmap = data.bitmap;
    const timestampMs: number = data.timestampMs ?? 0;
    const aspect = bitmap.width && bitmap.height ? bitmap.width / bitmap.height : 4 / 3;
    try {
      const lm = await ensureLandmarker();
      if (!lm) {
        postMessage({ type: "fallback_needed", timestampMs });
        return;
      }
      const res = lm.detect(bitmap);
      const faceLandmarks = res.faceLandmarks?.[0];
      const blendshapes = res.faceBlendshapes?.[0]?.categories;
      const matrix = res.facialTransformationMatrixes?.[0]?.data;
      const { metrics, overlay } = computeVisionTelemetry(
        faceLandmarks,
        blendshapes,
        matrix,
        timestampMs,
        aspect,
      );
      postMessage({ type: "result", metrics, overlay });
    } catch (err) {
      postMessage({
        type: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      bitmap.close();
    }
  }
};
