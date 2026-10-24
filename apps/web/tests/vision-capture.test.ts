import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VisionCapture } from "../src/cv/capture";
import { extractFrame } from "../src/cv/features";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  messages: any[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: any) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
class FakeCanvas {
  getContext() {
    return { drawImage: () => {} };
  }
  transferToImageBitmap() {
    return { close: vi.fn() };
  }
}
const video = {
  readyState: 2,
  videoWidth: 640,
  videoHeight: 480,
  currentTime: 1,
} as HTMLVideoElement;
const model = {
  name: "MediaPipe Face Landmarker" as const,
  runtimeVersion: "0.10.17",
  modelRevision: "face_landmarker/float16/1",
  delegate: "CPU" as const,
  runningMode: "VIDEO" as const,
};
beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("window", {
    location: { href: "http://localhost/vision.html" },
  });
  video.currentTime = 1;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function start(capture: VisionCapture) {
  const ready = capture.start(video);
  const worker = FakeWorker.instances.at(-1)!;
  worker.emit({ type: "ready", model });
  await ready;
  return worker;
}
function result(worker: FakeWorker) {
  const sent = worker.messages.find((m) => m.type === "frame");
  return extractFrame({
    streamId: sent.streamId,
    sequence: sent.sequence,
    model,
    captureMonotonicMs: sent.captureMonotonicMs,
    timeOriginUnixMs: 0,
    mediaTimeMs: 1000,
    inferenceStartedMonotonicMs: 0,
    inferenceEndedMonotonicMs: 1,
    width: 640,
    height: 480,
    faces: [],
  });
}

it("skips busy frames without emitting invented measurements, and drain waits for the real result", async () => {
  const onObservation = vi.fn(),
    capture = new VisionCapture({ onObservation });
  const worker = await start(capture);
  await vi.advanceTimersByTimeAsync(200);
  expect(capture.stats.skippedBusy).toBeGreaterThan(0);
  expect(onObservation).not.toHaveBeenCalled();
  let drained = false;
  const draining = capture.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  worker.emit({ type: "observation", observation: { frame: result(worker) } });
  await draining;
  expect(drained).toBe(true);
  expect(onObservation).toHaveBeenCalledOnce();
  capture.stop();
});
it("fails closed on worker error and resolves pending drain", async () => {
  const onObservation = vi.fn(),
    onStatus = vi.fn(),
    capture = new VisionCapture({ onObservation, onStatus });
  const worker = await start(capture);
  await vi.advanceTimersByTimeAsync(50);
  worker.emit({ type: "error", fatal: false, detail: "GPU lost" });
  await capture.drain();
  expect(worker.terminated).toBe(true);
  expect(onObservation).not.toHaveBeenCalled();
  expect(onStatus).toHaveBeenLastCalledWith("error", "GPU lost");
  expect(capture.stats.inferenceErrors).toBe(1);
  capture.stop();
});
it("cancels initialization on stop and ignores late ready messages", async () => {
  const capture = new VisionCapture(),
    ready = capture.start(video);
  const rejected = expect(ready).rejects.toThrow("stopped");
  const worker = FakeWorker.instances.at(-1)!;
  capture.stop();
  worker.emit({ type: "ready", model });
  await rejected;
  expect(capture.model).toBeNull();
});
it("does not sample duplicate decoded video frames or request images by default", async () => {
  const capture = new VisionCapture(),
    worker = await start(capture);
  await vi.advanceTimersByTimeAsync(50);
  expect(worker.messages.find((m) => m.type === "frame").includeImage).toBe(
    false,
  );
  worker.emit({ type: "observation", observation: { frame: result(worker) } });
  await vi.advanceTimersByTimeAsync(100);
  expect(capture.stats.skippedDuplicate).toBeGreaterThan(0);
  expect(capture.stats.requested).toBe(1);
  capture.stop();
});
it("terminates a hung model without manufacturing a usable frame", async () => {
  const onStatus = vi.fn(),
    capture = new VisionCapture({ onStatus }),
    worker = await start(capture);
  await vi.advanceTimersByTimeAsync(8100);
  await capture.drain();
  expect(worker.terminated).toBe(true);
  expect(onStatus).toHaveBeenLastCalledWith("error", "CV inference timed out");
  capture.stop();
});
