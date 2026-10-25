/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { computeLipFrame, meshPacked, meshPoints } from './lipTelemetry';

// MediaPipe loads its wasm glue with importScripts(), which throws inside a module worker
// (the Vite dev server). Fall back to a synchronous fetch + global eval in that case.
type ImportScripts = (...urls: string[]) => void;
const nativeImportScripts = (self as unknown as { importScripts?: ImportScripts }).importScripts;
(self as unknown as { importScripts: ImportScripts }).importScripts = (...urls: string[]) => {
  try {
    if (nativeImportScripts) return nativeImportScripts.apply(self, urls);
  } catch {
    /* module worker: fall through */
  }
  for (const u of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', u, false);
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300) throw new Error(`Failed to load ${u} (${xhr.status})`);
    (0, eval)(xhr.responseText);
  }
};

let landmarker: FaceLandmarker | null = null;

async function create(wasmBase: string, modelPath: string, delegate: 'GPU' | 'CPU') {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: 'IMAGE',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

self.onmessage = async (ev: MessageEvent) => {
  const d = ev.data;
  if (d?.type === 'init') {
    try {
      try {
        landmarker = await create(d.wasmBase, d.modelPath, 'GPU');
      } catch {
        landmarker = await create(d.wasmBase, d.modelPath, 'CPU');
      }
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  } else if (d?.type === 'frame') {
    const bitmap: ImageBitmap = d.bitmap;
    try {
      if (!landmarker) return;
      const res = landmarker.detect(bitmap);
      const aspect = bitmap.width && bitmap.height ? bitmap.width / bitmap.height : 4 / 3;
      const frame = computeLipFrame(
        res.faceLandmarks?.[0],
        res.facialTransformationMatrixes?.[0]?.data,
        d.t,
        res.faceBlendshapes?.[0]?.categories,
        aspect,
      );
      const face = res.faceLandmarks?.[0];
      const mesh = face ? (meshPoints(face) ?? undefined) : undefined;
      const meshV2 = face ? (meshPacked(face) ?? undefined) : undefined;
      postMessage({ type: 'frame', frame, mesh, meshV2 });
    } catch (err) {
      postMessage({ type: 'error', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      bitmap.close();
    }
  }
};
