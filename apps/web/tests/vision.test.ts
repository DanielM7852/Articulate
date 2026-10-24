import { describe, expect, it } from "vitest";
import {
  extractFrame,
  INNER_LIP,
  measureImageQuality,
  poseFromMatrix,
  type FrameInput,
} from "../src/cv/features";
import { VisionRecorder, statistics } from "../src/cv/recorder";
import type { Point3, VisionImageSample } from "../src/cv/types";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1];
function face(): Point3[] {
  const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  p[33] = { x: 0.28, y: 0.35, z: 0 };
  p[133] = { x: 0.32, y: 0.35, z: 0 };
  p[263] = { x: 0.72, y: 0.35, z: 0 };
  p[362] = { x: 0.68, y: 0.35, z: 0 };
  INNER_LIP.forEach((index, i) => {
    const theta = (i / 20) * 2 * Math.PI;
    p[index] = {
      x: 0.5 + 0.11 * Math.cos(theta),
      y: 0.62 + 0.06 * Math.sin(theta),
      z: -0.02,
    };
  });
  p[61] = { x: 0.35, y: 0.62, z: 0 };
  p[291] = { x: 0.65, y: 0.62, z: 0 };
  p[0] = { x: 0.5, y: 0.53, z: -0.025 };
  p[17] = { x: 0.5, y: 0.71, z: -0.025 };
  p[2] = { x: 0.5, y: 0.48, z: 0 };
  p[152] = { x: 0.5, y: 0.85, z: 0 };
  return p;
}
function input(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    streamId: "stream-1",
    sequence: 0,
    model: {
      name: "MediaPipe Face Landmarker",
      runtimeVersion: "0.10.17",
      modelRevision: "face_landmarker/float16/1",
      delegate: "CPU",
      runningMode: "VIDEO",
    },
    captureMonotonicMs: 110,
    timeOriginUnixMs: 100000,
    mediaTimeMs: 40,
    inferenceStartedMonotonicMs: 112,
    inferenceEndedMonotonicMs: 120,
    width: 640,
    height: 480,
    faces: [face()],
    matrix: identity,
    blendshapes: [
      { categoryName: "mouthPucker", score: 0.6 },
      { categoryName: "eyeBlinkLeft", score: 0.4 },
    ],
    ...overrides,
  };
}
const sample = (frame: ReturnType<typeof extractFrame>): VisionImageSample => ({
  streamId: frame.streamId,
  sequence: frame.sequence,
  captureMonotonicMs: frame.timing.captureMonotonicMs,
  source: "webcam",
  mimeType: "image/jpeg",
  width: 256,
  height: 256,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  dataBase64: "dGVzdA==",
});

describe("CV observations", () => {
  it("preserves all landmarks, every blendshape, matrix and capture clocks", () => {
    const original = input(),
      f = extractFrame(original);
    expect(f.raw.landmarks).toHaveLength(478);
    expect(f.raw.blendshapes.eyeBlinkLeft).toBe(0.4);
    expect(f.raw.transformationMatrix?.data).toEqual(identity);
    expect(f.timing.captureMonotonicMs).toBe(110);
    expect(f.timing.captureUnixMs).toBe(100110);
    original.faces[0][0].x = 99;
    expect(f.raw.landmarks[0].x).toBe(0.5);
  });
  it("does not fabricate missing face, blendshapes, or pose", () => {
    const f = extractFrame(
      input({ faces: [], blendshapes: undefined, matrix: undefined }),
    );
    expect(f.quality.usable).toBe(false);
    expect(f.quality.rejectionReasons).toContain("missing_face");
    expect(f.geometry.lipOpening).toBeNull();
    expect(f.pose).toBeNull();
    expect(f.raw.blendshapes).toEqual({});
  });
  it("keeps measured geometry but flags missing optional model outputs", () => {
    const f = extractFrame(input({ blendshapes: [], matrix: undefined }));
    expect(f.geometry.lipOpening).toBeGreaterThan(0);
    expect(f.quality.warnings).toEqual([
      "head_pose_unavailable",
      "blendshapes_unavailable",
    ]);
  });
  it("is invariant to image aspect for the same pixel geometry", () => {
    const a = extractFrame(input({ width: 480, height: 480 }));
    const points = face().map((p) => ({
      ...p,
      x: 0.5 + (p.x - 0.5) / 2,
      z: p.z / 2,
    }));
    const b = extractFrame(input({ width: 960, height: 480, faces: [points] }));
    for (const k of [
      "lipOpening",
      "lipWidth",
      "lipProtrusionRelativeZ",
      "innerMouthArea",
    ] as const)
      expect(b.geometry[k]).toBeCloseTo(a.geometry[k]!, 8);
  });
  it("is invariant to face scale", () => {
    const a = extractFrame(input()),
      points = face().map((p) => ({
        x: 0.5 + (p.x - 0.5) * 0.7,
        y: 0.5 + (p.y - 0.5) * 0.7,
        z: p.z * 0.7,
      }));
    const b = extractFrame(input({ faces: [points] }));
    expect(b.geometry.lipOpening).toBeCloseTo(a.geometry.lipOpening!, 8);
    expect(b.geometry.innerMouthArea).toBeCloseTo(
      a.geometry.innerMouthArea!,
      8,
    );
  });
  it("does not mistake head roll for mouth asymmetry", () => {
    const angle = 0.3,
      aspect = 4 / 3;
    const p = face().map((p) => {
      const x = (p.x - 0.5) * aspect,
        y = p.y - 0.5;
      return {
        x: 0.5 + (x * Math.cos(angle) - y * Math.sin(angle)) / aspect,
        y: 0.5 + x * Math.sin(angle) + y * Math.cos(angle),
        z: p.z,
      };
    });
    expect(
      extractFrame(input({ faces: [p] })).geometry.cornerVerticalAsymmetry,
    ).toBeCloseTo(0, 8);
  });
  it("removes matrix scale before pose extraction and rejects extreme angles", () => {
    const angle = (30 * Math.PI) / 180,
      c = Math.cos(angle) * 2,
      s = Math.sin(angle) * 2,
      m = [c, 0, -s, 0, 0, 2, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
    expect(poseFromMatrix(m)?.yawDeg).toBeCloseTo(30);
    expect(
      extractFrame(input({ matrix: m })).quality.rejectionReasons,
    ).toContain("camera_angle_extreme");
  });
  it("flags multiple faces, degenerate landmarks, clipping and distance", () => {
    expect(
      extractFrame(input({ faces: [face(), face()] })).quality.rejectionReasons,
    ).toContain("multiple_faces");
    const p = face();
    p[13].x = NaN;
    const malformed = extractFrame(input({ faces: [p] }));
    expect(malformed.quality.rejectionReasons).toContain("invalid_landmarks");
    expect(malformed.raw.landmarks).toEqual([]);
    const clipped = face();
    clipped[61].x = 0;
    expect(
      extractFrame(input({ faces: [clipped] })).quality.rejectionReasons,
    ).toContain("face_clipped");
    expect(
      extractFrame(
        input({
          faces: [
            face().map((p) => ({
              x: 0.5 + (p.x - 0.5) * 0.01,
              y: 0.5 + (p.y - 0.5) * 0.01,
              z: p.z * 0.01,
            })),
          ],
        }),
      ).quality.rejectionReasons,
    ).toContain("face_too_far");
  });
  it("measures lighting without pretending it is model confidence", () => {
    const dark = measureImageQuality(
      new Uint8ClampedArray(4 * 16),
      4,
      4,
      "face",
    );
    expect(dark.meanLuminance).toBe(0);
    expect(dark.darkFraction).toBe(1);
    expect(dark.sharpnessVariance).toBe(0);
    expect(
      extractFrame(input({ imageQuality: dark })).quality.warnings,
    ).toContain("low_light");
  });
});

describe("bounded attempt export", () => {
  it("retains capture timestamps and admits a pre-cutoff result arriving during drain", () => {
    const r = new VisionRecorder();
    r.begin("a", 100, 100000);
    r.closeWindow(150);
    const f = extractFrame(input());
    f.timing.receivedMonotonicMs = 160;
    expect(r.push({ frame: f })).toBe(true);
    expect(
      r.push({
        frame: extractFrame(input({ sequence: 1, captureMonotonicMs: 160 })),
      }),
    ).toBe(false);
    const out = r.finish();
    expect(out.frames[0].timing.captureMonotonicMs).toBe(110);
    expect(out.summary.receiptLatencyMs?.mean).toBe(50);
  });
  it("rejects stale, duplicate and out-of-order frames", () => {
    const r = new VisionRecorder();
    r.begin("a", 100, 100000);
    expect(
      r.push({ frame: extractFrame(input({ captureMonotonicMs: 90 })) }),
    ).toBe(false);
    expect(r.push({ frame: extractFrame(input()) })).toBe(true);
    expect(r.push({ frame: extractFrame(input()) })).toBe(false);
    expect(
      r.push({ frame: extractFrame(input({ captureMonotonicMs: 109 })) }),
    ).toBe(false);
    r.closeWindow(150);
    expect(r.finish().summary.observedFrames).toBe(1);
  });
  it("excludes unusable observations from descriptive stats while retaining flags/raw data", () => {
    const r = new VisionRecorder();
    r.begin("a", 0, 100000);
    r.push({ frame: extractFrame(input()) });
    r.push({
      frame: extractFrame(input({ captureMonotonicMs: 200, faces: [] })),
    });
    r.closeWindow(300);
    const out = r.finish();
    expect(out.frames).toHaveLength(2);
    expect(out.summary.geometry.lipOpening.count).toBe(1);
    expect(out.summary.usableFraction).toBe(0.5);
    expect(out.summary.rejectionCounts.missing_face).toBe(1);
  });
  it("enforces caps and reports truncation", () => {
    const r = new VisionRecorder({ maxFrames: 3, maxImages: 2 });
    r.begin("a", 0, 100000);
    for (let i = 0; i < 5; i++) {
      const frame = extractFrame(
        input({ sequence: i, captureMonotonicMs: 110 + i * 50 }),
      );
      r.push({ frame, imageSample: sample(frame) });
    }
    r.closeWindow(400);
    const out = r.finish();
    expect(out.frames).toHaveLength(3);
    expect(out.summary.droppedFrames).toBe(2);
    expect(out.imageSamples).toHaveLength(2);
    expect(out.summary.droppedImageSamples).toBe(3);
    expect(out.summary.usableFrames).toBe(5);
  });
  it("keeps samples disabled and keyframes empty when no image was supplied", () => {
    const r = new VisionRecorder();
    r.begin("a", 0, 100000);
    r.push({ frame: extractFrame(input()) });
    r.closeWindow(200);
    const out = r.finish();
    expect(out.imageSamples).toEqual([]);
    expect(out.keyframes).toEqual([]);
    expect(out.summary.imageSamplesIncluded).toBe(false);
  });
  it("does not compute motion across a missing face or long gap", () => {
    const r = new VisionRecorder();
    r.begin("a", 0, 100000);
    r.push({ frame: extractFrame(input()) });
    r.push({
      frame: extractFrame(input({ captureMonotonicMs: 200, faces: [] })),
    });
    r.push({
      frame: extractFrame(
        input({
          captureMonotonicMs: 1000,
          blendshapes: [{ categoryName: "mouthPucker", score: 1 }],
        }),
      ),
    });
    r.closeWindow(1100);
    expect(r.finish().summary.maxSpeedPerSecond).toEqual({});
  });
  it("has no residual data after starting a new attempt", () => {
    const r = new VisionRecorder();
    r.begin("a", 0, 100000);
    r.push({ frame: extractFrame(input()) });
    r.closeWindow(200);
    r.finish();
    r.begin("b", 300, 100000);
    r.closeWindow(400);
    const out = r.finish();
    expect(out.frames).toEqual([]);
    expect(out.summary.observedFrames).toBe(0);
    expect(out.summary.geometry).toEqual({});
  });
  it("computes useful statistics without treating missing values as zero", () => {
    expect(statistics([])).toBeNull();
    expect(statistics([NaN, 1, 2, 3])?.mean).toBe(2);
    expect(statistics([1, 2, 3])?.median).toBe(2);
  });
});
