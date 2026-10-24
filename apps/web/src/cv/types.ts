/** Public CV-only contract. No acoustic scores, targets, or coaching decisions. */
export const CV_SCHEMA_VERSION = "articulate.cv/1" as const;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Matrix4 {
  rows: 4;
  columns: 4;
  layout: "column-major";
  data: number[];
}
export interface ModelInfo {
  name: "MediaPipe Face Landmarker";
  runtimeVersion: string;
  modelRevision: string;
  delegate: "GPU" | "CPU";
  runningMode: "VIDEO";
}
export interface ImageQuality {
  /** On the face bounding box, or entire image if no face was found. 0..255. */
  region: "face" | "image";
  meanLuminance: number;
  contrastStd: number;
  darkFraction: number;
  brightFraction: number;
  /** Laplacian variance at the analysis resolution; a heuristic, not confidence. */
  sharpnessVariance: number;
  analysisWidth: number;
  analysisHeight: number;
}
export interface Geometry {
  interocularDistanceImageHeight: number | null;
  lipOpening: number | null;
  outerLipHeight: number | null;
  lipWidth: number | null;
  lipAspectRatio: number | null;
  lipProtrusionRelativeZ: number | null;
  noseToChin: number | null;
  innerMouthArea: number | null;
  cornerVerticalAsymmetry: number | null;
  /** Roll-corrected coordinates, eye midpoint origin, one interocular distance = 1. */
  mouthCenter: Point3 | null;
}
export interface Pose {
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
}
export interface VisionFrame {
  schemaVersion: typeof CV_SCHEMA_VERSION;
  streamId: string;
  sequence: number;
  source: "webcam";
  model: ModelInfo;
  timing: {
    /** All monotonic times use the browser page's performance clock. */
    captureMonotonicMs: number;
    captureUnixMs: number;
    mediaTimeMs: number | null;
    inferenceStartedMonotonicMs: number;
    inferenceEndedMonotonicMs: number;
    receivedMonotonicMs: number;
  };
  image: { width: number; height: number; mirrored: false };
  raw: {
    faceCount: number;
    /** Original MediaPipe order, unrounded normalized x/y/z. */
    landmarks: Point3[];
    /** Every category emitted by the model, including non-oral categories. */
    blendshapes: Record<string, number>;
    transformationMatrix: Matrix4 | null;
  };
  geometry: Geometry;
  pose: Pose | null;
  mouthBox: Box | null;
  quality: {
    usable: boolean;
    /** Reject invalid geometry; retain raw observations even on unusable frames. */
    rejectionReasons: string[];
    warnings: string[];
    image: ImageQuality | null;
  };
}
export interface VisionImageSample {
  streamId: string;
  sequence: number;
  captureMonotonicMs: number;
  source: "webcam";
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /** Unmirrored, no overlays or generated geometry. */
  crop: Box;
  dataBase64: string;
}
export interface VisionObservation {
  frame: VisionFrame;
  imageSample?: VisionImageSample;
}
export interface CaptureStats {
  requested: number;
  processed: number;
  skippedBusy: number;
  skippedDuplicate: number;
  captureErrors: number;
  inferenceErrors: number;
}
export interface NumericStats {
  count: number;
  mean: number;
  min: number;
  max: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
}
export interface VisionAttempt {
  schemaVersion: typeof CV_SCHEMA_VERSION;
  attemptId: string;
  label: string | null;
  startedMonotonicMs: number;
  endedMonotonicMs: number;
  timeOriginUnixMs: number;
  /** Counters since the current camera stream started, not just this attempt. */
  captureStatsAtEnd: CaptureStats | null;
  annotations: {
    kind: string;
    captureMonotonicMs: number;
    data: Record<string, string | number | boolean | null>;
  }[];
  streamIds: string[];
  models: ModelInfo[];
  frames: VisionFrame[];
  imageSamples: VisionImageSample[];
  /** Neutral visual labels, deliberately not claimed to be voiced speech phases. */
  keyframes: {
    label: "first_usable" | "largest_visible_excursion" | "late_usable";
    sequence: number;
    streamId: string;
  }[];
  summary: {
    observedFrames: number;
    retainedFrames: number;
    droppedFrames: number;
    usableFrames: number;
    usableFraction: number;
    droppedImageSamples: number;
    rejectionCounts: Record<string, number>;
    warningCounts: Record<string, number>;
    /** Statistics cover retained usable frames only. */
    geometry: Record<string, NumericStats>;
    blendshapes: Record<string, NumericStats>;
    pose: Record<string, NumericStats>;
    /** Largest absolute change per second between adjacent usable frames, with gap gating. */
    maxSpeedPerSecond: Record<string, number>;
    inferenceMs: NumericStats | null;
    receiptLatencyMs: NumericStats | null;
    captureIntervalMs: NumericStats | null;
    coverage: {
      firstCaptureRelativeMs: number | null;
      lastCaptureRelativeMs: number | null;
      maxGapMs: number | null;
    };
    imageSamplesIncluded: boolean;
  };
}
