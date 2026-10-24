import type {
  TargetId,
  VisionKeyframe,
  VisionMetrics,
} from "../../../packages/contracts/generated";

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface VisionOverlay {
  outerLip: Point3D[];
  innerLip: Point3D[];
  corners: [Point3D, Point3D] | null;
  vertical: [Point3D, Point3D] | null;
  faceBox: { x: number; y: number; w: number; h: number } | null;
}

export const OUTER_LIP_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37,
  39, 40, 185,
];

export const INNER_LIP_INDICES = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82,
  81, 80, 191,
];

export const ORAL_BLENDSHAPE_NAMES = [
  "jawOpen",
  "jawForward",
  "jawLeft",
  "jawRight",
  "mouthPucker",
  "mouthFunnel",
  "mouthClose",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthRollUpper",
  "mouthRollLower",
  "mouthShrugUpper",
  "mouthShrugLower",
  "cheekPuff",
] as const;

function dist2D(a: Point3D, b: Point3D, aspect = 1): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function shoelaceArea(pts: Point3D[], aspect = 1): number {
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * aspect * pts[j].y - pts[j].x * aspect * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function extractEulerAngles(matrix?: number[] | Float32Array): {
  pitch_deg: number;
  yaw_deg: number;
  roll_deg: number;
} | null {
  if (!matrix || matrix.length < 16) return null;
  // Column-major 4x4 matrix M: R_02 = M[8], R_12 = M[9], R_22 = M[10], R_10 = M[1], R_11 = M[5]
  const r02 = matrix[8],
    r12 = matrix[9],
    r22 = matrix[10],
    r10 = matrix[1],
    r11 = matrix[5];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12))) * (180 / Math.PI);
  const yaw = Math.atan2(r02, r22) * (180 / Math.PI);
  const roll = Math.atan2(r10, r11) * (180 / Math.PI);
  return {
    pitch_deg: Number(pitch.toFixed(2)),
    yaw_deg: Number(yaw.toFixed(2)),
    roll_deg: Number(roll.toFixed(2)),
  };
}

/**
 * Pure geometric + blendshape + head-pose feature extractor from MediaPipe FaceLandmarker result.
 */
export function computeVisionTelemetry(
  landmarks: Point3D[] | undefined,
  blendshapeCategories: Array<{ categoryName: string; score: number }> | undefined,
  matrix: number[] | Float32Array | undefined,
  timestampMs: number,
  aspect = 4 / 3,
): { metrics: VisionMetrics; overlay: VisionOverlay } {
  const emptyOverlay: VisionOverlay = {
    outerLip: [],
    innerLip: [],
    corners: null,
    vertical: null,
    faceBox: null,
  };
  if (!landmarks || landmarks.length < 468) {
    return {
      metrics: {
        timestamp_ms: Math.max(0, Math.round(timestampMs)),
        valid: false,
        quality_flags: ["missing_face"],
        lip_opening: null,
      },
      overlay: emptyOverlay,
    };
  }

  // Rigid upper-face Inter-Ocular Distance (IOD)
  const leftEyeCenter: Point3D = {
    x: (landmarks[33].x + landmarks[133].x) / 2,
    y: (landmarks[33].y + landmarks[133].y) / 2,
    z: (landmarks[33].z + landmarks[133].z) / 2,
  };
  const rightEyeCenter: Point3D = {
    x: (landmarks[263].x + landmarks[362].x) / 2,
    y: (landmarks[263].y + landmarks[362].y) / 2,
    z: (landmarks[263].z + landmarks[362].z) / 2,
  };
  const iod = dist2D(leftEyeCenter, rightEyeCenter, aspect);

  const flags: string[] = [];
  if (iod < 0.04) flags.push("face_too_far");

  const p0 = landmarks[0],
    p17 = landmarks[17],
    p13 = landmarks[13],
    p14 = landmarks[14],
    p61 = landmarks[61],
    p291 = landmarks[291],
    p2 = landmarks[2],
    p152 = landmarks[152];

  if (
    [p0, p17, p61, p291].some(
      (p) => p.x < 0.02 || p.x > 0.98 || p.y < 0.02 || p.y > 0.98,
    )
  ) {
    flags.push("face_clipped");
  }

  // Head pose from 4x4 matrix or landmark geometry fallback
  const pose = extractEulerAngles(matrix) ?? {
    pitch_deg: Number(
      (((p2.y - (leftEyeCenter.y + rightEyeCenter.y) / 2) / Math.max(0.01, iod) - 0.6) * 45).toFixed(2),
    ),
    yaw_deg: Number(
      (((p2.x - (leftEyeCenter.x + rightEyeCenter.x) / 2) / Math.max(0.01, iod)) * 65).toFixed(2),
    ),
    roll_deg: Number(
      (
        Math.atan2(
          rightEyeCenter.y - leftEyeCenter.y,
          (rightEyeCenter.x - leftEyeCenter.x) * aspect,
        ) *
        (180 / Math.PI)
      ).toFixed(2),
    ),
  };

  if (Math.abs(pose.yaw_deg) > 25 || Math.abs(pose.pitch_deg) > 20) {
    flags.push("camera_angle_extreme");
  }

  const outerLip = OUTER_LIP_INDICES.map((i) => landmarks[i]);
  const innerLip = INNER_LIP_INDICES.map((i) => landmarks[i]);

  // Lower-face crop box (around nose subnasale 2, chin 152, cheeks 234 & 454)
  const minX = Math.max(0, Math.min(p61.x, p291.x) - iod * 0.45);
  const maxX = Math.min(1, Math.max(p61.x, p291.x) + iod * 0.45);
  const minY = Math.max(0, p2.y - iod * 0.25);
  const maxY = Math.min(1, p152.y + iod * 0.2);

  const overlay: VisionOverlay = {
    outerLip,
    innerLip,
    corners: [p61, p291],
    vertical: [p13, p14],
    faceBox: { x: minX, y: minY, w: Math.max(0.1, maxX - minX), h: Math.max(0.1, maxY - minY) },
  };

  if (flags.length > 0) {
    return {
      metrics: {
        timestamp_ms: Math.max(0, Math.round(timestampMs)),
        valid: false,
        quality_flags: flags,
        lip_opening: null,
        pitch_deg: pose.pitch_deg,
        yaw_deg: pose.yaw_deg,
        roll_deg: pose.roll_deg,
      },
      overlay,
    };
  }

  const safeIod = Math.max(0.02, iod);
  const yawCos = Math.max(0.85, Math.cos((pose.yaw_deg * Math.PI) / 180));
  const rawInnerH = dist2D(p13, p14, aspect);
  const rawOuterH = dist2D(p0, p17, aspect);
  const rawWidth = dist2D(p61, p291, aspect);

  const lipOpening = Math.min(2, Number((rawInnerH / safeIod).toFixed(4)));
  const outerLipHeight = Math.min(2, Number((rawOuterH / safeIod).toFixed(4)));
  const vermilionFlare = Math.max(
    0,
    Math.min(2, Number((outerLipHeight - lipOpening).toFixed(4))),
  );
  const lipWidth = Math.min(3, Number((rawWidth / (safeIod * yawCos)).toFixed(4)));
  const lipAspectRatio = Math.min(
    3,
    Number((rawInnerH / Math.max(0.005, rawWidth)).toFixed(4)),
  );

  // 3D forward protrusion: corners Z minus center lips Z (MediaPipe Z is negative toward camera)
  const centerZ = (p0.z + p13.z + p14.z + p17.z) / 4;
  const cornerZ = (p61.z + p291.z) / 2;
  const lipProtrusionZ = Math.max(
    -1,
    Math.min(1, Number(((cornerZ - centerZ) / safeIod).toFixed(4))),
  );

  const jawDrop = Math.min(3, Number((dist2D(p2, p152, aspect) / safeIod).toFixed(4)));
  const mouthSymmetry = Math.min(
    1,
    Number((Math.abs(p61.y - p291.y) / safeIod).toFixed(4)),
  );
  const innerMouthArea = Math.min(
    2,
    Number((shoelaceArea(innerLip, aspect) / (safeIod * safeIod)).toFixed(4)),
  );

  // Extract oral/mandibular blendshapes (or synthesize geometrically if blendshapes absent)
  const bs: Record<string, number> = {};
  if (blendshapeCategories && blendshapeCategories.length > 0) {
    const allowed = new Set<string>(ORAL_BLENDSHAPE_NAMES);
    for (const c of blendshapeCategories) {
      if (allowed.has(c.categoryName)) {
        bs[c.categoryName] = Number(Math.max(0, Math.min(1, c.score)).toFixed(4));
      }
    }
  } else {
    // Geometric estimation fallback when blendshapes are not emitted by model
    const estJawOpen = Math.max(0, Math.min(1, (lipOpening - 0.08) / 0.5));
    const estPucker = Math.max(0, Math.min(1, (0.78 - lipWidth) / 0.28));
    const estSpread = Math.max(0, Math.min(1, (lipWidth - 0.72) / 0.25));
    bs.jawOpen = Number(estJawOpen.toFixed(4));
    bs.mouthPucker = Number(estPucker.toFixed(4));
    bs.mouthFunnel = Number((estPucker * 0.7).toFixed(4));
    bs.mouthSmileLeft = Number(estSpread.toFixed(4));
    bs.mouthSmileRight = Number(estSpread.toFixed(4));
    bs.mouthStretchLeft = Number((estSpread * 0.8).toFixed(4));
    bs.mouthStretchRight = Number((estSpread * 0.8).toFixed(4));
    bs.mouthClose = Number(Math.max(0, 1 - estJawOpen * 3).toFixed(4));
  }

  const pucker = bs.mouthPucker ?? 0;
  const funnel = bs.mouthFunnel ?? 0;
  const smileL = bs.mouthSmileLeft ?? 0;
  const smileR = bs.mouthSmileRight ?? 0;
  const stretchL = bs.mouthStretchLeft ?? 0;
  const stretchR = bs.mouthStretchRight ?? 0;
  const jawOpen = bs.jawOpen ?? 0;
  const lowerDownL = bs.mouthLowerDownLeft ?? 0;
  const lowerDownR = bs.mouthLowerDownRight ?? 0;
  const mouthClose = bs.mouthClose ?? 0;

  const roundingScore = Number(
    Math.min(1, Math.max(pucker, 0.7 * pucker + 0.3 * funnel)).toFixed(4),
  );
  const spreadScore = Number(
    Math.min(1, 0.25 * (smileL + smileR + stretchL + stretchR)).toFixed(4),
  );
  const opennessScore = Number(
    Math.max(
      0,
      Math.min(1, 0.7 * jawOpen + 0.15 * (lowerDownL + lowerDownR) - 0.3 * mouthClose),
    ).toFixed(4),
  );

  return {
    metrics: {
      timestamp_ms: Math.max(0, Math.round(timestampMs)),
      valid: true,
      quality_flags: [],
      lip_opening: lipOpening,
      outer_lip_height: outerLipHeight,
      vermilion_flare: vermilionFlare,
      lip_width: lipWidth,
      lip_aspect_ratio: lipAspectRatio,
      lip_protrusion_z: lipProtrusionZ,
      jaw_drop: jawDrop,
      mouth_symmetry: mouthSymmetry,
      inner_mouth_area: innerMouthArea,
      rounding_score: roundingScore,
      spread_score: spreadScore,
      openness_score: opennessScore,
      blendshapes: bs,
      pitch_deg: pose.pitch_deg,
      yaw_deg: pose.yaw_deg,
      roll_deg: pose.roll_deg,
    },
    overlay,
  };
}

/**
 * Generates realistic synthetic 478-point landmarks + 22 blendshapes for a target vowel
 * so the CV pipeline and keyframe capture can be exercised even without a physical webcam.
 */
export function generateSyntheticVision(
  targetId: TargetId,
  index: number,
  timestampMs: number,
): { metrics: VisionMetrics; overlay: VisionOverlay } {
  const wobble = 0.015 * Math.sin(index / 5);
  let open = 0.14 + wobble,
    width = 0.88 + wobble,
    protrude = -0.03,
    jaw = 0.94,
    pucker = 0.05,
    funnel = 0.04,
    smile = 0.54,
    stretch = 0.45,
    jawOpen = 0.12;

  if (targetId === "u") {
    open = 0.14 + wobble;
    width = 0.55 - wobble;
    protrude = 0.18;
    jaw = 0.92;
    pucker = 0.8;
    funnel = 0.54;
    smile = 0.04;
    stretch = 0.04;
    jawOpen = 0.14;
  } else if (targetId === "aa") {
    open = 0.48 + wobble;
    width = 0.74;
    protrude = 0.02;
    jaw = 1.32;
    pucker = 0.06;
    funnel = 0.08;
    smile = 0.12;
    stretch = 0.1;
    jawOpen = 0.68;
  }

  const cx = 0.5,
    cy = 0.58;
  const rx = width * 0.22,
    ryIn = Math.max(0.015, open * 0.22),
    ryOut = ryIn + 0.035;

  const outerLip: Point3D[] = OUTER_LIP_INDICES.map((_, i) => {
    const theta = (i / OUTER_LIP_INDICES.length) * Math.PI * 2;
    return {
      x: cx - Math.cos(theta) * rx,
      y: cy + Math.sin(theta) * ryOut,
      z: -protrude * 0.1,
    };
  });
  const innerLip: Point3D[] = INNER_LIP_INDICES.map((_, i) => {
    const theta = (i / INNER_LIP_INDICES.length) * Math.PI * 2;
    return {
      x: cx - Math.cos(theta) * (rx * 0.82),
      y: cy + Math.sin(theta) * ryIn,
      z: -protrude * 0.08,
    };
  });

  const outerLipHeight = Number((open + 0.14).toFixed(4));
  const roundingScore = Number(Math.max(pucker, 0.7 * pucker + 0.3 * funnel).toFixed(4));
  const spreadScore = Number((0.5 * (smile + stretch)).toFixed(4));
  const opennessScore = Number(Math.min(1, 0.7 * jawOpen + 0.1).toFixed(4));

  return {
    metrics: {
      timestamp_ms: Math.max(0, Math.round(timestampMs)),
      valid: true,
      quality_flags: [],
      lip_opening: Number(open.toFixed(4)),
      outer_lip_height: outerLipHeight,
      vermilion_flare: 0.14,
      lip_width: Number(width.toFixed(4)),
      lip_aspect_ratio: Number((open / width).toFixed(4)),
      lip_protrusion_z: protrude,
      jaw_drop: jaw,
      mouth_symmetry: 0.015,
      inner_mouth_area: Number((open * width * 0.75).toFixed(4)),
      rounding_score: roundingScore,
      spread_score: spreadScore,
      openness_score: opennessScore,
      blendshapes: {
        jawOpen,
        jawForward: 0.04,
        jawLeft: 0,
        jawRight: 0,
        mouthPucker: pucker,
        mouthFunnel: funnel,
        mouthClose: 0.03,
        mouthSmileLeft: smile,
        mouthSmileRight: smile,
        mouthStretchLeft: stretch,
        mouthStretchRight: stretch,
        mouthDimpleLeft: Number((smile * 0.3).toFixed(4)),
        mouthDimpleRight: Number((smile * 0.3).toFixed(4)),
        mouthUpperUpLeft: 0.08,
        mouthUpperUpRight: 0.08,
        mouthLowerDownLeft: Number((jawOpen * 0.4).toFixed(4)),
        mouthLowerDownRight: Number((jawOpen * 0.4).toFixed(4)),
        mouthPressLeft: 0.02,
        mouthPressRight: 0.02,
        mouthRollUpper: 0.02,
        mouthRollLower: 0.02,
        mouthShrugUpper: Number((funnel * 0.3).toFixed(4)),
        mouthShrugLower: Number((funnel * 0.2).toFixed(4)),
        cheekPuff: 0.01,
      },
      pitch_deg: 1.2,
      yaw_deg: -0.8,
      roll_deg: 0.4,
    },
    overlay: {
      outerLip,
      innerLip,
      corners: [
        { x: cx - rx, y: cy, z: 0 },
        { x: cx + rx, y: cy, z: 0 },
      ],
      vertical: [
        { x: cx, y: cy - ryIn, z: 0 },
        { x: cx, y: cy + ryIn, z: 0 },
      ],
      faceBox: { x: 0.22, y: 0.34, w: 0.56, h: 0.48 },
    },
  };
}

/**
 * Maintains the 3 strategic keyframe screenshots (onset, peak_nucleus, sustained_hold)
 * cropped around the mouth region during an active attempt.
 */
export class KeyframeCollector {
  private onset: VisionKeyframe | null = null;
  private peak: { score: number; kf: VisionKeyframe } | null = null;
  private hold: VisionKeyframe | null = null;
  private cropCanvas: HTMLCanvasElement;

  constructor() {
    this.cropCanvas = document.createElement("canvas");
    this.cropCanvas.width = 256;
    this.cropCanvas.height = 256;
  }

  reset() {
    this.onset = null;
    this.peak = null;
    this.hold = null;
  }

  capture(
    sourceCanvasOrVideo: HTMLVideoElement | HTMLCanvasElement,
    metrics: VisionMetrics,
    overlay: VisionOverlay,
  ) {
    if (!metrics.valid) return;
    const excursion =
      (metrics.rounding_score ?? 0) +
      (metrics.spread_score ?? 0) +
      (metrics.openness_score ?? 0) +
      (metrics.lip_opening ?? 0);

    const needsOnset = !this.onset;
    const needsPeak = !this.peak || excursion > this.peak.score;
    const needsHold = metrics.timestamp_ms >= 240;

    if (!needsOnset && !needsPeak && !needsHold) return;

    const dataBase64 = this.cropToBase64(sourceCanvasOrVideo, overlay, metrics);
    if (!dataBase64) return;

    if (needsOnset) {
      this.onset = {
        label: "onset",
        timestamp_ms: metrics.timestamp_ms,
        mime_type: "image/jpeg",
        data_base64: dataBase64,
        metrics,
      };
    }
    if (needsPeak) {
      this.peak = {
        score: excursion,
        kf: {
          label: "peak_nucleus",
          timestamp_ms: metrics.timestamp_ms,
          mime_type: "image/jpeg",
          data_base64: dataBase64,
          metrics,
        },
      };
    }
    if (needsHold) {
      this.hold = {
        label: "sustained_hold",
        timestamp_ms: metrics.timestamp_ms,
        mime_type: "image/jpeg",
        data_base64: dataBase64,
        metrics,
      };
    }
  }

  private cropToBase64(
    source: HTMLVideoElement | HTMLCanvasElement,
    overlay: VisionOverlay,
    metrics: VisionMetrics,
  ): string | null {
    const ctx = this.cropCanvas.getContext("2d");
    if (!ctx) return null;
    const sw =
      source instanceof HTMLVideoElement ? source.videoWidth || 320 : source.width;
    const sh =
      source instanceof HTMLVideoElement ? source.videoHeight || 240 : source.height;
    if (!sw || !sh) return null;

    const box = overlay.faceBox ?? { x: 0.2, y: 0.3, w: 0.6, h: 0.5 };
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = "#132620";
    ctx.fillRect(0, 0, 256, 256);
    try {
      ctx.drawImage(
        source,
        box.x * sw,
        box.y * sh,
        box.w * sw,
        box.h * sh,
        0,
        0,
        256,
        256,
      );
    } catch {
      // Fallback if video element is not yet decoded
    }
    // Annotate keyframe HUD footer with exact telemetry for multimodal agent clarity
    ctx.fillStyle = "rgba(19, 38, 32, 0.82)";
    ctx.fillRect(0, 218, 256, 38);
    ctx.fillStyle = "#dbe7e3";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(
      `t=${metrics.timestamp_ms}ms  open=${(metrics.lip_opening ?? 0).toFixed(2)}  width=${(metrics.lip_width ?? 0).toFixed(2)}`,
      8,
      233,
    );
    ctx.fillText(
      `round=${(metrics.rounding_score ?? 0).toFixed(2)}  spread=${(metrics.spread_score ?? 0).toFixed(2)}  jaw=${(metrics.jaw_drop ?? 0).toFixed(2)}`,
      8,
      248,
    );

    const dataUrl = this.cropCanvas.toDataURL("image/jpeg", 0.76);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  }

  getKeyframes(): VisionKeyframe[] {
    const out: VisionKeyframe[] = [];
    if (this.onset) out.push(this.onset);
    if (this.peak) out.push(this.peak.kf);
    if (this.hold) out.push(this.hold);
    return out;
  }
}
