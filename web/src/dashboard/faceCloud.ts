import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DOT, KIND, SIZE_MUL, createPointMaterial } from '@mouth-demo/src/pointcloud-material.js';
import { FACE_CANON, FACE_TRIS } from './faceTris';

/**
 * The MediaPipe card's learner head: Ava's dot head (mouth-demo pointcloud.js) at card scale, drawn with the same
 * point material (pointcloud-material.js: soft round sprites, size and shade by light and depth, rim swell, the navy
 * and halo tones, hair as a dark mass).
 *
 * Two surfaces, sampled once in the canonical model's space (metres) and placed every frame:
 * - the face: MediaPipe's canonical tesselation, area-weighted with Ava's curvature weighting and dart throwing.
 *   Each dot keeps its triangle and barycentric weights and follows the live landmarks.
 * - the rest of the head: an ellipsoid skull fitted to the canonical face (its upper oval, an anthropometric crown
 *   height and head length), minus the part the face covers, with a hair cap and a little hair volume. It follows
 *   the rigid head pose, fitted every frame (Horn's quaternion Procrustes with scale) from stable landmarks.
 *
 * Like Ava, an invisible depth prepass (the live face mesh and the skull hull) hides the far side. It renders with a
 * small WebGL renderer into a detached canvas that `draw` copies into the dashboard's 2D canvas.
 */

/** The v2 / v3 frame (dotFace.ts): x, y over a nose-centred square SPAN inter-oculars wide, z in inter-oculars, compressed by Z_GAIN about Z_MID (canonical cm). */
export const FRAME = { span: 3.2, zMid: 2.6, zGain: 0.75 } as const;

const NV = 468;
const NT = FACE_TRIS.length / 3;
/** canonical model units (cm) to metres */
const CM = 0.01;

/** Stable landmarks for the rigid head pose (eye corners, nose bridge, cheekbones) and their weights. */
const POSE_IDS = [33, 133, 362, 263, 6, 168, 197, 234, 454];
const POSE_W = [1, 1, 1, 1, 1, 1, 1, 0.5, 0.5];
/**
 * Eye contours (outer corner, upper lid, inner corner, lower lid): the triangles inside each are the eye, sampled as
 * Ava's eye class (KIND.eyes, SIZE_MUL.eyes, at her eye density relative to skin, 360,000 / 230,000).
 */
const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
const EYE_DENSITY = 360000 / 230000;
/**
 * Ava's eyeball texture, as her TEX rule reads it: darker texels get larger dots (TEX.dark) and more of them (tone
 * weight 1.4), lighter ones smaller (TEX.bright). Here the dark texels are a disc of the iris's radius (about 5.9 mm in
 * adults) around the live iris landmark, so the dots follow the gaze; `share` is the eye's mean darkness, for the
 * density.
 */
const IRIS = { radius: 0.0059, soft: 0.0015, dark: 1.5, bright: 0.65, tone: 1.4, share: 0.45, ids: [468, 473] };
/** The mouth opening (inner lip ring): its triangles are not surface. */
const INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

/**
 * The skull, in inter-oculars (IOD): crown height above the chin, head length from the glabella, its centre's height
 * above the eye line. Adult means are about 22.5 cm, 19.5 cm and 6.3 cm IOD.
 */
const HEAD = { crown: 3.55, length: 3.1, centreUp: 0.05 };
/** Ava's scalp rule (pointcloud.js SCALP): above a soft hairline the dots take the hair tone; metres. */
const SCALP = { drop: 0.004, temple: 0.042, templeX: [0.045, 0.072], nape: 0.11, soft: 0.011 };
/**
 * Hair: metres of volume outward, ramping in over `ramp` above the hairline, with per-dot jitter; denser than skin
 * (Ava's hair is layered cards, so it reads as one dark mass).
 */
const HAIR = { vol: 0.007, ramp: 0.025, jitter: 0.5, density: 1.7, size: 1.45 };
/**
 * The neck, an elliptic cylinder under the skull (metres; z about the skull centre), fading out over its lowest part
 * like Ava's BOTTOM_FADE: `below` is how far it runs under the chin.
 */
const NECK = { rx: 0.05, rz: 0.058, z: 0.012, below: 0.05, fade: 0.04 };
/** Ava's mouth weight (MOUTH_RADIUS_MUL x the anchor radius): a slight swell and halo near the mouth. */
const MOUTH_R = 0.048;

// Sampling, as pointcloud.js: candidates at OVERSAMPLE x the density, then dart throwing at SPACING / sqrt(density).
/** dots per m² of skull skin; the face (FACE_DENSITY, curvature) and the hair (HAIR.density) scale it. About 5,800 in all */
const DENSITY = 30000;
const OVERSAMPLE = 4;
const SPACING = 0.82;
const CURVATURE = { weight: 1.6, rad: 1.6 };
/** the face carries more dots than the skull, as on Ava (her skin is weighted by tone and curvature on a finer mesh) */
const FACE_DENSITY = 2.0;
/** radians from the face oval over which the skull's skin eases from the face's density to its own */
const SEAM = 0.35;
/** Ava's dot radius to spacing: DOT.radius x sqrt(her base density, 230,000 / m²). */
const RADIUS_K = DOT.radius * Math.sqrt(230000) * 0.65;

/** Ava's camera: 30° vertical field of view; the head fills the box less the dashboard's pad. */
const FOV = 30;
/** extra room around the head inside the pad, for turns and the breath */
const FRAME_MARGIN = 1.04;
/** Life while live: a slow breath (scale) and a drift per dot, a share of the dot radius. */
const BREATH = { amp: 0.006, period: 4 };
const DRIFT = 0.35;
/** inter-oculars: a frame whose depth spans less than this has none (the canonical depth stands in) */
const FLAT_Z = 0.05;
/** device px cap for the WebGL buffer (pixel ratio 2 at most) */
const MAX_DPR = 2;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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

// ---------- the canonical model, in metres ----------

const CAN = new Float64Array(NV * 3);
for (let i = 0; i < NV * 3; i++) CAN[i] = FACE_CANON[i] * CM;
const cx = (i: number) => CAN[3 * i];
const cy = (i: number) => CAN[3 * i + 1];
const cz = (i: number) => CAN[3 * i + 2];
/** inter-ocular distance (eye centres, in the image plane), as the frame measures it */
const IOD = Math.hypot((cx(362) + cx(263) - cx(33) - cx(133)) / 2, (cy(362) + cy(263) - cy(33) - cy(133)) / 2);

/** Frame point i (0..1 square, z in IOD) to canonical model metres. */
function frameToModel(P: Float32Array, i: number, out: Float64Array) {
  out[3 * i] = cx(1) + (P[3 * i] - 0.5) * FRAME.span * IOD;
  out[3 * i + 1] = cy(1) - (P[3 * i + 1] - 0.5) * FRAME.span * IOD;
  out[3 * i + 2] = FRAME.zMid * CM - (P[3 * i + 2] * IOD) / FRAME.zGain;
}

// ---------- the skull fitted to the face ----------

interface Head {
  /** ellipsoid centre (model metres) and semi-axes */
  c0: [number, number, number];
  a: number;
  b: number;
  c: number;
  /** the face oval as (azimuth, elevation) seen from c0, closed */
  loop: Float64Array;
}

function fitHead(): Head {
  // the face's open boundary (the oval), ordered into a loop
  const count = new Map<number, number>();
  const key = (i: number, j: number) => (i < j ? i * NV + j : j * NV + i);
  for (let t = 0; t < NT; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(FACE_TRIS[3 * t + e], FACE_TRIS[3 * t + ((e + 1) % 3)]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const nb = new Map<number, number[]>();
  for (const [k, n] of count) {
    if (n !== 1) continue;
    const i = Math.floor(k / NV);
    const j = k % NV;
    if (!nb.has(i)) nb.set(i, []);
    if (!nb.has(j)) nb.set(j, []);
    nb.get(i)!.push(j);
    nb.get(j)!.push(i);
  }
  const oval: number[] = [];
  const start = nb.keys().next().value as number;
  let prev = -1;
  let cur = start;
  do {
    oval.push(cur);
    const nx = nb.get(cur)!.find((v) => v !== prev)!;
    prev = cur;
    cur = nx;
  } while (cur !== start && oval.length <= nb.size);

  const eyeY = (cy(33) + cy(133) + cy(362) + cy(263)) / 4;
  const crownY = cy(152) + HEAD.crown * IOD;
  const halfLen = (HEAD.length * IOD) / 2;
  const c0: [number, number, number] = [0, eyeY + HEAD.centreUp * IOD, cz(168) - halfLen];
  // Least squares for (1/a², 1/b², 1/c²): the upper oval (from the nose tip up) on the surface, plus the crown and the
  // head length as priors.
  const rows: number[][] = [];
  for (const i of oval) {
    if (cy(i) < cy(1)) continue;
    const x = cx(i) - c0[0];
    const y = cy(i) - c0[1];
    const z = cz(i) - c0[2];
    rows.push([x * x, y * y, z * z, 1, 1]);
  }
  const wp = Math.sqrt(rows.length) * 0.6;
  rows.push([0, (crownY - c0[1]) ** 2, 0, 1, wp]);
  rows.push([0, 0, halfLen * halfLen, 1, wp]);
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const B = [0, 0, 0];
  for (const [p, q, r, rhs, w] of rows) {
    const v = [p, q, r];
    for (let m = 0; m < 3; m++) {
      B[m] += w * w * v[m] * rhs;
      for (let n = 0; n < 3; n++) A[3 * m + n] += w * w * v[m] * v[n];
    }
  }
  const det = (M: number[]) =>
    M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  const D = det(A);
  const sol = [0, 1, 2].map((col) => {
    const M = A.slice();
    for (let m = 0; m < 3; m++) M[3 * m + col] = B[m];
    return det(M) / D;
  });
  const axis = (u: number, fallback: number) => (u > 1e-6 ? 1 / Math.sqrt(u) : fallback);
  const a = axis(sol[0], 0.078);
  const b = axis(sol[1], crownY - c0[1]);
  const c = axis(sol[2], halfLen);

  const loop = new Float64Array(oval.length * 2);
  oval.forEach((i, k) => {
    const x = cx(i) - c0[0];
    const y = cy(i) - c0[1];
    const z = cz(i) - c0[2];
    loop[2 * k] = Math.atan2(x, z);
    loop[2 * k + 1] = Math.atan2(y, Math.hypot(x, z));
  });
  return { c0, a, b, c, loop };
}

/** Angular distance (radians) from a direction from the skull centre to the face oval. */
function faceDist(h: Head, x: number, y: number, z: number) {
  const el = Math.atan2(y, Math.hypot(x, z));
  const k = Math.cos(el);
  const az = Math.atan2(x, z) * k;
  const L = h.loop;
  const n = L.length / 2;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = L[2 * j] * k;
    const ay = L[2 * j + 1];
    const ux = L[2 * i] * k - ax;
    const uy = L[2 * i + 1] - ay;
    const q = Math.min(1, Math.max(0, ((az - ax) * ux + (el - ay) * uy) / (ux * ux + uy * uy || 1)));
    best = Math.min(best, Math.hypot(az - ax - q * ux, el - ay - q * uy));
  }
  return best;
}

/** Whether a direction from the skull centre passes through the face (its oval, in azimuth and elevation). */
function inFace(h: Head, x: number, y: number, z: number) {
  const az = Math.atan2(x, z);
  const el = Math.atan2(y, Math.hypot(x, z));
  const L = h.loop;
  const n = L.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ai = L[2 * i];
    const ei = L[2 * i + 1];
    const aj = L[2 * j];
    const ej = L[2 * j + 1];
    if (ei > el !== ej > el && az < ((aj - ai) * (el - ei)) / (ej - ei) + ai) inside = !inside;
  }
  return inside;
}

// ---------- sampling (once) ----------

interface Cloud {
  head: Head;
  count: number;
  /** dots [0, nFace) are on the face, the rest on the skull */
  nFace: number;
  /** face: triangle and barycentric weights */
  tri: Uint16Array;
  bary: Float32Array;
  /** skull: position relative to the skull centre and unit normal, model metres */
  home: Float32Array;
  hn: Float32Array;
  /** aInfo per dot: size multiplier, kind, mouth weight, alpha */
  info: Float32Array;
  /** eye dots: (dot index, eye 0 right | 1 left) pairs, sized every frame by the distance to the iris */
  eyeDots: Int32Array;
  /** drift phase */
  ph: Float32Array;
  /** world dot radius */
  radius: number;
  /** triangles of the face prepass (the mouth opening left out) */
  surface: Uint16Array;
  /** vertical extent of the head about the skull centre, metres */
  top: number;
  bottom: number;
}

function sampleCloud(): Cloud {
  const rand = mulberry(9157);
  const head = fitHead();
  const { c0, a, b, c } = head;
  const inner = new Uint8Array(NV);
  for (const i of INNER_LIP) inner[i] = 1;
  const eyeR = new Uint8Array(NV);
  const eyeL = new Uint8Array(NV);
  for (const i of EYE_R) eyeR[i] = 1;
  for (const i of EYE_L) eyeL[i] = 1;
  const mouth = [(cx(13) + cx(14)) / 2, (cy(13) + cy(14)) / 2, (cz(13) + cz(14)) / 2];
  const mouthW = (x: number, y: number, z: number) =>
    1 - smooth(MOUTH_R * 0.6, MOUTH_R, Math.hypot(x - mouth[0], y - mouth[1], (z - mouth[2]) * 0.5));

  // smooth canonical vertex normals, for the curvature factor
  const vn = new Float64Array(NV * 3);
  const area = new Float64Array(NT);
  const surface: number[] = [];
  for (let t = 0; t < NT; t++) {
    const i = FACE_TRIS[3 * t];
    const j = FACE_TRIS[3 * t + 1];
    const k = FACE_TRIS[3 * t + 2];
    const ux = cx(j) - cx(i);
    const uy = cy(j) - cy(i);
    const uz = cz(j) - cz(i);
    const vx = cx(k) - cx(i);
    const vy = cy(k) - cy(i);
    const vz = cz(k) - cz(i);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (inner[i] && inner[j] && inner[k]) continue; // the mouth opening
    surface.push(i, j, k);
    area[t] = Math.hypot(nx, ny, nz) / 2;
    for (const v of [i, j, k]) {
      vn[3 * v] += nx;
      vn[3 * v + 1] += ny;
      vn[3 * v + 2] += nz;
    }
  }
  for (let v = 0; v < NV; v++) {
    const l = Math.hypot(vn[3 * v], vn[3 * v + 1], vn[3 * v + 2]) || 1;
    vn[3 * v] /= l;
    vn[3 * v + 1] /= l;
    vn[3 * v + 2] /= l;
  }
  const angle = (i: number, j: number) =>
    Math.acos(Math.min(1, Math.max(-1, vn[3 * i] * vn[3 * j] + vn[3 * i + 1] * vn[3 * j + 1] + vn[3 * i + 2] * vn[3 * j + 2])));

  // face candidates: [tri, w0, w1, w2, x, y, z, rMin, eye, 0]; skull ones below
  const STRIDE = 10;
  const rBase = SPACING / Math.sqrt(DENSITY);
  const faceCand: number[] = [];
  for (let t = 0; t < NT; t++) {
    if (!area[t]) continue;
    const i = FACE_TRIS[3 * t];
    const j = FACE_TRIS[3 * t + 1];
    const k = FACE_TRIS[3 * t + 2];
    const spread = Math.max(angle(i, j), angle(j, k), angle(i, k));
    // 1: right eye (iris 468), 2: left eye (iris 473)
    const eye = eyeR[i] && eyeR[j] && eyeR[k] ? 1 : eyeL[i] && eyeL[j] && eyeL[k] ? 2 : 0;
    const factor = FACE_DENSITY * (eye ? EYE_DENSITY * (1 + IRIS.tone * IRIS.share) : 1 + CURVATURE.weight * Math.min(1, spread / CURVATURE.rad));
    const expected = area[t] * DENSITY * factor * OVERSAMPLE;
    let n = Math.floor(expected);
    if (rand() < expected - n) n++;
    const rMin = rBase / Math.sqrt(factor);
    const rot1 = rand();
    const rot2 = rand();
    for (let q = 0; q < n; q++) {
      const s = Math.sqrt((halton(q + 1, 2) + rot1) % 1);
      const r2 = (halton(q + 1, 3) + rot2) % 1;
      const w0 = 1 - s;
      const w1 = s * (1 - r2);
      const w2 = s * r2;
      faceCand.push(t, w0, w1, w2, w0 * cx(i) + w1 * cx(j) + w2 * cx(k), w0 * cy(i) + w1 * cy(j) + w2 * cy(k), w0 * cz(i) + w1 * cz(j) + w2 * cz(k), rMin, eye, 0);
    }
  }
  // the hairline (Ava's scalp cap): from just under the top of the face oval, dropping at the temples and the nape
  const hairY = cy(10) - SCALP.drop;
  const hairline = (x: number, z: number) =>
    hairY - SCALP.temple * smooth(SCALP.templeX[0], SCALP.templeX[1], Math.abs(x)) - SCALP.nape * (1 - smooth(c0[2] - 0.02, c0[2] + 0.03, z));
  // the neck, relative to the skull centre
  const neckZ = NECK.z;
  const neckLo = cy(152) - c0[1] - NECK.below;
  const inNeck = (x: number, z: number) => (x / NECK.rx) ** 2 + ((z - neckZ) / NECK.rz) ** 2 < 1;
  // skull candidates: [-1, nx, ny, nz, x, y, z, rMin, alpha, hair] (model metres)
  const skullCand: number[] = [];
  // Skin next to the face keeps the face's density, easing to the base density over SEAM, so the oval leaves no edge.
  // Candidates are made at the highest density and thinned to each spot's own.
  const dMax = Math.max(HAIR.density, FACE_DENSITY);
  const skinDensity = (x: number, y: number, z: number) => 1 + (FACE_DENSITY - 1) * (1 - smooth(0, SEAM, faceDist(head, x, y, z)));
  // the skull: uniform over the ellipsoid's area (sphere directions accepted by the area element), minus the face
  // and the neck's inside
  const ab = a * b;
  const ac = a * c;
  const bc = b * c;
  const p = 1.6;
  const ellArea = 4 * Math.PI * (((ab ** p + ac ** p + bc ** p) / 3) ** (1 / p));
  const gMax = Math.max(ab, ac, bc);
  const nSkull = Math.round(ellArea * DENSITY * dMax * OVERSAMPLE);
  for (let made = 0, guard = 0; made < nSkull && guard < nSkull * 8; guard++) {
    const u = 2 * rand() - 1;
    const phi = 2 * Math.PI * rand();
    const s = Math.sqrt(1 - u * u);
    const dx = s * Math.cos(phi);
    const dy = u;
    const dz = s * Math.sin(phi);
    if (rand() * gMax > Math.hypot(bc * dx, ac * dy, ab * dz)) continue;
    made++;
    const x = a * dx;
    const y = b * dy;
    const z = c * dz;
    if (inFace(head, x, y, z) || (y < 0 && inNeck(x, z))) continue;
    const y0 = hairline(x + c0[0], z + c0[2]) - c0[1];
    const hair = rand() < smooth(y0 - SCALP.soft, y0 + SCALP.soft, y);
    const dens = hair ? HAIR.density : skinDensity(x, y, z);
    if (rand() * dMax > dens) continue;
    let nx = dx / a;
    let ny = dy / b;
    let nz = dz / c;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    skullCand.push(-1, nx, ny, nz, x + c0[0], y + c0[1], z + c0[2], rBase / Math.sqrt(dens), 1, hair ? 1 : 0);
  }
  // the neck: uniform over the cylinder's side (angles accepted by the arc length), outside the skull and the face
  const neckH = -neckLo;
  const perim = Math.PI * (3 * (NECK.rx + NECK.rz) - Math.sqrt((3 * NECK.rx + NECK.rz) * (NECK.rx + 3 * NECK.rz)));
  const nNeck = Math.round(perim * neckH * DENSITY * dMax * OVERSAMPLE);
  const sMax = Math.max(NECK.rx, NECK.rz);
  for (let made = 0, guard = 0; made < nNeck && guard < nNeck * 8; guard++) {
    const th = 2 * Math.PI * rand();
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    if (rand() * sMax > Math.hypot(NECK.rx * sn, NECK.rz * cs)) continue;
    made++;
    const x = NECK.rx * cs;
    const z = neckZ + NECK.rz * sn;
    const y = neckLo * rand();
    if ((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2 < 1 || inFace(head, x, y, z)) continue;
    const alpha = smooth(neckLo, neckLo + NECK.fade, y);
    const dens = skinDensity(x, y, z);
    if (alpha < 0.02 || rand() * dMax > dens) continue;
    const nx = cs / NECK.rx;
    const nz = sn / NECK.rz;
    const l = Math.hypot(nx, nz);
    skullCand.push(-1, nx / l, 0, nz / l, x + c0[0], y + c0[1], z + c0[2], rBase / Math.sqrt(dens), alpha, 0);
  }

  // dart throwing on one hash grid (face first), so the seam is spaced like the rest
  const cell = rBase;
  const grid = new Map<number, number[]>();
  const hash = (gx: number, gy: number, gz: number) => ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) | 0;
  const throwDarts = (cand: number[]) => {
    const nc = cand.length / STRIDE;
    const order = new Uint32Array(nc);
    for (let i = 0; i < nc; i++) order[i] = i;
    for (let i = nc - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    const kept: number[] = [];
    for (let oi = 0; oi < nc; oi++) {
      const i = order[oi] * STRIDE;
      const x = cand[i + 4];
      const y = cand[i + 5];
      const z = cand[i + 6];
      const rm = cand[i + 7];
      const gx0 = Math.floor(x / cell);
      const gy0 = Math.floor(y / cell);
      const gz0 = Math.floor(z / cell);
      let free = true;
      for (let gx = gx0 - 1; gx <= gx0 + 1 && free; gx++) {
        for (let gy = gy0 - 1; gy <= gy0 + 1 && free; gy++) {
          for (let gz = gz0 - 1; gz <= gz0 + 1 && free; gz++) {
            const list = grid.get(hash(gx, gy, gz));
            if (!list) continue;
            for (let q = 0; q < list.length; q += 4) {
              const ddx = list[q] - x;
              const ddy = list[q + 1] - y;
              const ddz = list[q + 2] - z;
              const lim = 0.5 * (rm + list[q + 3]);
              if (ddx * ddx + ddy * ddy + ddz * ddz < lim * lim) {
                free = false;
                break;
              }
            }
          }
        }
      }
      if (!free) continue;
      const k = hash(gx0, gy0, gz0);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(x, y, z, rm);
      kept.push(i);
    }
    return kept;
  };
  const keptFace = throwDarts(faceCand).sort((i, j) => faceCand[i] - faceCand[j]);
  const keptSkull = throwDarts(skullCand);

  const nFace = keptFace.length;
  const count = nFace + keptSkull.length;
  const cloud: Cloud = {
    head,
    count,
    nFace,
    tri: new Uint16Array(nFace),
    bary: new Float32Array(nFace * 3),
    home: new Float32Array((count - nFace) * 3),
    hn: new Float32Array((count - nFace) * 3),
    info: new Float32Array(count * 4),
    ph: new Float32Array(count),
    radius: RADIUS_K / Math.sqrt(DENSITY),
    surface: Uint16Array.from(surface),
    top: b,
    bottom: neckLo + NECK.fade * 0.3,
    eyeDots: new Int32Array(0),
  };
  const eyeDots: number[] = [];
  for (let d = 0; d < nFace; d++) {
    const i = keptFace[d];
    cloud.tri[d] = faceCand[i];
    cloud.bary[3 * d] = faceCand[i + 1];
    cloud.bary[3 * d + 1] = faceCand[i + 2];
    cloud.bary[3 * d + 2] = faceCand[i + 3];
    const eye = faceCand[i + 8];
    cloud.info.set([eye ? SIZE_MUL.eyes : SIZE_MUL.full, eye ? KIND.eyes : KIND.head, mouthW(faceCand[i + 4], faceCand[i + 5], faceCand[i + 6]), 1], 4 * d);
    if (eye) eyeDots.push(d, eye - 1);
    cloud.ph[d] = rand() * Math.PI * 2;
  }
  cloud.eyeDots = Int32Array.from(eyeDots);
  for (let s = 0; s < keptSkull.length; s++) {
    const i = keptSkull[s];
    const d = nFace + s;
    const nx = skullCand[i + 1];
    const ny = skullCand[i + 2];
    const nz = skullCand[i + 3];
    let x = skullCand[i + 4];
    let y = skullCand[i + 5];
    let z = skullCand[i + 6];
    const hair = skullCand[i + 9] === 1;
    if (hair) {
      const y0 = hairline(x, z);
      const lift = HAIR.vol * smooth(y0, y0 + HAIR.ramp, y) * (1 - HAIR.jitter / 2 + HAIR.jitter * rand());
      x += nx * lift;
      y += ny * lift;
      z += nz * lift;
    }
    cloud.home.set([x - c0[0], y - c0[1], z - c0[2]], 3 * s);
    cloud.hn.set([nx, ny, nz], 3 * s);
    cloud.info.set(
      hair ? [SIZE_MUL.hair * HAIR.size, KIND.hair, 0, skullCand[i + 8]] : [SIZE_MUL.full, KIND.head, mouthW(x, y, z), skullCand[i + 8]],
      4 * d,
    );
    cloud.ph[d] = rand() * Math.PI * 2;
  }
  cloud.top = b + HAIR.vol;
  return cloud;
}

// ---------- rigid pose: Horn's quaternion method with scale ----------

/** Unit eigenvector of the largest eigenvalue of a symmetric 4x4 matrix (cyclic Jacobi). */
function maxEigvec4(M: Float64Array, out: Float64Array) {
  const A = Float64Array.from(M);
  const V = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[4 * p + q] * A[4 * p + q];
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = A[4 * p + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (A[4 * q + q] - A[4 * p + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = A[4 * k + p];
          const akq = A[4 * k + q];
          A[4 * k + p] = c * akp - s * akq;
          A[4 * k + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = A[4 * p + k];
          const aqk = A[4 * q + k];
          A[4 * p + k] = c * apk - s * aqk;
          A[4 * q + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[4 * k + p];
          const vkq = V[4 * k + q];
          V[4 * k + p] = c * vkp - s * vkq;
          V[4 * k + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let m = 0;
  for (let k = 1; k < 4; k++) if (A[5 * k] > A[5 * m]) m = k;
  for (let k = 0; k < 4; k++) out[k] = V[4 * k + m];
}

export interface Pose {
  /** live ≈ s R canonical + t (R row-major 3x3) */
  s: number;
  R: Float64Array;
  t: Float64Array;
}

/**
 * Similarity transform from the canonical model to `live` (both model metres, NV x 3) over the stable landmarks,
 * skipping those whose `bad` flag is set.
 */
export function fitPose(live: Float64Array, bad: Uint8Array | null, out: Pose) {
  let W = 0;
  const mx = [0, 0, 0];
  const my = [0, 0, 0];
  for (let k = 0; k < POSE_IDS.length; k++) {
    const i = POSE_IDS[k];
    const w = bad && bad[i] ? 0 : POSE_W[k];
    W += w;
    for (let e = 0; e < 3; e++) {
      mx[e] += w * CAN[3 * i + e];
      my[e] += w * live[3 * i + e];
    }
  }
  if (W < 3) {
    out.s = 1;
    out.R.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    out.t.set([0, 0, 0]);
    return;
  }
  for (let e = 0; e < 3; e++) {
    mx[e] /= W;
    my[e] /= W;
  }
  const S = new Float64Array(9); // S[a][b] = sum w x_a y_b
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < POSE_IDS.length; k++) {
    const i = POSE_IDS[k];
    const w = bad && bad[i] ? 0 : POSE_W[k];
    if (!w) continue;
    const x = [CAN[3 * i] - mx[0], CAN[3 * i + 1] - mx[1], CAN[3 * i + 2] - mx[2]];
    const y = [live[3 * i] - my[0], live[3 * i + 1] - my[1], live[3 * i + 2] - my[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[3 * a + b] += w * x[a] * y[b];
    sx += w * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
    sy += w * (y[0] * y[0] + y[1] * y[1] + y[2] * y[2]);
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = new Float64Array([
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ]);
  const q = new Float64Array(4);
  maxEigvec4(N, q);
  const [w, x, y, z] = q;
  const R = out.R;
  R[0] = w * w + x * x - y * y - z * z;
  R[1] = 2 * (x * y - w * z);
  R[2] = 2 * (x * z + w * y);
  R[3] = 2 * (x * y + w * z);
  R[4] = w * w - x * x + y * y - z * z;
  R[5] = 2 * (y * z - w * x);
  R[6] = 2 * (x * z - w * y);
  R[7] = 2 * (y * z + w * x);
  R[8] = w * w - x * x - y * y + z * z;
  out.s = Math.sqrt(sy / Math.max(1e-12, sx));
  for (let e = 0; e < 3; e++) out.t[e] = my[e] - out.s * (R[3 * e] * mx[0] + R[3 * e + 1] * mx[1] + R[3 * e + 2] * mx[2]);
}

// ---------- rendering ----------

interface GL {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  material: THREE.ShaderMaterial;
  posAttr: THREE.BufferAttribute;
  infoAttr: THREE.BufferAttribute;
  nrmAttr: THREE.BufferAttribute;
  facePos: THREE.BufferAttribute;
  hull: THREE.Mesh;
  disposables: { dispose(): void }[];
  lost: boolean;
  onLost: (e: Event) => void;
}

export interface FaceCloud {
  /**
   * Draws one frame into `c` (device px of a `px` square): `P` is 478 x 3 in the v2 / v3 frame, `alpha` the card's
   * fade, `life` 0..1 the breath and drift (0: still), `t` seconds. Returns false when WebGL is unavailable, so the
   * caller can draw its fallback.
   */
  draw(c: CanvasRenderingContext2D, px: number, P: Float32Array, alpha: number, life?: number, t?: number): boolean;
  /** Releases the WebGL renderer and its buffers (a later draw recreates them). */
  dispose(): void;
}

let CLOUD: Cloud | null = null;
/** Dot counts and the fitted skull (metres), for tests and reports; samples the cloud if it is not yet. */
export function faceCloudStats() {
  CLOUD ??= sampleCloud();
  const { count, nFace, head, radius, info } = CLOUD;
  let hair = 0;
  let eyes = 0;
  for (let d = 0; d < count; d++) {
    if (info[4 * d + 1] === KIND.hair) hair++;
    else if (info[4 * d + 1] === KIND.eyes) eyes++;
  }
  return { count, face: nFace, eyes, skull: count - nFace - hair, hair, radius, head: { c0: head.c0, a: head.a, b: head.b, c: head.c } };
}

/** `box` is the square's size in design px; `pad` keeps the head off the canvas edge. */
export function createFaceCloud(box: number, pad: number): FaceCloud {
  let gl: GL | null = null;
  let failures = 0;
  let retryAt = 0;
  const live = new Float64Array(NV * 3);
  const bad = new Uint8Array(NV);
  const pose: Pose = { s: 1, R: new Float64Array(9), t: new Float64Array(3) };
  const V = new Float32Array(NV * 3);
  const VN = new Float32Array(NV * 3);
  let renderPx = 0;
  const stats = { ms: 0, frames: 0 };

  function teardown(release = false) {
    if (!gl) return;
    gl.renderer.domElement.removeEventListener('webglcontextlost', gl.onLost);
    for (const d of gl.disposables) d.dispose();
    gl.renderer.dispose();
    // free the context now rather than at garbage collection (browsers cap live WebGL contexts)
    if (release) gl.renderer.forceContextLoss();
    gl = null;
  }

  function build(): GL | null {
    if (gl && !gl.lost) return gl;
    if (gl?.lost) teardown();
    if (failures >= 3 || performance.now() < retryAt || typeof document === 'undefined') return null;
    if (!CLOUD) {
      const t0 = performance.now();
      CLOUD = sampleCloud();
      console.info(`[faceCloud] ${CLOUD.count} dots (face ${CLOUD.nFace}) sampled in ${(performance.now() - t0).toFixed(0)} ms`);
    }
    const cl = CLOUD;
    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement('canvas');
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
    } catch {
      failures = 3;
      return null;
    }
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 5);
    // frame the head: crown to chin, as projected (the chin is nearer the camera), fills the box less the pad
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const fill = Math.max(0.5, 1 - (2 * pad) / box) / FRAME_MARGIN;
    const { c0 } = cl.head;
    let yc = (cl.top + cl.bottom) / 2;
    let dist = (cl.top - cl.bottom) / 2 / tan / fill;
    for (let it = 0; it < 6; it++) {
      let lo = (cl.bottom - yc) * (dist / (dist - NECK.z - NECK.rz));
      let hi = cl.top - yc;
      for (let i = 0; i < NV; i++) {
        const y = (cy(i) - c0[1] - yc) * (dist / (dist - (cz(i) - c0[2])));
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      yc += (lo + hi) / 2;
      dist *= (hi - lo) / 2 / (dist * tan * fill);
    }
    camera.position.set(0, yc, dist);
    camera.lookAt(0, yc, 0);
    camera.updateMatrixWorld();

    // the dots
    const n = cl.count;
    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const nrmAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    nrmAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aNormal', nrmAttr);
    const infoAttr = new THREE.BufferAttribute(cl.info, 4);
    geometry.setAttribute('aInfo', infoAttr);
    const fly = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) fly[4 * i + 3] = cl.ph[i] / (Math.PI * 2);
    geometry.setAttribute('aFly', new THREE.BufferAttribute(fly, 4));
    geometry.setAttribute('aShape', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const material = createPointMaterial({ radius: cl.radius });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 1;
    scene.add(points);

    // the depth prepass (pointcloud.js): the live face mesh and the skull hull hide the far side
    const prepass = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    const faceGeo = new THREE.BufferGeometry();
    const facePos = new THREE.BufferAttribute(new Float32Array(NV * 3), 3);
    facePos.setUsage(THREE.DynamicDrawUsage);
    faceGeo.setAttribute('position', facePos);
    faceGeo.setIndex(new THREE.BufferAttribute(cl.surface, 1));
    const faceMesh = new THREE.Mesh(faceGeo, prepass);
    faceMesh.frustumCulled = false;
    faceMesh.renderOrder = -10;
    scene.add(faceMesh);
    // the hull: the ellipsoid just inside the skull dots, pulled well back where the face covers it
    const hullGeo = new THREE.SphereGeometry(1, 40, 28);
    const hp = hullGeo.attributes.position as THREE.BufferAttribute;
    const { a, b, c } = cl.head;
    for (let i = 0; i < hp.count; i++) {
      const x = hp.getX(i) * a;
      const y = hp.getY(i) * b;
      const z = hp.getZ(i) * c;
      const k = inFace(cl.head, x, y, z) ? 0.72 : 0.985;
      hp.setXYZ(i, x * k, y * k, z * k);
    }
    // and the neck, just inside its dots
    const neckLo = cl.bottom - NECK.fade * 0.3;
    const neckGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    neckGeo.scale(NECK.rx * 0.985, -neckLo, NECK.rz * 0.985);
    neckGeo.translate(0, neckLo / 2, NECK.z);
    hullGeo.deleteAttribute('normal');
    hullGeo.deleteAttribute('uv');
    neckGeo.deleteAttribute('normal');
    neckGeo.deleteAttribute('uv');
    const shellGeo = mergeGeometries([hullGeo, neckGeo]);
    const hull = new THREE.Mesh(shellGeo, prepass);
    hull.frustumCulled = false;
    hull.renderOrder = -10;
    hull.matrixAutoUpdate = false;
    scene.add(hull);

    const g: GL = {
      renderer,
      scene,
      camera,
      material,
      posAttr,
      infoAttr,
      nrmAttr,
      facePos,
      hull,
      disposables: [geometry, material, prepass, faceGeo, hullGeo, neckGeo, shellGeo],
      lost: false,
      // a lost context draws the 2D fallback, then a new renderer is tried a second later (three times at most)
      onLost: (e) => {
        e.preventDefault();
        g.lost = true;
        failures++;
        retryAt = performance.now() + 1000;
      },
    };
    renderer.domElement.addEventListener('webglcontextlost', g.onLost);
    renderPx = 0;
    gl = g;
    return g;
  }

  /** Places every dot and the prepass for this frame. */
  function place(g: GL, cl: Cloud, P: Float32Array, life: number, t: number) {
    const { c0 } = cl.head;
    // live landmarks in model metres; points the frame clamped are not real positions
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < NV; i++) {
      frameToModel(P, i, live);
      const x = P[3 * i];
      const y = P[3 * i + 1];
      const z = P[3 * i + 2];
      bad[i] = (x <= 0 || x >= 1 || y <= 0 || y >= 1 ? 1 : 0) | (z <= -0.599 || z >= 0.599 ? 2 : 0);
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    // a frame without depth takes the canonical depth
    if (z1 - z0 < FLAT_Z) for (let i = 0; i < NV; i++) live[3 * i + 2] = CAN[3 * i + 2];
    fitPose(live, bad, pose);
    const { s, R, t: T } = pose;
    // clamped points take the rigid model's position (only z when only z was clamped)
    for (let i = 0; i < NV; i++) {
      if (!bad[i]) continue;
      const X = CAN[3 * i];
      const Y = CAN[3 * i + 1];
      const Z = CAN[3 * i + 2];
      for (let e = bad[i] & 1 ? 0 : 2; e < 3; e++) live[3 * i + e] = s * (R[3 * e] * X + R[3 * e + 1] * Y + R[3 * e + 2] * Z) + T[e];
    }
    // display: the head rotates about the skull centre, which sits at the origin; scale and translation are dropped
    const breath = 1 + life * BREATH.amp * Math.sin((t * 2 * Math.PI) / BREATH.period);
    const Rc = [R[0] * c0[0] + R[1] * c0[1] + R[2] * c0[2], R[3] * c0[0] + R[4] * c0[1] + R[5] * c0[2], R[6] * c0[0] + R[7] * c0[1] + R[8] * c0[2]];
    for (let i = 0; i < NV; i++) {
      for (let e = 0; e < 3; e++) V[3 * i + e] = ((live[3 * i + e] - T[e]) / s - Rc[e]) * breath;
    }
    VN.fill(0);
    const surf = cl.surface;
    for (let q = 0; q < surf.length; q += 3) {
      const i = surf[q];
      const j = surf[q + 1];
      const k = surf[q + 2];
      const ux = V[3 * j] - V[3 * i];
      const uy = V[3 * j + 1] - V[3 * i + 1];
      const uz = V[3 * j + 2] - V[3 * i + 2];
      const vx = V[3 * k] - V[3 * i];
      const vy = V[3 * k + 1] - V[3 * i + 1];
      const vz = V[3 * k + 2] - V[3 * i + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      VN[3 * i] += nx;
      VN[3 * i + 1] += ny;
      VN[3 * i + 2] += nz;
      VN[3 * j] += nx;
      VN[3 * j + 1] += ny;
      VN[3 * j + 2] += nz;
      VN[3 * k] += nx;
      VN[3 * k + 1] += ny;
      VN[3 * k + 2] += nz;
    }
    const pos = g.posAttr.array as Float32Array;
    const nrm = g.nrmAttr.array as Float32Array;
    const drift = life * DRIFT * cl.radius;
    const { tri, bary, ph } = cl;
    for (let d = 0; d < cl.nFace; d++) {
      const tt = tri[d];
      const i = FACE_TRIS[3 * tt];
      const j = FACE_TRIS[3 * tt + 1];
      const k = FACE_TRIS[3 * tt + 2];
      const w0 = bary[3 * d];
      const w1 = bary[3 * d + 1];
      const w2 = bary[3 * d + 2];
      let nx = w0 * VN[3 * i] + w1 * VN[3 * j] + w2 * VN[3 * k];
      let ny = w0 * VN[3 * i + 1] + w1 * VN[3 * j + 1] + w2 * VN[3 * k + 1];
      let nz = w0 * VN[3 * i + 2] + w1 * VN[3 * j + 2] + w2 * VN[3 * k + 2];
      const l = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= l;
      ny *= l;
      nz *= l;
      let x = w0 * V[3 * i] + w1 * V[3 * j] + w2 * V[3 * k];
      let y = w0 * V[3 * i + 1] + w1 * V[3 * j + 1] + w2 * V[3 * k + 1];
      const z = w0 * V[3 * i + 2] + w1 * V[3 * j + 2] + w2 * V[3 * k + 2];
      if (drift) {
        x += drift * Math.sin(t * 0.8 + ph[d]);
        y += drift * Math.cos(t * 0.67 + ph[d] * 1.3);
      }
      pos[3 * d] = x;
      pos[3 * d + 1] = y;
      pos[3 * d + 2] = z;
      nrm[3 * d] = nx;
      nrm[3 * d + 1] = ny;
      nrm[3 * d + 2] = nz;
    }
    const { home, hn } = cl;
    for (let d = cl.nFace, s3 = 0; d < cl.count; d++, s3 += 3) {
      const hx = home[s3];
      const hy = home[s3 + 1];
      const hz = home[s3 + 2];
      let x = (R[0] * hx + R[1] * hy + R[2] * hz) * breath;
      let y = (R[3] * hx + R[4] * hy + R[5] * hz) * breath;
      const z = (R[6] * hx + R[7] * hy + R[8] * hz) * breath;
      if (drift) {
        x += drift * Math.sin(t * 0.8 + ph[d]);
        y += drift * Math.cos(t * 0.67 + ph[d] * 1.3);
      }
      pos[3 * d] = x;
      pos[3 * d + 1] = y;
      pos[3 * d + 2] = z;
      const nx = hn[s3];
      const ny = hn[s3 + 1];
      const nz = hn[s3 + 2];
      nrm[3 * d] = R[0] * nx + R[1] * ny + R[2] * nz;
      nrm[3 * d + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
      nrm[3 * d + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
    }
    // Ava's eye texture rule around the live irises: dark (larger) inside the iris, light (smaller) on the white
    const ed = cl.eyeDots;
    if (ed.length) {
      const irisX = [0, 0];
      const irisY = [0, 0];
      for (let e = 0; e < 2; e++) {
        const id = IRIS.ids[e];
        const X = cx(1) + (P[3 * id] - 0.5) * FRAME.span * IOD;
        const Y = cy(1) - (P[3 * id + 1] - 0.5) * FRAME.span * IOD;
        irisX[e] = ((X - T[0]) / s - Rc[0]) * breath;
        irisY[e] = ((Y - T[1]) / s - Rc[1]) * breath;
      }
      const info = cl.info;
      const r0 = IRIS.radius - IRIS.soft;
      const r1 = IRIS.radius + IRIS.soft;
      for (let q = 0; q < ed.length; q += 2) {
        const d = ed[q];
        const e = ed[q + 1];
        const l = smooth(r0, r1, Math.hypot(pos[3 * d] - irisX[e], pos[3 * d + 1] - irisY[e]));
        info[4 * d] = SIZE_MUL.eyes * (IRIS.dark + (IRIS.bright - IRIS.dark) * l);
      }
      g.infoAttr.needsUpdate = true;
    }
    g.posAttr.needsUpdate = true;
    g.nrmAttr.needsUpdate = true;
    (g.facePos.array as Float32Array).set(V);
    g.facePos.needsUpdate = true;
    g.hull.matrix.set(
      R[0] * breath, R[1] * breath, R[2] * breath, 0,
      R[3] * breath, R[4] * breath, R[5] * breath, 0,
      R[6] * breath, R[7] * breath, R[8] * breath, 0,
      0, 0, 0, 1,
    );
    g.hull.matrixWorldNeedsUpdate = true;
  }

  return {
    draw(c, px, P, alpha, life = 0, t = 0) {
      const g = build();
      if (!g || !CLOUD) return false;
      const t0 = performance.now();
      // the buffer is the canvas's size, at a pixel ratio of MAX_DPR at most (drawImage scales it up past that)
      const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const dpr = Math.min(MAX_DPR, ratio);
      const want = Math.max(1, Math.round((px * dpr) / ratio));
      if (want !== renderPx) {
        renderPx = want;
        g.renderer.setSize(want, want, false);
      }
      place(g, CLOUD, P, life, t);
      const u = g.material.uniforms;
      u.uProj.value = renderPx / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      u.uDpr.value = dpr;
      g.renderer.render(g.scene, g.camera);
      if (g.lost) return false;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, px, px);
      c.globalAlpha = alpha;
      c.drawImage(g.renderer.domElement, 0, 0, renderPx, renderPx, 0, 0, px, px);
      c.globalAlpha = 1;
      // one-off cost report (CPU side, past the first build), like pointcloud.js
      stats.ms += performance.now() - t0;
      if (++stats.frames === 240) console.info(`[faceCloud] ${(stats.ms / stats.frames).toFixed(2)} ms/frame for ${CLOUD.count} dots`);
      return true;
    },
    dispose() {
      teardown(true);
    },
  };
}
