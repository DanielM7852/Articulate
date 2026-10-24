/** Optional transport for the independent Python model collector. No capture or agent side effects. */
export type ArticulationModel = "sparc" | "arti6" | "silero_vad";
export interface FeatureSeries {
  channels: string[];
  units: string;
  interpretation: string;
  sampleRate: number;
  hopSamples: number;
  offsetSamples: number;
  timestampsMs: number[];
  values: number[][];
  withinAudio: boolean[];
  captureTimestampsMonotonicMs?: number[];
  summary: Record<string, Record<string, number> | null>;
  validSampleCounts?: number[];
  windowsStartMs?: number[];
  windowsEndMs?: number[];
}
export interface ArticulationOutput {
  model: ArticulationModel;
  status: "ok" | "unavailable" | "error" | "skipped";
  error: { code: string; message: string } | null;
  provenance: Record<string, unknown>;
  series: Record<string, FeatureSeries>;
  segments: {
    startSample: number;
    endSample: number;
    startMs: number;
    endMs: number;
  }[];
  timingsMs: Record<string, number>;
}
export interface ArticulationAttempt {
  schemaVersion: "articulate.articulation/1";
  attemptId: string;
  status: "ok" | "partial" | "no_model_outputs";
  audio: Record<string, unknown>;
  qualityFlags: string[];
  clock: {
    captureStartMonotonicMs: number | null;
    timeOriginUnixMs: number | null;
    alignment: string;
  };
  models: Partial<Record<ArticulationModel, ArticulationOutput>>;
  runtimeVersions: Record<string, string | null>;
  totalMs: number;
}
export interface AnalyzeAudioOptions {
  models?: ArticulationModel[];
  attemptId?: string;
  /** Must describe the start of the captured audio, not when the HTTP upload begins. */
  captureStartMonotonicMs?: number;
  timeOriginUnixMs?: number;
  endpoint?: string;
  signal?: AbortSignal;
}

export async function analyzeArticulation(
  wav: Blob,
  options: AnalyzeAudioOptions = {},
): Promise<ArticulationAttempt> {
  if (
    (options.captureStartMonotonicMs === undefined) !==
    (options.timeOriginUnixMs === undefined)
  ) {
    throw new Error("Provide both audio capture clock fields, or neither");
  }
  const query = new URLSearchParams();
  if (options.models) query.set("models", options.models.join(","));
  if (options.attemptId) query.set("attempt_id", options.attemptId);
  if (options.captureStartMonotonicMs !== undefined) {
    query.set(
      "capture_start_monotonic_ms",
      String(options.captureStartMonotonicMs),
    );
    query.set("time_origin_unix_ms", String(options.timeOriginUnixMs));
  }
  const response = await fetch(
    `${options.endpoint ?? "/v1/articulation/analyze"}?${query}`,
    {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
      signal: options.signal,
    },
  );
  if (!response.ok)
    throw new Error(
      `Articulation collector returned HTTP ${response.status}: ${await response.text()}`,
    );
  const result = await response.json();
  if (
    result.schemaVersion !== "articulate.articulation/1" ||
    !result.models ||
    typeof result.attemptId !== "string"
  ) {
    throw new Error("Unexpected articulation collector response");
  }
  return result as ArticulationAttempt;
}

/** Encodes captured mono samples; never uses MediaRecorder's browser-dependent WebM/Opus format. */
export function encodeMonoWav(samples: Float32Array, sampleRate: number): Blob {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    !samples.length ||
    samples.length > sampleRate * 30
  ) {
    throw new Error("Use 0–30 seconds of mono PCM at 8–96 kHz");
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    if (!Number.isFinite(sample) || Math.abs(sample) > 1)
      throw new Error("PCM samples must be finite and within [-1, 1]");
    view.setInt16(
      44 + i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  });
  return new Blob([buffer], { type: "audio/wav" });
}
