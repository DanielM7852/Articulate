import {
  CV_SCHEMA_VERSION,
  type CaptureStats,
  type ModelInfo,
  type VisionObservation,
} from "./types";

export interface VisionCaptureOptions {
  wasmBaseUrl?: string;
  modelAssetPath?: string;
  runtimeVersion?: string;
  modelRevision?: string;
  maxFps?: number;
  imageIntervalMs?: number;
  /** Optional snapshots are disabled by default, and can be scoped to an attempt. */
  includeImages?: () => boolean;
  onStatus?: (
    status: "loading" | "ready" | "error" | "off",
    detail?: string,
  ) => void;
  onObservation?: (observation: VisionObservation) => void;
}

/** Reusable browser-only collector. Owns inference, not the camera stream or application state. */
export class VisionCapture {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameTimeout: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private generation = 0;
  private done: (() => void) | null = null;
  private pending: Promise<void> = Promise.resolve();
  private cancelInit: ((reason: Error) => void) | null = null;
  private listeners = new Set<(observation: VisionObservation) => void>();
  private counters: CaptureStats = {
    requested: 0,
    processed: 0,
    skippedBusy: 0,
    skippedDuplicate: 0,
    captureErrors: 0,
    inferenceErrors: 0,
  };
  model: ModelInfo | null = null;
  streamId: string | null = null;

  constructor(private readonly options: VisionCaptureOptions = {}) {
    if (options.onObservation) this.listeners.add(options.onObservation);
    if (
      options.maxFps !== undefined &&
      (!Number.isFinite(options.maxFps) ||
        options.maxFps < 1 ||
        options.maxFps > 60)
    )
      throw new Error("maxFps must be between 1 and 60");
  }
  get stats(): CaptureStats {
    return { ...this.counters };
  }
  subscribe(fn: (observation: VisionObservation) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  async drain(): Promise<void> {
    await this.pending;
  }
  private release(): void {
    this.busy = false;
    if (this.frameTimeout) clearTimeout(this.frameTimeout);
    this.frameTimeout = null;
    this.done?.();
    this.done = null;
  }
  stop(): void {
    this.generation++;
    this.cancelInit?.(new Error("CV capture stopped"));
    this.cancelInit = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.release();
    this.model = null;
    this.options.onStatus?.("off");
  }
  async start(video: HTMLVideoElement): Promise<void> {
    this.stop();
    const generation = this.generation;
    const streamId = crypto.randomUUID();
    this.streamId = streamId;
    this.counters = {
      requested: 0,
      processed: 0,
      skippedBusy: 0,
      skippedDuplicate: 0,
      captureErrors: 0,
      inferenceErrors: 0,
    };
    this.options.onStatus?.("loading");
    const origin = new URL(import.meta.env.BASE_URL, window.location.href);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    let resolveReady: () => void = () => {},
      rejectReady: (e: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.cancelInit = rejectReady;
    let failed = false;
    const fail = (detail: string) => {
      if (generation !== this.generation || failed) return;
      failed = true;
      rejectReady(new Error(detail));
      this.cancelInit = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      worker.terminate();
      this.worker = null;
      this.release();
      this.model = null;
      this.options.onStatus?.("error", detail);
    };
    worker.onerror = (e) => {
      this.counters.inferenceErrors++;
      fail(e.message || "CV worker failed");
    };
    worker.onmessage = (event) => {
      if (generation !== this.generation || failed) return;
      const d = event.data;
      if (d.type === "ready") {
        this.model = d.model;
        resolveReady();
        this.cancelInit = null;
      } else if (d.type === "error") {
        this.counters.inferenceErrors++;
        fail(d.detail || "CV inference failed");
      } else if (d.type === "observation") {
        const observation: VisionObservation = d.observation;
        if (
          observation.frame.schemaVersion !== CV_SCHEMA_VERSION ||
          observation.frame.streamId !== streamId
        ) {
          fail("Unexpected CV frame provenance");
          return;
        }
        observation.frame.timing.receivedMonotonicMs = performance.now();
        this.counters.processed++;
        try {
          for (const fn of this.listeners) fn(observation);
        } finally {
          this.release();
        }
      }
    };
    worker.postMessage({
      type: "init",
      timeOriginUnixMs: performance.timeOrigin,
      wasmBaseUrl:
        this.options.wasmBaseUrl ?? new URL("mediapipe/wasm", origin).href,
      modelAssetPath:
        this.options.modelAssetPath ??
        new URL("mediapipe/face_landmarker.task", origin).href,
      runtimeVersion: this.options.runtimeVersion ?? "0.10.17",
      modelRevision: this.options.modelRevision ?? "face_landmarker/float16/1",
    });
    const initTimer = setTimeout(
      () => fail("CV model initialization timed out"),
      30000,
    );
    try {
      await ready;
    } catch (err) {
      if (generation === this.generation && this.worker)
        fail(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(initTimer);
    }
    if (generation !== this.generation) return;
    this.options.onStatus?.("ready");
    let sequence = 0,
      lastVideoTime = -1,
      lastImageTime = -Infinity;
    // Frozen source pixels are transferred to the worker: JPEG samples match the inferred frame.
    let canvas: OffscreenCanvas | null = null;
    this.timer = setInterval(
      () => {
        if (
          generation !== this.generation ||
          !this.worker ||
          video.readyState < 2 ||
          !video.videoWidth
        )
          return;
        if (this.busy) {
          this.counters.skippedBusy++;
          return;
        }
        if (video.currentTime === lastVideoTime) {
          this.counters.skippedDuplicate++;
          return;
        }
        lastVideoTime = video.currentTime;
        this.counters.requested++;
        this.busy = true;
        this.pending = new Promise<void>((resolve) => {
          this.done = resolve;
        });
        let bitmap: ImageBitmap | null = null;
        try {
          const t = performance.now();
          if (
            !canvas ||
            canvas.width !== video.videoWidth ||
            canvas.height !== video.videoHeight
          )
            canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
          canvas.getContext("2d")!.drawImage(video, 0, 0);
          bitmap = canvas.transferToImageBitmap();
          const includeImage =
            !!this.options.includeImages?.() &&
            t - lastImageTime >= (this.options.imageIntervalMs ?? 250);
          if (includeImage) lastImageTime = t;
          worker.postMessage(
            {
              type: "frame",
              streamId,
              sequence: sequence++,
              captureMonotonicMs: t,
              mediaTimeMs: video.currentTime * 1000,
              includeImage,
              bitmap,
            },
            [bitmap],
          );
          this.frameTimeout = setTimeout(() => {
            this.counters.inferenceErrors++;
            fail("CV inference timed out");
          }, 8000);
        } catch (err) {
          bitmap?.close();
          this.counters.captureErrors++;
          fail(
            err instanceof Error
              ? err.message
              : "Unable to capture camera frame",
          );
        }
      },
      1000 / (this.options.maxFps ?? 20),
    );
  }
}
