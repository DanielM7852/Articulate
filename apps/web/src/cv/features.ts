import {
  CV_SCHEMA_VERSION,
  type Box,
  type Geometry,
  type ImageQuality,
  type ModelInfo,
  type Point3,
  type VisionFrame,
} from "./types";

export const INNER_LIP = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82,
  81, 80, 191,
];
export const OUTER_LIP = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37,
  39, 40, 185,
];
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const midpoint = (a: Point3, b: Point3): Point3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});
const distance = (a: Point3, b: Point3, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

export function landmarkBox(points: Point3[], padding = 0): Box | null {
  if (!points.length) return null;
  const x0 = Math.min(...points.map((p) => p.x)),
    x1 = Math.max(...points.map((p) => p.x));
  const y0 = Math.min(...points.map((p) => p.y)),
    y1 = Math.max(...points.map((p) => p.y));
  const x = clamp(x0 - padding * (x1 - x0), 0, 1),
    y = clamp(y0 - padding * (y1 - y0), 0, 1);
  const right = clamp(x1 + padding * (x1 - x0), 0, 1),
    bottom = clamp(y1 + padding * (y1 - y0), 0, 1);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

/** R = Ry(yaw) Rx(pitch) Rz(roll); remove column scales before extracting angles. */
export function poseFromMatrix(
  data: number[] | undefined,
): VisionFrame["pose"] {
  if (!data || data.length !== 16 || !data.every(finite)) return null;
  const scale = [0, 4, 8].map((i) =>
    Math.hypot(data[i], data[i + 1], data[i + 2]),
  );
  if (scale.some((s) => s < 1e-8)) return null;
  const pitch = Math.asin(clamp(-data[9] / scale[2], -1, 1));
  const d = 180 / Math.PI;
  return {
    pitchDeg: pitch * d,
    yawDeg: Math.atan2(data[8] / scale[2], data[10] / scale[2]) * d,
    rollDeg: Math.atan2(data[1] / scale[0], data[5] / scale[1]) * d,
  };
}

export interface FrameInput {
  streamId: string;
  sequence: number;
  model: ModelInfo;
  captureMonotonicMs: number;
  timeOriginUnixMs: number;
  mediaTimeMs: number | null;
  inferenceStartedMonotonicMs: number;
  inferenceEndedMonotonicMs: number;
  width: number;
  height: number;
  faces: Point3[][];
  blendshapes?: { categoryName: string; score: number }[];
  matrix?: number[];
  imageQuality?: ImageQuality | null;
}

/** No target-dependent inference or invented blendshapes. Missing measurements stay null. */
export function extractFrame(input: FrameInput): VisionFrame {
  const { width, height } = input;
  const aspect = width / height;
  const points = input.faces[0] ?? [];
  const rejectionReasons: string[] = [],
    warnings: string[] = [];
  const geometry: Geometry = {
    interocularDistanceImageHeight: null,
    lipOpening: null,
    outerLipHeight: null,
    lipWidth: null,
    lipAspectRatio: null,
    lipProtrusionRelativeZ: null,
    noseToChin: null,
    innerMouthArea: null,
    cornerVerticalAsymmetry: null,
    mouthCenter: null,
  };
  const validPoints =
    points.length >= 468 &&
    points.every((p) => finite(p.x) && finite(p.y) && finite(p.z));
  if (!points.length) rejectionReasons.push("missing_face");
  else if (!validPoints) rejectionReasons.push("invalid_landmarks");
  if (!finite(aspect) || width <= 0 || height <= 0)
    rejectionReasons.push("invalid_image_size");
  if (input.faces.length > 1) rejectionReasons.push("multiple_faces");
  const matrix =
    input.matrix?.length === 16 && input.matrix.every(finite)
      ? [...input.matrix]
      : null;
  const pose = poseFromMatrix(matrix ?? undefined);
  if (!pose) warnings.push("head_pose_unavailable");
  if (pose && (Math.abs(pose.yawDeg) > 25 || Math.abs(pose.pitchDeg) > 20))
    rejectionReasons.push("camera_angle_extreme");
  const blendshapes: Record<string, number> = {};
  for (const c of input.blendshapes ?? []) {
    if (finite(c.score) && c.score >= 0 && c.score <= 1)
      blendshapes[c.categoryName] = c.score;
    else warnings.push("invalid_blendshape_score");
  }
  if (!Object.keys(blendshapes).length)
    warnings.push("blendshapes_unavailable");
  let mouthBox: Box | null = null;
  if (validPoints && finite(aspect) && aspect > 0) {
    const left = midpoint(points[33], points[133]),
      right = midpoint(points[263], points[362]);
    const origin = midpoint(left, right);
    const iod = distance(left, right, aspect);
    geometry.interocularDistanceImageHeight = iod;
    if (iod < 0.04) rejectionReasons.push("face_too_far");
    if (
      [0, 17, 61, 291, 2, 152].some(
        (i) =>
          points[i].x < 0.02 ||
          points[i].x > 0.98 ||
          points[i].y < 0.02 ||
          points[i].y > 0.98,
      )
    )
      rejectionReasons.push("face_clipped");
    mouthBox = landmarkBox(
      [points[2], points[152], ...OUTER_LIP.map((i) => points[i])],
      0.2,
    );
    if (iod > 1e-8) {
      const ux = ((right.x - left.x) * aspect) / iod,
        uy = (right.y - left.y) / iod;
      const local = (p: Point3): Point3 => {
        const dx = ((p.x - origin.x) * aspect) / iod,
          dy = (p.y - origin.y) / iod;
        return {
          x: dx * ux + dy * uy,
          y: -dx * uy + dy * ux,
          z: ((p.z - origin.z) * aspect) / iod,
        };
      };
      const corners = [local(points[61]), local(points[291])];
      const inner = INNER_LIP.map((i) => local(points[i]));
      const widthNorm = distance(points[61], points[291], aspect) / iod;
      const opening = distance(points[13], points[14], aspect) / iod;
      let area = 0;
      inner.forEach((p, i) => {
        const q = inner[(i + 1) % inner.length];
        area += p.x * q.y - q.x * p.y;
      });
      Object.assign(geometry, {
        lipOpening: opening,
        outerLipHeight: distance(points[0], points[17], aspect) / iod,
        lipWidth: widthNorm,
        lipAspectRatio: widthNorm > 1e-8 ? opening / widthNorm : null,
        lipProtrusionRelativeZ:
          (((points[61].z + points[291].z) / 2 -
            (points[0].z + points[13].z + points[14].z + points[17].z) / 4) *
            aspect) /
          iod,
        noseToChin: distance(points[2], points[152], aspect) / iod,
        innerMouthArea: Math.abs(area) / 2,
        cornerVerticalAsymmetry: Math.abs(corners[0].y - corners[1].y),
        mouthCenter: local(midpoint(points[13], points[14])),
      });
    }
  }
  const imageQuality = input.imageQuality ?? null;
  if (imageQuality) {
    if (imageQuality.meanLuminance < 35) warnings.push("low_light");
    if (imageQuality.brightFraction > 0.35) warnings.push("overexposed");
    if (imageQuality.contrastStd < 12) warnings.push("low_contrast");
  }
  return {
    schemaVersion: CV_SCHEMA_VERSION,
    streamId: input.streamId,
    sequence: input.sequence,
    source: "webcam",
    model: input.model,
    timing: {
      captureMonotonicMs: input.captureMonotonicMs,
      captureUnixMs: input.timeOriginUnixMs + input.captureMonotonicMs,
      mediaTimeMs: input.mediaTimeMs,
      inferenceStartedMonotonicMs: input.inferenceStartedMonotonicMs,
      inferenceEndedMonotonicMs: input.inferenceEndedMonotonicMs,
      receivedMonotonicMs: input.inferenceEndedMonotonicMs,
    },
    image: { width, height, mirrored: false },
    raw: {
      faceCount: input.faces.length,
      landmarks: validPoints ? points.map((p) => ({ ...p })) : [],
      blendshapes,
      transformationMatrix: matrix
        ? { rows: 4, columns: 4, layout: "column-major", data: matrix }
        : null,
    },
    geometry,
    pose,
    mouthBox,
    quality: {
      usable: rejectionReasons.length === 0,
      rejectionReasons: [...new Set(rejectionReasons)],
      warnings: [...new Set(warnings)],
      image: imageQuality,
    },
  };
}

/** RGBA image-quality heuristics. Exported separately to keep the math independently testable. */
export function measureImageQuality(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  region: ImageQuality["region"],
): ImageQuality {
  const n = width * height,
    gray = new Float64Array(n);
  let sum = 0,
    sum2 = 0,
    dark = 0,
    bright = 0;
  for (let i = 0; i < n; i++) {
    const y =
      0.2126 * rgba[4 * i] +
      0.7152 * rgba[4 * i + 1] +
      0.0722 * rgba[4 * i + 2];
    gray[i] = y;
    sum += y;
    sum2 += y * y;
    if (y < 15) dark++;
    if (y > 240) bright++;
  }
  let lap = 0,
    lap2 = 0,
    count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x,
        v =
          gray[i - 1] +
          gray[i + 1] +
          gray[i - width] +
          gray[i + width] -
          4 * gray[i];
      lap += v;
      lap2 += v * v;
      count++;
    }
  return {
    region,
    meanLuminance: sum / n,
    contrastStd: Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)),
    darkFraction: dark / n,
    brightFraction: bright / n,
    sharpnessVariance: count
      ? Math.max(0, lap2 / count - (lap / count) ** 2)
      : 0,
    analysisWidth: width,
    analysisHeight: height,
  };
}
