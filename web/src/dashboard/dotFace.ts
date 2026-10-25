import { FRAME, createFaceCloud } from './faceCloud';
import { FACE_CANON, FACE_TRIS } from './faceTris';

/**
 * The MediaPipe card's learner face. `createDotFace` draws it as Ava's dot head at card scale (faceCloud.ts, WebGL
 * with Ava's point material); this file keeps the frame decoding and, when WebGL is unavailable, a 2D fallback.
 *
 * The 2D fallback: the learner's face mesh (lip.mesh v2, docs/telemetry.md) drawn as a stippled
 * dot cloud over MediaPipe's canonical tesselation, a small sibling of Ava's dot head (mouth-demo pointcloud.js).
 *
 * Sampling happens once, on the canonical model: dots gather where the form turns (nose, lip line and corners,
 * chin, jaw, brow ridge, eye contours) and on the shadow side, flat skin stays mostly open paper, and the mouth
 * opening is empty so an open mouth reads as a hole. They are spaced by dart throwing, and each keeps its triangle
 * and fixed barycentric weights. Every redraw places each dot on its triangle's current three landmarks and shades
 * it like the graph's clusters: lit from the upper left (smaller and lighter toward the light, larger and darker in
 * shadow), firmer when nearer the camera, thinning toward the face oval and the silhouette instead of stopping at
 * a mask edge, and skipped when its triangle faces away.
 *
 * Points are carried as Float32Array(478 * 3): x, y in 0..1 across the nose-centred square (y down), z in
 * inter-ocular units (smaller = nearer the camera), the same frame as the v2 and v3 payloads.
 */

export const FACE_POINTS = 478;
const NV = 468;
const NT = FACE_TRIS.length / 3;

export const OUTER_LIP = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
/** The two vertex rings between the outer and the inner lip line (upper and lower). */
const LIP_MID = [
  76, 184, 74, 73, 72, 11, 302, 303, 304, 408, 306, 62, 183, 42, 41, 38, 12, 268, 271, 272, 407, 292,
  77, 90, 180, 85, 16, 315, 404, 320, 307, 96, 89, 179, 86, 15, 316, 403, 319, 325,
];
/** Eye contours as closed loops (outer corner, upper lid, inner corner, lower lid). */
const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
const BROWS = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
/** Per eye: corners, lid midpoints (upper, lower), iris centre and its 4 ring points. */
const EYES = [
  { a: 33, b: 133, up: 159, lo: 145, iris: 468 },
  { a: 362, b: 263, up: 386, lo: 374, iris: 473 },
];

/** Canonical depth as FaceLandmarker reports it: about mid-face at 0, compressed (the replay generator uses the same). */
const CANON_Z_MID = FRAME.zMid;
const CANON_Z_GAIN = FRAME.zGain;
/** Iris radius as a share of the eye's width, when the frame has no iris points (468-point frames, the idle pose). */
const IRIS_R = 0.19;
/** Mid-tone dots around each iris (the gaze). */
const IRIS_DOTS = 7;
/** design px: the dots that suggest the lids */
const LID_R = 0.85;

// Sampling. Density follows form, not area: features and curvature gather dots, flat skin stays open paper.
const TARGET_DOTS = 1250;
const OVERSAMPLE = 4;
/** Dart-throwing spacing, a share of 1 / sqrt(density); tuned so the accepted count lands near TARGET_DOTS. */
const SPACING = 0.715;
const REGION = {
  /** the lip line (outer and inner rings) and the corners: mid tones, no filled mouth. floor = darkest tone allowed */
  lipCorner: { w: 1.4, dark: 0.04, floor: 1 },
  lipLine: { w: 0.85, dark: -0.16, floor: 1 },
  lip: { w: 0.5, dark: -0.06, floor: 1 },
  brow: { w: 1.3, dark: 0.14, floor: 0 },
  eye: { w: 1.8, dark: -0.1, floor: 1 },
  /** the eye opening: a few light dots, the white of the eye */
  sclera: { w: 0.18, dark: -0.6, floor: 0 },
  skin: { w: 0.3, dark: 0, floor: 0 },
};
/** Curvature (vertex normals disagreeing) gathers dots: nose, lip line, chin, jaw, brow ridge, eye contours. */
const CURVE = { weight: 3.4, rad: 0.42 };
/** Sparser toward the light, denser on the shadow side, as on the clusters (canonical pose). */
const SHADOW_DENSITY = { lit: 0.8, shadow: 1.35 };

// Shading (pointcloud.js LIGHT): shadowed dots larger and darker, lit dots smaller and lighter.
const LIGHT_SIZE = { shadow: 1.45, lit: 0.76 };
/** toward the light: upper left and toward the viewer (x right, y down, z away from the camera) */
const LIGHT = (() => {
  const v = [-0.45, -0.6, -0.75];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();
/** design px (the box is BOX x BOX) */
const DOT_R = 1.15;
/** nearer the camera (nose, chin, lips) a touch larger and firmer; the far sides recede toward the paper */
const DEPTH_SIZE = 0.3;
const TONE_DEPTH = 0.22;
/**
 * tone = f(TONE_BASE + TONE_LIT x lit - TONE_DARK x region + TONE_DEPTH x depth + jitter + TONE_RIM x edge),
 * cut at TONE_STEPS
 */
const TONE_BASE = -0.02;
const TONE_LIT = 0.98;
const TONE_DARK = 0.45;
const TONE_RIM = 0.45;
const TONE_STEPS = [0.3, 0.5, 0.72];
/**
 * Soft edge: dots thin out toward the face oval (mesh rings in from the boundary), the silhouette and any edge
 * the frame clamped, instead of stopping at a mask line. FADE_RINGS[k] is the share kept k rings in.
 */
const FADE_RINGS = [0.22, 0.46, 0.68, 0.86];
const SILHOUETTE = { from: 0.62, to: 0.98 };
/** Life, while live: a slow breath (scale) and a sub-pixel drift per dot, like the clusters' wobble. */
const BREATH = { amp: 0.01, period: 4 };
const DRIFT = 0.42;
/** the clusters' four tones */
const TONES = ['#203e68', '#3b5884', '#8fa5c3', '#c2cedd'];
const TONE_ALPHA = [0.94, 0.9, 1, 1];

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function halton(i: number, b: number) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Fills the 10 iris points from the eye contours: centre between the corners, a ring of IRIS_R x the eye width. */
function synthIris(P: Float32Array) {
  for (const e of EYES) {
    const cx = (P[3 * e.a] + P[3 * e.b]) / 2;
    const cy = (P[3 * e.a + 1] + P[3 * e.b + 1]) / 2;
    const cz = Math.min(P[3 * e.a + 2], P[3 * e.b + 2]);
    const r = IRIS_R * Math.hypot(P[3 * e.b] - P[3 * e.a], P[3 * e.b + 1] - P[3 * e.a + 1]);
    const ring = [
      [r, 0],
      [0, -r],
      [-r, 0],
      [0, r],
    ];
    P[3 * e.iris] = cx;
    P[3 * e.iris + 1] = cy;
    P[3 * e.iris + 2] = cz;
    for (let k = 0; k < 4; k++) {
      const o = 3 * (e.iris + 1 + k);
      P[o] = cx + ring[k][0];
      P[o + 1] = cy + ring[k][1];
      P[o + 2] = cz;
    }
  }
}

/** The canonical model normalised exactly like a v2 frame: the neutral face shown before the first frame. */
export function canonicalFace(): Float32Array {
  const C = FACE_CANON;
  const out = new Float32Array(FACE_POINTS * 3);
  const mid = (a: number, b: number) => [(C[3 * a] + C[3 * b]) / 2, (C[3 * a + 1] + C[3 * b + 1]) / 2];
  const e1 = mid(33, 133);
  const e2 = mid(362, 263);
  const iod = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]);
  const half = 1.6 * iod;
  for (let i = 0; i < NV; i++) {
    out[3 * i] = 0.5 + (C[3 * i] - C[3]) / (2 * half);
    out[3 * i + 1] = 0.5 - (C[3 * i + 1] - C[4]) / (2 * half);
    out[3 * i + 2] = (-(C[3 * i + 2] - CANON_Z_MID) / iod) * CANON_Z_GAIN;
  }
  synthIris(out);
  return out;
}

/** Decodes a v2 `pts` string (n records of x u16 LE, y u16 LE, z u8). Null when it is malformed. */
export function decodeFaceV2(b64: string, n: number): Float32Array | null {
  if (n !== 478 && n !== 468) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length < n * 5) return null;
  const out = new Float32Array(FACE_POINTS * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    out[3 * i] = (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8)) / 65535;
    out[3 * i + 1] = (bin.charCodeAt(o + 2) | (bin.charCodeAt(o + 3) << 8)) / 65535;
    out[3 * i + 2] = (bin.charCodeAt(o + 4) / 255) * 1.2 - 0.6;
  }
  if (n === 468) synthIris(out);
  return out;
}

/** Decodes a v3 `pts` string (n records of x u8, y u8, z u8; the live format). Null when it is malformed. */
export function decodeFaceV3(b64: string, n: number): Float32Array | null {
  if (n !== 478 && n !== 468) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length < n * 3) return null;
  const out = new Float32Array(FACE_POINTS * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    out[3 * i] = bin.charCodeAt(o) / 255;
    out[3 * i + 1] = bin.charCodeAt(o + 1) / 255;
    out[3 * i + 2] = (bin.charCodeAt(o + 2) / 255) * 1.2 - 0.6;
  }
  if (n === 468) synthIris(out);
  return out;
}

// ---------- sampling (once) ----------

interface Dots {
  count: number;
  tri: Uint16Array;
  w0: Float32Array;
  w1: Float32Array;
  w2: Float32Array;
  /** base size jitter */
  size: Float32Array;
  /** region tone: 1 darkest (lips) .. 0 skin, negative lighter (the eye whites) */
  dark: Float32Array;
  /** the darkest tone a dot may take (lip and eye dots stay mid tone: no dark mouth, no eye rings) */
  floor: Uint8Array;
  /** per-dot tone jitter */
  jit: Float32Array;
  /** 0..1: the dot is drawn while the local edge fade is above it, so edges thin out instead of cutting off */
  cut: Float32Array;
  /** drift phase */
  ph: Float32Array;
}

/** Per vertex, the share of dots kept by its distance (in mesh rings) from the face oval: FADE_RINGS, then 1. */
function ringFade(): Float32Array {
  const edges = new Map<number, number>();
  const key = (i: number, j: number) => (i < j ? i * NV + j : j * NV + i);
  for (let t = 0; t < NT; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(FACE_TRIS[3 * t + e], FACE_TRIS[3 * t + ((e + 1) % 3)]);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const adj: number[][] = Array.from({ length: NV }, () => []);
  const hop = new Int32Array(NV).fill(-1);
  let front: number[] = [];
  for (const [k, n] of edges) {
    const i = Math.floor(k / NV);
    const j = k % NV;
    adj[i].push(j);
    adj[j].push(i);
    if (n === 1) {
      for (const v of [i, j]) {
        if (hop[v] < 0) {
          hop[v] = 0;
          front.push(v);
        }
      }
    }
  }
  for (let h = 1; front.length && h < FADE_RINGS.length; h++) {
    const next: number[] = [];
    for (const v of front) {
      for (const u of adj[v]) {
        if (hop[u] < 0) {
          hop[u] = h;
          next.push(u);
        }
      }
    }
    front = next;
  }
  const out = new Float32Array(NV);
  for (let i = 0; i < NV; i++) out[i] = hop[i] < 0 ? 1 : FADE_RINGS[hop[i]];
  return out;
}

const RING_FADE = ringFade();
/** Mesh neighbours, for softening the dots next to a frame-clamped vertex. */
const NEIGH = (() => {
  const adj: number[][] = Array.from({ length: NV }, () => []);
  for (let t = 0; t < NT; t++) {
    for (let e = 0; e < 3; e++) {
      const i = FACE_TRIS[3 * t + e];
      const j = FACE_TRIS[3 * t + ((e + 1) % 3)];
      if (!adj[i].includes(j)) adj[i].push(j);
      if (!adj[j].includes(i)) adj[j].push(i);
    }
  }
  return adj;
})();

function sampleDots(): Dots {
  const C = FACE_CANON;
  const rand = mulberry(4787);
  const inSet = (list: number[]) => {
    const s = new Uint8Array(NV);
    for (const i of list) s[i] = 1;
    return s;
  };
  const inner = inSet(INNER_LIP);
  const outer = inSet(OUTER_LIP);
  const lipAll = inSet([...OUTER_LIP, ...INNER_LIP, ...LIP_MID]);
  const corner = inSet([61, 291, 78, 308, 62, 292, 76, 306, 146, 375, 185, 409]);
  const eyeR = inSet(EYE_R);
  const eyeL = inSet(EYE_L);
  const brow = inSet(BROWS);

  // Smooth canonical vertex normals, for the curvature term.
  const vn = new Float32Array(NV * 3);
  const area = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    const a = FACE_TRIS[3 * t];
    const b = FACE_TRIS[3 * t + 1];
    const c = FACE_TRIS[3 * t + 2];
    const ux = C[3 * b] - C[3 * a];
    const uy = C[3 * b + 1] - C[3 * a + 1];
    const uz = C[3 * b + 2] - C[3 * a + 2];
    const vx = C[3 * c] - C[3 * a];
    const vy = C[3 * c + 1] - C[3 * a + 1];
    const vz = C[3 * c + 2] - C[3 * a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area[t] = Math.hypot(nx, ny, nz) / 2;
    for (const i of [a, b, c]) {
      vn[3 * i] += nx;
      vn[3 * i + 1] += ny;
      vn[3 * i + 2] += nz;
    }
  }
  for (let i = 0; i < NV; i++) {
    const l = Math.hypot(vn[3 * i], vn[3 * i + 1], vn[3 * i + 2]) || 1;
    vn[3 * i] /= l;
    vn[3 * i + 1] /= l;
    vn[3 * i + 2] /= l;
  }
  const angle = (i: number, j: number) =>
    Math.acos(Math.min(1, Math.max(-1, vn[3 * i] * vn[3 * j] + vn[3 * i + 1] * vn[3 * j + 1] + vn[3 * i + 2] * vn[3 * j + 2])));

  // The canonical model is y up and z toward the viewer; the frame's LIGHT is y down and z away.
  const L = [LIGHT[0], -LIGHT[1], -LIGHT[2]];
  const litV = (i: number) => smooth(-0.2, 0.9, vn[3 * i] * L[0] + vn[3 * i + 1] * L[1] + vn[3 * i + 2] * L[2]);

  const weight = new Float32Array(NT);
  const dark = new Float32Array(NT);
  const floor = new Uint8Array(NT);
  let total = 0;
  for (let t = 0; t < NT; t++) {
    const a = FACE_TRIS[3 * t];
    const b = FACE_TRIS[3 * t + 1];
    const c = FACE_TRIS[3 * t + 2];
    let r = REGION.skin;
    if (inner[a] && inner[b] && inner[c]) {
      weight[t] = 0; // spans the mouth opening
      continue;
    }
    // The forehead and cheek triangles are large, so "touches a brow / eye vertex" would reach far up the
    // forehead: brows are the strip between the two brow rows, eyes the band that shares an edge with a lid.
    const onEye = eyeR[a] + eyeR[b] + eyeR[c] + eyeL[a] + eyeL[b] + eyeL[c];
    const onLine = outer[a] + outer[b] + outer[c] + inner[a] + inner[b] + inner[c];
    if ((eyeR[a] && eyeR[b] && eyeR[c]) || (eyeL[a] && eyeL[b] && eyeL[c])) r = REGION.sclera;
    else if (corner[a] + corner[b] + corner[c] >= 2) r = REGION.lipCorner;
    else if (onLine >= 2) r = REGION.lipLine;
    else if (lipAll[a] && lipAll[b] && lipAll[c]) r = REGION.lip;
    else if (brow[a] + brow[b] + brow[c] >= 2) r = REGION.brow;
    else if (onEye >= 2) r = REGION.eye;
    const spread = Math.max(angle(a, b), angle(b, c), angle(a, c));
    const sh = 1 - (litV(a) + litV(b) + litV(c)) / 3;
    const w =
      r.w *
      (1 + CURVE.weight * Math.min(1, spread / CURVE.rad)) *
      (SHADOW_DENSITY.lit + (SHADOW_DENSITY.shadow - SHADOW_DENSITY.lit) * sh);
    weight[t] = w;
    dark[t] = r.dark;
    floor[t] = r.floor;
    total += area[t] * w;
  }

  // Candidates at OVERSAMPLE x the density, then dart throwing (adaptive Poisson disk) on a hash grid.
  const density = TARGET_DOTS / total;
  const rBase = SPACING / Math.sqrt(density);
  const cand: number[] = []; // t, w0, w1, w2, x, y, z, rMin
  for (let t = 0; t < NT; t++) {
    if (!weight[t]) continue;
    const expected = area[t] * weight[t] * density * OVERSAMPLE;
    let n = Math.floor(expected);
    if (rand() < expected - n) n++;
    if (!n) continue;
    const a = FACE_TRIS[3 * t];
    const b = FACE_TRIS[3 * t + 1];
    const c = FACE_TRIS[3 * t + 2];
    const rMin = rBase / Math.sqrt(weight[t]);
    const rot1 = rand();
    const rot2 = rand();
    for (let k = 0; k < n; k++) {
      const s = Math.sqrt((halton(k + 1, 2) + rot1) % 1);
      const r2 = (halton(k + 1, 3) + rot2) % 1;
      const w0 = 1 - s;
      const w1 = s * (1 - r2);
      const w2 = s * r2;
      cand.push(
        t,
        w0,
        w1,
        w2,
        w0 * C[3 * a] + w1 * C[3 * b] + w2 * C[3 * c],
        w0 * C[3 * a + 1] + w1 * C[3 * b + 1] + w2 * C[3 * c + 1],
        w0 * C[3 * a + 2] + w1 * C[3 * b + 2] + w2 * C[3 * c + 2],
        rMin,
      );
    }
  }
  const STRIDE = 8;
  const nc = cand.length / STRIDE;
  const order = new Uint32Array(nc);
  for (let i = 0; i < nc; i++) order[i] = i;
  for (let i = nc - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const cell = rBase;
  const grid = new Map<number, number[]>();
  const hash = (gx: number, gy: number, gz: number) => ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) | 0;
  const keep: number[] = [];
  for (let oi = 0; oi < nc; oi++) {
    const i = order[oi] * STRIDE;
    const x = cand[i + 4];
    const y = cand[i + 5];
    const z = cand[i + 6];
    const rm = cand[i + 7];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let free = true;
    for (let gx = cx - 1; gx <= cx + 1 && free; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && free; gy++) {
        for (let gz = cz - 1; gz <= cz + 1 && free; gz++) {
          const list = grid.get(hash(gx, gy, gz));
          if (!list) continue;
          for (let q = 0; q < list.length; q += 4) {
            const dx = list[q] - x;
            const dy = list[q + 1] - y;
            const dz = list[q + 2] - z;
            const lim = 0.5 * (rm + list[q + 3]);
            if (dx * dx + dy * dy + dz * dz < lim * lim) {
              free = false;
              break;
            }
          }
        }
      }
    }
    if (!free) continue;
    const key = hash(cx, cy, cz);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(x, y, z, rm);
    keep.push(i);
  }
  const count = keep.length;
  const dots: Dots = {
    count,
    tri: new Uint16Array(count),
    w0: new Float32Array(count),
    w1: new Float32Array(count),
    w2: new Float32Array(count),
    size: new Float32Array(count),
    dark: new Float32Array(count),
    floor: new Uint8Array(count),
    jit: new Float32Array(count),
    cut: new Float32Array(count),
    ph: new Float32Array(count),
  };
  // Draw order by triangle keeps the per-dot reads local.
  keep.sort((p, q) => cand[p] - cand[q]);
  for (let d = 0; d < count; d++) {
    const i = keep[d];
    const t = cand[i];
    dots.tri[d] = t;
    dots.w0[d] = cand[i + 1];
    dots.w1[d] = cand[i + 2];
    dots.w2[d] = cand[i + 3];
    dots.size[d] = 0.84 + rand() * 0.32;
    dots.dark[d] = dark[t];
    dots.floor[d] = floor[t];
    dots.jit[d] = (rand() - 0.5) * 0.16;
    dots.cut[d] = rand();
    dots.ph[d] = rand() * Math.PI * 2;
  }
  return dots;
}

const DOTS = sampleDots();
/** Dots placed by the sampler (for the card and the report). */
export const FACE_DOT_COUNT = DOTS.count;

// ---------- drawing ----------

export interface DotFace {
  /**
   * Draws one frame. `P` is 478 x 3 (see the header); the context is in device px of a `px` square. `life` 0..1
   * scales the breath and the drift (0 = still: idle, or reduced motion), `t` is the time in seconds.
   */
  draw(c: CanvasRenderingContext2D, px: number, P: Float32Array, alpha: number, life?: number, t?: number): void;
  /** Releases the WebGL renderer (a later draw recreates it). */
  dispose(): void;
}

/**
 * `box` is the square's size in design px; `pad` keeps the head off the canvas edge. Draws Ava's dot head
 * (faceCloud.ts); falls back to the 2D stipple when WebGL is unavailable or its context is lost.
 */
export function createDotFace(box: number, pad: number): DotFace {
  const cloud = createFaceCloud(box, pad);
  let stipple: ReturnType<typeof createStippleFace> | null = null;
  return {
    draw(c, px, P, alpha, life = 0, t = 0) {
      if (cloud.draw(c, px, P, alpha, life, t)) return;
      stipple ??= createStippleFace(box, pad);
      stipple.draw(c, px, P, alpha, life, t);
    },
    dispose() {
      cloud.dispose();
    },
  };
}

/** The 2D fallback: `box` is the square's size in design px; `pad` keeps the dots off the canvas edge. */
function createStippleFace(box: number, pad: number): Pick<DotFace, 'draw'> {
  const sx = new Float32Array(FACE_POINTS);
  const sy = new Float32Array(FACE_POINTS);
  const clamped = new Uint8Array(NV);
  const vis = new Uint8Array(NT);
  const vn = new Float32Array(NV * 3);
  const lit = new Float32Array(NV);
  const fade = new Float32Array(NV);
  const span = box - 2 * pad;
  /** z is in inter-ocular units, x and y span 3.2 of them across the square */
  const zk = 1 / 3.2;

  return {
    draw(c, px, P, alpha, life = 0, t = 0) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, px, px);
      const k = px / box;
      c.setTransform(k, 0, 0, k, 0, 0);
      // A slow breath, scaled about the square's centre (the nose).
      const breath = 1 + life * BREATH.amp * Math.sin((t * 2 * Math.PI) / BREATH.period);
      const mid = box / 2;
      for (let i = 0; i < FACE_POINTS; i++) {
        sx[i] = mid + (pad + P[3 * i] * span - mid) * breath;
        sy[i] = mid + (pad + P[3 * i + 1] * span - mid) * breath;
      }
      // Points clamped to the square's edge (usually the top of the forehead) are not real positions.
      for (let i = 0; i < NV; i++) {
        const x = P[3 * i];
        const y = P[3 * i + 1];
        clamped[i] = x <= 0 || x >= 1 || y <= 0 || y >= 1 ? 1 : 0;
        fade[i] = RING_FADE[i];
      }
      // Next to a clamped point the cut is soft too: its neighbours thin like the oval.
      for (let i = 0; i < NV; i++) {
        if (!clamped[i]) continue;
        for (const j of NEIGH[i]) fade[j] = Math.min(fade[j], FADE_RINGS[1]);
      }
      // Facing, and smooth vertex normals from the current geometry. Only triangles facing the viewer feed the
      // normals: a vertex on the silhouette would otherwise borrow the far side's normal and darken its dots.
      vn.fill(0);
      for (let t = 0; t < NT; t++) {
        const a = FACE_TRIS[3 * t];
        const b = FACE_TRIS[3 * t + 1];
        const d = FACE_TRIS[3 * t + 2];
        const ux = P[3 * b] - P[3 * a];
        const uy = P[3 * b + 1] - P[3 * a + 1];
        const uz = (P[3 * b + 2] - P[3 * a + 2]) * zk;
        const vx = P[3 * d] - P[3 * a];
        const vy = P[3 * d + 1] - P[3 * a + 1];
        const vz = (P[3 * d + 2] - P[3 * a + 2]) * zk;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx; // twice the signed 2D area; negative = facing the viewer (y down)
        vis[t] = nz < -1e-7 && !clamped[a] && !clamped[b] && !clamped[d] ? 1 : 0;
        if (nz >= 0) continue;
        vn[3 * a] += nx;
        vn[3 * a + 1] += ny;
        vn[3 * a + 2] += nz;
        vn[3 * b] += nx;
        vn[3 * b + 1] += ny;
        vn[3 * b + 2] += nz;
        vn[3 * d] += nx;
        vn[3 * d + 1] += ny;
        vn[3 * d + 2] += nz;
      }
      for (let i = 0; i < NV; i++) {
        const nx = vn[3 * i];
        const ny = vn[3 * i + 1];
        const nz = vn[3 * i + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        const lam = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / l;
        lit[i] = smooth(-0.3, 0.9, lam);
        // The silhouette (normal turning sideways) thins like the oval.
        fade[i] *= 1 - smooth(SILHOUETTE.from, SILHOUETTE.to, 1 - Math.abs(nz) / l);
      }

      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const { tri, w0, w1, w2, size, dark, floor, jit, cut, ph } = DOTS;
      const drift = life * DRIFT;
      for (let d = 0; d < DOTS.count; d++) {
        const t3 = tri[d];
        if (!vis[t3]) continue;
        const a = FACE_TRIS[3 * t3];
        const b = FACE_TRIS[3 * t3 + 1];
        const e = FACE_TRIS[3 * t3 + 2];
        const p = w0[d];
        const q = w1[d];
        const r = w2[d];
        const f = p * fade[a] + q * fade[b] + r * fade[e];
        if (cut[d] >= f) continue;
        let x = p * sx[a] + q * sx[b] + r * sx[e];
        let y = p * sy[a] + q * sy[b] + r * sy[e];
        if (drift) {
          x += drift * Math.sin(t * 0.8 + ph[d]);
          y += drift * Math.cos(t * 0.67 + ph[d] * 1.3);
        }
        const z = Math.min(0.6, Math.max(-0.6, p * P[3 * a + 2] + q * P[3 * b + 2] + r * P[3 * e + 2]));
        const l = p * lit[a] + q * lit[b] + r * lit[e];
        const dk = dark[d];
        const near = 1 - DEPTH_SIZE * z;
        // Toward the edge the surviving dots are also lighter and a little smaller, so the face dissolves.
        const edge = 1 - Math.min(1, f);
        const s =
          DOT_R * size[d] * (LIGHT_SIZE.shadow + (LIGHT_SIZE.lit - LIGHT_SIZE.shadow) * l) * (1 + 0.15 * Math.max(0, dk)) * near * (1 - 0.25 * edge);
        const lum = TONE_BASE + TONE_LIT * l - TONE_DARK * dk + TONE_DEPTH * z + jit[d] + TONE_RIM * edge;
        const tone = Math.max(floor[d], lum < TONE_STEPS[0] ? 0 : lum < TONE_STEPS[1] ? 1 : lum < TONE_STEPS[2] ? 2 : 3);
        const path = paths[tone];
        path.moveTo(x + s, y);
        path.arc(x, y, s, 0, Math.PI * 2);
      }

      // Eye contours, only suggested: a light dot on each upper-lid point and a few fainter ones along the lower lid.
      for (const loop of [EYE_R, EYE_L]) {
        if (clamped[loop[0]] || clamped[loop[8]]) continue;
        for (let j = 1; j < 16; j++) {
          if (j === 8 || (j > 8 && j % 2)) continue;
          const i = loop[j];
          const upper = j < 8;
          const s = upper ? LID_R : LID_R * 0.8;
          const path = paths[upper ? 2 : 3];
          path.moveTo(sx[i] + s, sy[i]);
          path.arc(sx[i], sy[i], s, 0, Math.PI * 2);
        }
      }

      // Gaze: a few mid-tone dots around each iris and a small pupil, only while the lids are apart.
      for (const eye of EYES) {
        const w = Math.hypot(sx[eye.b] - sx[eye.a], sy[eye.b] - sy[eye.a]);
        const ox = sx[eye.lo] - sx[eye.up];
        const oy = sy[eye.lo] - sy[eye.up];
        const h = Math.hypot(ox, oy);
        if (w < 4 || h < 0.14 * w) continue;
        const ux = ox / h;
        const uy = oy / h;
        const cx = sx[eye.iris];
        const cy = sy[eye.iris];
        let rr = 0;
        for (let j = 1; j <= 4; j++) rr += Math.hypot(sx[eye.iris + j] - cx, sy[eye.iris + j] - cy);
        rr = Math.min(0.26 * w, Math.max(0.12 * w, rr / 4));
        for (let j = 0; j < IRIS_DOTS; j++) {
          const th = ((j + 0.5) / IRIS_DOTS) * Math.PI * 2;
          const x = cx + rr * Math.cos(th);
          const y = cy + rr * Math.sin(th);
          const along = (x - sx[eye.up]) * ux + (y - sy[eye.up]) * uy;
          if (along < 0.8 || along > h - 0.8) continue;
          paths[1].moveTo(x + 0.85, y);
          paths[1].arc(x, y, 0.85, 0, Math.PI * 2);
        }
        const pr = Math.min(0.3 * rr, 0.36 * h, 1.5);
        paths[0].moveTo(cx + pr, cy);
        paths[0].arc(cx, cy, pr, 0, Math.PI * 2);
      }

      for (let t4 = 0; t4 < 4; t4++) {
        c.globalAlpha = alpha * TONE_ALPHA[t4];
        c.fillStyle = TONES[t4];
        c.fill(paths[t4]);
      }
      c.globalAlpha = 1;
    },
  };
}
