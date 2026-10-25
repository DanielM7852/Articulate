/**
 * Pure lip/jaw feature extraction from a MediaPipe FaceLandmarker result.
 * Ported from the cv branch (apps/web/src/vision.ts computeVisionTelemetry).
 * All distances are normalised by the inter-ocular distance (IOD).
 *
 * Intentional deviations from cv: output is a flat LipFrame (camelCase, no overlay,
 * no blendshape map, no vermilion_flare); invalid frames carry zeros instead of null;
 * synthetic-data and keyframe code was not ported.
 */

export interface LipFrame {
  t: number;
  ok: boolean;
  flags: string[];
  lipOpening: number;
  outerLipHeight: number;
  lipWidth: number;
  lipAspectRatio: number;
  lipProtrusionZ: number;
  jawDrop: number;
  mouthSymmetry: number;
  innerMouthArea: number;
  rounding: number;
  spread: number;
  openness: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface BlendshapeCategory {
  categoryName: string;
  score: number;
}

const INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

const OUTER_LIP = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const MESH_ORDER = [...OUTER_LIP, ...INNER_LIP, ...FACE_OVAL, 33, 133, 362, 263, 1];

/**
 * 81 face-mesh points (outer lip, inner lip, face oval, eyes, nose tip) as a flat [x,y,...] int
 * array in 0..255, normalised into a nose-centred square of half-size 1.6 x inter-ocular distance.
 * Returns null when a landmark is missing.
 */
export function meshPoints(L: Point3D[] | { x: number; y: number }[]): number[] | null {
  for (const i of MESH_ORDER) if (!L[i]) return null;
  const mid = (a: number, b: number) => ({ x: (L[a].x + L[b].x) / 2, y: (L[a].y + L[b].y) / 2 });
  const le = mid(33, 133);
  const re = mid(362, 263);
  const iod = Math.hypot(le.x - re.x, le.y - re.y);
  if (!(iod > 1e-6)) return null;
  const half = 1.6 * iod;
  const nose = L[1];
  const out: number[] = [];
  for (const i of MESH_ORDER) {
    const nx = (L[i].x - nose.x) / half; // -1..1
    const ny = (L[i].y - nose.y) / half;
    out.push(clamp(Math.round(((nx + 1) / 2) * 255), 0, 255), clamp(Math.round(((ny + 1) / 2) * 255), 0, 255));
  }
  return out;
}

const ORAL_BLENDSHAPES = new Set([
  'jawOpen', 'jawForward', 'jawLeft', 'jawRight', 'mouthPucker', 'mouthFunnel', 'mouthClose',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight',
  'mouthRollUpper', 'mouthRollLower', 'mouthShrugUpper', 'mouthShrugLower', 'cheekPuff',
]);

const r4 = (n: number) => Number(n.toFixed(4));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const dist2D = (a: Point3D, b: Point3D, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function shoelaceArea(pts: Point3D[], aspect: number): number {
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * aspect * pts[j].y - pts[j].x * aspect * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function eulerFromMatrix(m?: ArrayLike<number>): { pitch: number; yaw: number; roll: number } | null {
  if (!m || m.length < 16) return null;
  // Column-major 4x4: R02 = m[8], R12 = m[9], R22 = m[10], R10 = m[1], R11 = m[5]
  const d = 180 / Math.PI;
  return {
    pitch: Number((Math.asin(clamp(-m[9], -1, 1)) * d).toFixed(2)),
    yaw: Number((Math.atan2(m[8], m[10]) * d).toFixed(2)),
    roll: Number((Math.atan2(m[1], m[5]) * d).toFixed(2)),
  };
}

function emptyFrame(t: number, flags: string[], pose?: { pitch: number; yaw: number; roll: number }): LipFrame {
  return {
    t, ok: false, flags,
    lipOpening: 0, outerLipHeight: 0, lipWidth: 0, lipAspectRatio: 0, lipProtrusionZ: 0,
    jawDrop: 0, mouthSymmetry: 0, innerMouthArea: 0, rounding: 0, spread: 0, openness: 0,
    yawDeg: pose?.yaw ?? 0, pitchDeg: pose?.pitch ?? 0, rollDeg: pose?.roll ?? 0,
  };
}

/**
 * @param landmarks   normalised face landmarks (>= 468 points) or undefined when no face
 * @param matrix      facial transformation matrix data (column-major 4x4), optional
 * @param t           performance.now() at frame capture
 * @param blendshapes optional MediaPipe blendshape categories (used for the 0..1 scores)
 * @param aspect      video width / height
 */
export function computeLipFrame(
  landmarks: Point3D[] | undefined,
  matrix: ArrayLike<number> | undefined,
  t: number,
  blendshapes?: BlendshapeCategory[],
  aspect = 4 / 3,
): LipFrame {
  if (!landmarks || landmarks.length < 468) return emptyFrame(t, ['missing_face']);

  const L = landmarks;
  const leftEye = { x: (L[33].x + L[133].x) / 2, y: (L[33].y + L[133].y) / 2, z: (L[33].z + L[133].z) / 2 };
  const rightEye = { x: (L[263].x + L[362].x) / 2, y: (L[263].y + L[362].y) / 2, z: (L[263].z + L[362].z) / 2 };
  const iod = dist2D(leftEye, rightEye, aspect);

  const flags: string[] = [];
  if (iod < 0.04) flags.push('face_too_far');

  const p0 = L[0], p17 = L[17], p13 = L[13], p14 = L[14], p61 = L[61], p291 = L[291], p2 = L[2], p152 = L[152];

  if ([p0, p17, p61, p291].some((p) => p.x < 0.02 || p.x > 0.98 || p.y < 0.02 || p.y > 0.98)) {
    flags.push('face_clipped');
  }

  const pose = eulerFromMatrix(matrix) ?? {
    pitch: Number((((p2.y - (leftEye.y + rightEye.y) / 2) / Math.max(0.01, iod) - 0.6) * 45).toFixed(2)),
    yaw: Number((((p2.x - (leftEye.x + rightEye.x) / 2) / Math.max(0.01, iod)) * 65).toFixed(2)),
    roll: Number(
      (Math.atan2(rightEye.y - leftEye.y, (rightEye.x - leftEye.x) * aspect) * (180 / Math.PI)).toFixed(2),
    ),
  };

  if (Math.abs(pose.yaw) > 25 || Math.abs(pose.pitch) > 20) flags.push('camera_angle_extreme');
  if (flags.length > 0) return emptyFrame(t, flags, pose);

  const innerLip = INNER_LIP.map((i) => L[i]);
  const safeIod = Math.max(0.02, iod);
  const yawCos = Math.max(0.85, Math.cos((pose.yaw * Math.PI) / 180));
  const rawInnerH = dist2D(p13, p14, aspect);
  const rawOuterH = dist2D(p0, p17, aspect);
  const rawWidth = dist2D(p61, p291, aspect);

  const lipOpening = Math.min(2, r4(rawInnerH / safeIod));
  const outerLipHeight = Math.min(2, r4(rawOuterH / safeIod));
  const lipWidth = Math.min(3, r4(rawWidth / (safeIod * yawCos)));
  const lipAspectRatio = Math.min(3, r4(rawInnerH / Math.max(0.005, rawWidth)));

  // MediaPipe z is negative toward the camera.
  const centerZ = (p0.z + p13.z + p14.z + p17.z) / 4;
  const cornerZ = (p61.z + p291.z) / 2;
  const lipProtrusionZ = clamp(r4((cornerZ - centerZ) / safeIod), -1, 1);

  const jawDrop = Math.min(3, r4(dist2D(p2, p152, aspect) / safeIod));
  const mouthSymmetry = Math.min(1, r4(Math.abs(p61.y - p291.y) / safeIod));
  const innerMouthArea = Math.min(2, r4(shoelaceArea(innerLip, aspect) / (safeIod * safeIod)));

  // Oral blendshapes; when the model emitted none, cv's geometric estimate is used.
  const bs: Record<string, number> = {};
  if (blendshapes && blendshapes.length > 0) {
    for (const c of blendshapes) if (ORAL_BLENDSHAPES.has(c.categoryName)) bs[c.categoryName] = r4(clamp(c.score, 0, 1));
  } else {
    const estJawOpen = clamp((lipOpening - 0.08) / 0.5, 0, 1);
    const estPucker = clamp((0.78 - lipWidth) / 0.28, 0, 1);
    const estSpread = clamp((lipWidth - 0.72) / 0.25, 0, 1);
    bs.jawOpen = r4(estJawOpen);
    bs.mouthPucker = r4(estPucker);
    bs.mouthFunnel = r4(estPucker * 0.7);
    bs.mouthSmileLeft = r4(estSpread);
    bs.mouthSmileRight = r4(estSpread);
    bs.mouthStretchLeft = r4(estSpread * 0.8);
    bs.mouthStretchRight = r4(estSpread * 0.8);
    bs.mouthClose = r4(Math.max(0, 1 - estJawOpen * 3));
  }
  const g = (k: string) => bs[k] ?? 0;

  const rounding = r4(Math.min(1, Math.max(g('mouthPucker'), 0.7 * g('mouthPucker') + 0.3 * g('mouthFunnel'))));
  const spread = r4(
    Math.min(1, 0.25 * (g('mouthSmileLeft') + g('mouthSmileRight') + g('mouthStretchLeft') + g('mouthStretchRight'))),
  );
  const openness = r4(
    clamp(0.7 * g('jawOpen') + 0.15 * (g('mouthLowerDownLeft') + g('mouthLowerDownRight')) - 0.3 * g('mouthClose'), 0, 1),
  );

  return {
    t, ok: true, flags: [],
    lipOpening, outerLipHeight, lipWidth, lipAspectRatio, lipProtrusionZ,
    jawDrop, mouthSymmetry, innerMouthArea, rounding, spread, openness,
    yawDeg: pose.yaw, pitchDeg: pose.pitch, rollDeg: pose.roll,
  };
}
