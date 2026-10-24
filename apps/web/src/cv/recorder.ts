import {
  CV_SCHEMA_VERSION,
  type CaptureStats,
  type NumericStats,
  type VisionAttempt,
  type VisionFrame,
  type VisionObservation,
  type VisionImageSample,
} from "./types";

export function statistics(values: number[]): NumericStats | null {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const quantile = (q: number) => {
    const i = (a.length - 1) * q,
      lo = Math.floor(i);
    return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
  };
  return {
    count: a.length,
    mean,
    min: a[0],
    max: a[a.length - 1],
    median: quantile(0.5),
    p10: quantile(0.1),
    p90: quantile(0.9),
    std: Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length),
  };
}
function columns(
  frames: VisionFrame[],
  field: "geometry" | "pose" | "blendshapes",
): Record<string, NumericStats> {
  const values: Record<string, number[]> = {};
  for (const f of frames) {
    const obj = field === "blendshapes" ? f.raw.blendshapes : f[field];
    for (const [key, v] of Object.entries(obj ?? {}))
      if (typeof v === "number" && Number.isFinite(v))
        (values[key] ??= []).push(v);
  }
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, statistics(v)!]),
  );
}
function maxSpeeds(frames: VisionFrame[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1],
      b = frames[i],
      dt = (b.timing.captureMonotonicMs - a.timing.captureMonotonicMs) / 1000;
    if (
      !a.quality.usable ||
      !b.quality.usable ||
      a.streamId !== b.streamId ||
      dt <= 0 ||
      dt > 0.25
    )
      continue;
    for (const field of ["geometry", "blendshapes"] as const) {
      const av = field === "geometry" ? a.geometry : a.raw.blendshapes,
        bv = field === "geometry" ? b.geometry : b.raw.blendshapes;
      for (const [key, value] of Object.entries(bv)) {
        const before = (av as Record<string, unknown>)[key];
        if (
          typeof value !== "number" ||
          typeof before !== "number" ||
          !Number.isFinite(value) ||
          !Number.isFinite(before)
        )
          continue;
        const name = `${field}.${key}`;
        result[name] = Math.max(
          result[name] ?? 0,
          Math.abs(value - before) / dt,
        );
      }
    }
  }
  return result;
}

/** Bounded attempt recorder. Retains original timestamps; rejects pre-attempt/stale/out-of-order results. */
export class VisionRecorder {
  private active = false;
  private cutoff = Infinity;
  private frames: VisionFrame[] = [];
  private images: VisionImageSample[] = [];
  private observed = 0;
  private usable = 0;
  private droppedImages = 0;
  private rejected: Record<string, number> = {};
  private warnings: Record<string, number> = {};
  private streams = new Map<string, VisionFrame["model"]>();
  private last = new Map<string, number>();
  private id = "";
  private label: string | null = null;
  private started = 0;
  private timeOrigin = 0;
  private first: number | null = null;
  private latest: number | null = null;
  private maxGap: number | null = null;
  private annotations: VisionAttempt["annotations"] = [];

  constructor(
    private readonly options: { maxFrames?: number; maxImages?: number } = {},
  ) {
    if (
      !Number.isInteger(options.maxFrames ?? 1800) ||
      (options.maxFrames ?? 1800) < 1
    )
      throw new Error("maxFrames must be a positive integer");
    if (
      !Number.isInteger(options.maxImages ?? 48) ||
      (options.maxImages ?? 48) < 0
    )
      throw new Error("maxImages must be a nonnegative integer");
  }
  begin(
    attemptId: string,
    startedMonotonicMs: number,
    timeOriginUnixMs: number,
    label: string | null = null,
  ): void {
    this.active = true;
    this.cutoff = Infinity;
    this.frames = [];
    this.images = [];
    this.observed = 0;
    this.usable = 0;
    this.droppedImages = 0;
    this.rejected = {};
    this.warnings = {};
    this.streams.clear();
    this.last.clear();
    this.id = attemptId;
    this.label = label;
    this.started = startedMonotonicMs;
    this.timeOrigin = timeOriginUnixMs;
    this.first = null;
    this.latest = null;
    this.maxGap = null;
    this.annotations = [];
  }
  /** Call before draining in-flight inference so the final captured frame can still be included. */
  closeWindow(endedMonotonicMs: number): void {
    this.cutoff = Math.max(this.started, endedMonotonicMs);
  }
  /** Optional external timing markers, e.g. speech.start/end, reference playback, or camera failure. */
  mark(
    kind: string,
    captureMonotonicMs: number,
    data: Record<string, string | number | boolean | null> = {},
  ): void {
    if (
      !this.active ||
      captureMonotonicMs < this.started ||
      captureMonotonicMs > this.cutoff ||
      !Number.isFinite(captureMonotonicMs)
    )
      return;
    if (this.annotations.length >= 128)
      throw new Error("CV annotation limit reached");
    if (
      !kind ||
      kind.length > 120 ||
      Object.values(data).some(
        (v) => typeof v === "number" && !Number.isFinite(v),
      )
    )
      throw new Error("Invalid CV annotation");
    this.annotations.push({
      kind,
      captureMonotonicMs,
      data: structuredClone(data),
    });
  }
  push({ frame, imageSample }: VisionObservation): boolean {
    const t = frame.timing.captureMonotonicMs;
    if (
      !this.active ||
      !Number.isFinite(t) ||
      t < this.started ||
      t > this.cutoff ||
      t < (this.latest ?? -Infinity) ||
      t <= (this.last.get(frame.streamId) ?? -Infinity)
    )
      return false;
    this.last.set(frame.streamId, t);
    this.streams.set(frame.streamId, frame.model);
    this.observed++;
    if (frame.quality.usable) this.usable++;
    for (const flag of frame.quality.rejectionReasons)
      this.rejected[flag] = (this.rejected[flag] ?? 0) + 1;
    for (const flag of frame.quality.warnings)
      this.warnings[flag] = (this.warnings[flag] ?? 0) + 1;
    if (this.first === null) this.first = t;
    if (this.latest !== null)
      this.maxGap = Math.max(this.maxGap ?? 0, t - this.latest);
    this.latest = t;
    if (this.frames.length >= (this.options.maxFrames ?? 1800)) {
      if (imageSample) this.droppedImages++;
      return true;
    }
    // Own our buffers: downstream consumers cannot mutate a previously recorded observation.
    this.frames.push(structuredClone(frame));
    if (
      imageSample &&
      imageSample.streamId === frame.streamId &&
      imageSample.sequence === frame.sequence &&
      frame.quality.usable
    ) {
      const cap = this.options.maxImages ?? 48;
      if (cap === 0) {
        this.droppedImages++;
        return true;
      }
      if (this.images.length >= cap) {
        // Preserve the first image and spread the rest through time instead of filling with early frames.
        this.images.splice(
          cap === 1 ? 0 : 1 + (this.droppedImages % (cap - 1)),
          1,
        );
        this.droppedImages++;
      }
      this.images.push(structuredClone(imageSample));
    }
    return true;
  }
  get recording(): boolean {
    return this.active;
  }
  get observedFrames(): number {
    return this.observed;
  }
  discard(): void {
    this.active = false;
    this.frames = [];
    this.images = [];
  }
  finish(
    endedMonotonicMs = this.cutoff,
    captureStatsAtEnd: CaptureStats | null = null,
  ): VisionAttempt {
    if (!this.active) throw new Error("No CV attempt is recording");
    if (!Number.isFinite(endedMonotonicMs))
      throw new Error("Close the capture window before finishing");
    if (endedMonotonicMs < this.started)
      throw new Error("Attempt end precedes start");
    if (this.latest !== null && endedMonotonicMs < this.latest)
      throw new Error(
        "Attempt end precedes an accepted frame; closeWindow before draining",
      );
    this.active = false;
    const frames = this.frames.filter(
      (f) => f.timing.captureMonotonicMs <= endedMonotonicMs,
    );
    const usable = frames.filter((f) => f.quality.usable);
    const images = this.images
      .filter((s) =>
        frames.some(
          (f) => f.streamId === s.streamId && f.sequence === s.sequence,
        ),
      )
      .sort((a, b) => a.captureMonotonicMs - b.captureMonotonicMs);
    const candidates = images
      .map((s) =>
        frames.find(
          (f) => f.streamId === s.streamId && f.sequence === s.sequence,
        )!,
      )
      .filter(Boolean);
    const magnitude = (f: VisionFrame) =>
      (f.raw.blendshapes.jawOpen ?? 0) +
      (f.raw.blendshapes.mouthPucker ?? 0) +
      (f.geometry.lipOpening ?? 0);
    const peak = candidates.reduce<VisionFrame | null>(
      (p, f) => (!p || magnitude(f) > magnitude(p) ? f : p),
      null,
    );
    const keyframes: VisionAttempt["keyframes"] = [];
    const add = (
      label: VisionAttempt["keyframes"][number]["label"],
      f: VisionFrame | undefined | null,
    ) => {
      if (f)
        keyframes.push({ label, sequence: f.sequence, streamId: f.streamId });
    };
    add("first_usable", candidates[0]);
    add("largest_visible_excursion", peak);
    add("late_usable", candidates.at(-1));
    const duration = (f: VisionFrame) =>
      f.timing.inferenceEndedMonotonicMs - f.timing.inferenceStartedMonotonicMs;
    const intervals = frames
      .slice(1)
      .flatMap((f, i) =>
        f.streamId === frames[i].streamId
          ? [f.timing.captureMonotonicMs - frames[i].timing.captureMonotonicMs]
          : [],
      );
    return {
      schemaVersion: CV_SCHEMA_VERSION,
      attemptId: this.id,
      label: this.label,
      startedMonotonicMs: this.started,
      endedMonotonicMs,
      timeOriginUnixMs: this.timeOrigin,
      captureStatsAtEnd,
      annotations: structuredClone(this.annotations),
      streamIds: [...this.streams.keys()],
      models: [...this.streams.values()],
      frames,
      imageSamples: images,
      keyframes,
      summary: {
        observedFrames: this.observed,
        retainedFrames: frames.length,
        droppedFrames: this.observed - frames.length,
        usableFrames: this.usable,
        usableFraction: this.observed ? this.usable / this.observed : 0,
        droppedImageSamples: this.droppedImages,
        rejectionCounts: { ...this.rejected },
        warningCounts: { ...this.warnings },
        geometry: columns(usable, "geometry"),
        blendshapes: columns(usable, "blendshapes"),
        pose: columns(usable, "pose"),
        maxSpeedPerSecond: maxSpeeds(frames),
        inferenceMs: statistics(frames.map(duration)),
        receiptLatencyMs: statistics(
          frames.map(
            (f) => f.timing.receivedMonotonicMs - f.timing.captureMonotonicMs,
          ),
        ),
        captureIntervalMs: statistics(intervals),
        coverage: {
          firstCaptureRelativeMs:
            this.first === null ? null : this.first - this.started,
          lastCaptureRelativeMs:
            this.latest === null ? null : this.latest - this.started,
          maxGapMs: this.maxGap,
        },
        imageSamplesIncluded: images.length > 0,
      },
    };
  }
}
