import * as THREE from "three";
import { classify } from "./hologram.js";
import { DOT, FLY, KIND, SHAPE, SIZE_MUL, createPointMaterial } from "./pointcloud-material.js";

/**
 * "particles" style: the head as a real point cloud.
 *
 * At load, every visible avatar mesh (head, hair, eyes, teeth, tongue) is sampled
 * into dots that each remember their triangle and barycentric weights. Every frame
 * the meshes are deformed on the CPU (morph targets, then skinning, vectorised over
 * typed arrays) and each dot is placed on its triangle, so lip shapes, blinks, gaze
 * and the head turn all carry through. The original meshes stay in the scene as an
 * invisible depth prepass so dots on the far side of the head are hidden.
 *
 * The pointer scatters dots near its ray; each dot springs back to its home.
 */

// dots per square metre of surface, by mesh class; and an overall cap
const DENSITY = { full: 230000, eyes: 360000, teeth: 260000, hair: 230000 };
const MAX_DOTS = 320000;
// Even spacing: candidates are generated at OVERSAMPLE x the density, then accepted only
// if no accepted dot lies within SPACING / sqrt(density) of them (dart throwing).
const OVERSAMPLE = 4;
const SPACING = 0.82;
// Lips are the darkest skin texels, so they get the largest dots; cap that near the mouth so a smile
// (which squeezes the lips vertically) does not pile them into a heavy, scaly band.
const LIP_SIZE_CAP = 1.15;
const MOUTH_RADIUS_MUL = 1.6;
const BOTTOM_FADE = 0.06; // metres of soft fade at the lowest part of the head
const HAIR_FADE = 0.08; // metres above the head bottom: the long hair fades out
// thin the fringe in front of the forehead so the face reads (same shape as the hologram style)
const FRINGE = { zStartFrac: 0.62, band: 0.03, sideFrac: 0.75, sideSoft: 0.03, yDrop: 0.05, ySoft: 0.03, strength: 1.0 };
// scalp cap: head dots above a soft hairline take the hair tone, so the crown reads as one dark mass with the
// hair cards instead of a pale scalp ringed by hair (same shape as the hologram style's "cap" hair mode)
const SCALP = { hairlineDrop: 0.085, soft: 0.011, temple: 0.045, nape: 0.17 }; // metres
/**
 * Pointer interaction: a displacement field, not a hole. Each dot near the pointer's
 * ray has a target displacement that falls off as a Gaussian of its distance to the
 * ray (so there is no hard edge): outward from the ray, a little toward the viewer,
 * and along the pointer's own motion so a sweep leaves a wake. A spring (k, c per
 * second, lightly underdamped) chases that target and returns home when the pointer
 * leaves; displaced dots also swirl slightly so the cloud reads as a fluid.
 */
const SCATTER = {
  radius: 0.03, // metres: Gaussian width of the field
  reach: 2.0, // dots farther than reach * radius from the ray are left alone (the field is under 2% there)
  // Displacement amounts sit at about 6% of the original tuning (0.011, 0.007, 0.5, 0.06): the same field and
  // spring, a much gentler stir.
  outward: 0.00068, // metres of radial displacement at the centre: a thinning, not a hole (keep below radius)
  lift: 0.0004, // metres toward the viewer at the centre
  drag: 0.03, // seconds: how much of the pointer's velocity becomes displacement (the wake)
  swirl: 0.45, // m/s of curl-like drift per metre of displacement
  k: 90,
  c: 11,
  maxOffset: 0.0036,
  settle: 1.5e-4,
  // Only the surface facing the viewer is stirred (normal . ray below -facing): the far side and inner surfaces
  // (mouth, eye sockets) stay put behind the depth prepass.
  facing: 0.1,
  // A dot never goes into the surface, where the prepass would hide it and leave a hole: a slide along the
  // surface also lifts it off by ride x the slide, so it rides over creases (nose, lips) instead of sinking.
  ride: 0.6
};
const PREPASS_OFFSET = { factor: 2, units: 4 };
// dot size from the skin texture: darker texels (lips, brows, nostrils) get bigger dots, like the hologram style
const TEX = { l0: 0.25, l1: 1.0, dark: 1.5, bright: 0.65, max: 1024 };
// Tone and curvature also raise the dot *density* (stippling: tone is density as much as size),
// so brows, lips, nostrils and the eye sockets gather more dots. Factors add to 1.
const DENSITY_WEIGHT = { tone: 1.4, curvature: 1.6, curvatureRad: 0.5 }; // curvatureRad: normal spread (radians) that counts as fully curved
const REDUCED_FADE_MS = 300; // reduced motion: a plain crossfade, no travel

/** Luminance lookup into a mesh's colour map, or null when there is none. */
function makeLumSampler(mesh) {
  const map = mesh.material?.map;
  const img = map?.image;
  if (!img || !img.width || typeof document === "undefined") return null;
  try {
    const w = Math.min(img.width, TEX.max);
    const h = Math.min(img.height, TEX.max);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const flip = !!map.flipY;
    return (u, v) => {
      u -= Math.floor(u);
      v -= Math.floor(v);
      const x = Math.min(w - 1, Math.floor(u * w));
      const y = Math.min(h - 1, Math.floor((flip ? 1 - v : v) * h));
      const i = (y * w + x) * 4;
      return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    };
  } catch (err) {
    console.warn("[pointcloud] texture not readable:", err?.message ?? err);
    return null;
  }
}

// coarse sine table for the swirl: thousands of calls per frame, precision irrelevant
const SIN_N = 1024;
const SIN_T = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN_T[i] = Math.sin((i / SIN_N) * Math.PI * 2);
const SIN_K = SIN_N / (Math.PI * 2);
const sinT = (x) => SIN_T[((x * SIN_K) | 0) & (SIN_N - 1)];

function halton(i, b) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

/** Deterministic hash of a dot index into [0, 1). */
function hash01(i, salt) {
  let h = (Math.imul(i + 1, 0x9e3779b9) + Math.imul(salt, 0x632be5ab)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Fly-in start points around the head centre (xyz) and a random phase (w), fixed per dot index. */
function makeFlyStarts(n) {
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const u = 2 * hash01(i, 1) - 1;
    const phi = 2 * Math.PI * hash01(i, 2);
    const s = Math.sqrt(1 - u * u);
    const r = FLY.radius[0] + (FLY.radius[1] - FLY.radius[0]) * Math.sqrt(hash01(i, 3));
    out[i * 4] = s * Math.cos(phi) * r;
    out[i * 4 + 1] = u * FLY.flatY * r;
    out[i * 4 + 2] = s * Math.sin(phi) * r * FLY.depth - FLY.back;
    out[i * 4 + 3] = hash01(i, 4);
  }
  return out;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Sorting ids by a float key without a comparator: the key is quantized and packed with the id into one
// float64 (both well inside 2^53), so the native typed-array sort does the work.
const QK = 1048576; // 2^20: max ids and key levels
function sortByKey(ids, key) {
  const m = ids.length;
  if (m < 2) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < m; j++) {
    const v = key[ids[j]];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const k = new Float64Array(m);
  for (let j = 0; j < m; j++) k[j] = Math.floor(((key[ids[j]] - lo) / span) * (QK - 1)) * QK + ids[j];
  k.sort();
  for (let j = 0; j < m; j++) ids[j] = k[j] % QK;
}

/**
 * Pair two equally long id lists by rank so neighbours stay neighbours: both are cut into the same number of
 * equal-count strips along x, then each strip is ordered along y. Afterwards a[j] pairs with b[j].
 */
function rankMatch(a, ax, ay, b, bx, by) {
  const m = a.length;
  sortByKey(a, ax);
  sortByKey(b, bx);
  const strips = Math.max(1, Math.round(Math.sqrt(m)));
  for (let s = 0; s < strips; s++) {
    const i0 = Math.floor((s * m) / strips);
    const i1 = Math.floor(((s + 1) * m) / strips);
    sortByKey(a.subarray(i0, i1), ay);
    sortByKey(b.subarray(i0, i1), by);
  }
}

/** Typed-array copy of a BufferAttribute (handles interleaved and normalized attributes). */
function copyAttr(attr, itemSize, Ctor = Float32Array) {
  const n = attr.count;
  const out = new Ctor(n * itemSize);
  for (let i = 0; i < n; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize > 3) out[i * itemSize + 3] = attr.getW(i);
  }
  return out;
}

/** CPU deformer for one mesh: rest + morph targets, then skinning, then the mesh's world matrix. */
function makeDeformer(mesh) {
  const g = mesh.geometry;
  const n = g.attributes.position.count;
  const rest = copyAttr(g.attributes.position, 3);
  const morphs = (g.morphAttributes.position || []).map((attr) => {
    const d = copyAttr(attr, 3);
    if (!g.morphTargetsRelative) for (let i = 0; i < d.length; i++) d[i] -= rest[i];
    return d;
  });
  const skinned = !!(mesh.isSkinnedMesh && mesh.skeleton && g.attributes.skinIndex && g.attributes.skinWeight);
  const skinIndex = skinned ? copyAttr(g.attributes.skinIndex, 4, Uint16Array) : null;
  const skinWeight = skinned ? copyAttr(g.attributes.skinWeight, 4) : null;
  const boneCount = skinned ? mesh.skeleton.bones.length : 0;
  const mats = new Float32Array(16 * Math.max(1, boneCount));
  const out = new Float32Array(n * 3);
  const pre = new THREE.Matrix4();
  const M = new THREE.Matrix4();

  function update() {
    out.set(rest);
    const infl = mesh.morphTargetInfluences;
    if (infl) {
      for (let m = 0; m < morphs.length; m++) {
        const w = infl[m];
        if (!w || Math.abs(w) < 1e-4) continue;
        const d = morphs[m];
        for (let i = 0; i < out.length; i++) out[i] += w * d[i];
      }
    }
    if (skinned) {
      // world = matrixWorld * bindMatrixInverse * bone_i * bindMatrix, per bone
      pre.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
      const bm = mesh.skeleton.boneMatrices;
      for (let b = 0; b < boneCount; b++) {
        M.fromArray(bm, b * 16).premultiply(pre).multiply(mesh.bindMatrix);
        mats.set(M.elements, b * 16);
      }
      for (let i = 0; i < n; i++) {
        const x = out[i * 3];
        const y = out[i * 3 + 1];
        const z = out[i * 3 + 2];
        let px = 0;
        let py = 0;
        let pz = 0;
        for (let j = 0; j < 4; j++) {
          const w = skinWeight[i * 4 + j];
          if (w === 0) continue;
          const e = skinIndex[i * 4 + j] * 16;
          px += w * (mats[e] * x + mats[e + 4] * y + mats[e + 8] * z + mats[e + 12]);
          py += w * (mats[e + 1] * x + mats[e + 5] * y + mats[e + 9] * z + mats[e + 13]);
          pz += w * (mats[e + 2] * x + mats[e + 6] * y + mats[e + 10] * z + mats[e + 14]);
        }
        out[i * 3] = px;
        out[i * 3 + 1] = py;
        out[i * 3 + 2] = pz;
      }
    } else {
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < n; i++) {
        const x = out[i * 3];
        const y = out[i * 3 + 1];
        const z = out[i * 3 + 2];
        out[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
    }
  }
  return { out, update };
}

export function createPointCloud({ renderer, scene, camera, canvas, root, anchor, reducedMotion = false, startDispersed = false }) {
  let reduced = !!reducedMotion;
  let active = false;
  let disposed = false;

  // ---- meshes ----
  const entries = [];
  const hidden = []; // glasses, body, brows: never drawn in this style
  root.traverse((o) => {
    if (!o.isSkinnedMesh && !o.isMesh) return;
    if (!o.geometry?.attributes?.position) return;
    const cls = classify(o.name || "");
    if (cls === "hidden") {
      hidden.push({ mesh: o, visible: o.visible });
      return;
    }
    entries.push({ mesh: o, cls, visible: o.visible, prepass: null, deformer: null });
  });

  // rest-space bounds of the head mesh (for fades and the fringe)
  const bounds = new THREE.Box3();
  let headBox = null;
  for (const e of entries) {
    const g = e.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    bounds.union(g.boundingBox);
    if (/head/i.test(e.mesh.name) && !/hair/i.test(e.mesh.name)) headBox = g.boundingBox;
  }
  const hb = headBox ?? bounds;
  const minY = hb.min.y;
  const halfW = (hb.max.x - hb.min.x) / 2;
  const fringeZ = hb.min.z + (hb.max.z - hb.min.z) * FRINGE.zStartFrac;
  const fringeY = hb.max.y - FRINGE.yDrop;
  const scalpY = hb.max.y - SCALP.hairlineDrop;
  const scalpMask = (p) => {
    const y0 = scalpY - SCALP.temple * smooth(0.045, 0.085, Math.abs(p.x)) - SCALP.nape * (1 - smooth(-0.03, 0, p.z));
    return smooth(y0 - SCALP.soft, y0 + SCALP.soft, p.y);
  };
  const mouthC = anchor?.restCenter ?? new THREE.Vector3(0, 1.55, 0.09);
  const mouthR = (anchor?.radius ?? 0.03) * MOUTH_RADIUS_MUL;

  // ---- sampling ----
  const areas = new Map();
  let total = 0;
  for (const e of entries) {
    const g = e.mesh.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const triArea = new Float32Array(triCount);
    let sum = 0;
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx.getX(t * 3) : t * 3;
      const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      b.sub(a);
      c.sub(a);
      triArea[t] = 0.5 * b.cross(c).length();
      sum += triArea[t];
    }
    areas.set(e, { triArea, sum });
    total += sum * DENSITY[e.cls];
  }
  // Fewer dots on small machines: the deformer and the scatter run on the CPU every frame.
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;
  const budget = cores <= 4 ? 0.45 : 1;
  const scale = Math.min(1, (MAX_DOTS * budget) / Math.max(1, total)) * budget;

  // Dots reference a table of unique triangles, so each triangle's deformed frame and
  // normal are computed once per frame and shared by every dot on it.
  const uniq = []; // [entryIndex, ia, ib, ic] flattened, one record per triangle that carries dots
  const uniqIndex = new Map(); // numeric key (entry, directed edge a->b) -> record index
  const dotTri = []; // record index per dot
  const bary = [];
  const info = [];
  const P = new THREE.Vector3();
  const perClass = {};
  for (let ei = 0; ei < entries.length; ei++) {
    const e = entries[ei];
    const g = e.mesh.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const { triArea } = areas.get(e);
    const density = DENSITY[e.cls] * scale;
    const kind = e.cls === "hair" ? KIND.hair : e.cls === "eyes" ? KIND.eyes : e.cls === "teeth" ? KIND.teeth : KIND.head;
    const sizeMul = SIZE_MUL[e.cls] ?? 1;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const uv = g.attributes.uv;
    const lum = e.cls === "hair" || !uv ? null : makeLumSampler(e.mesh);
    const nrm = g.attributes.normal;
    const na = new THREE.Vector3();
    const nb = new THREE.Vector3();
    const ncv = new THREE.Vector3();
    const weighted = e.cls !== "hair";
    const isScalp = e.cls === "full" && /head/i.test(e.mesh.name);

    // 1. candidates, several per final dot, in a random order so acceptance is unbiased.
    // Each triangle's density is raised by the darkness of its texture and by its curvature
    // (how much the vertex normals disagree), so features gather dots; each candidate
    // carries its own minimum spacing for the dart throwing below.
    const cand = []; // [ia, ib, ic, w0, w1, w2, x, y, z, rMin] flattened
    const rBase = SPACING / Math.sqrt(density);
    for (let t = 0; t < triArea.length; t++) {
      const ia = idx ? idx.getX(t * 3) : t * 3;
      const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      let factor = 1;
      if (weighted) {
        if (nrm) {
          na.fromBufferAttribute(nrm, ia).normalize();
          nb.fromBufferAttribute(nrm, ib).normalize();
          ncv.fromBufferAttribute(nrm, ic).normalize();
          const spread = Math.max(na.angleTo(nb), nb.angleTo(ncv), na.angleTo(ncv));
          factor += DENSITY_WEIGHT.curvature * Math.min(1, spread / DENSITY_WEIGHT.curvatureRad);
        }
        if (lum && uv) {
          const u = (uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3;
          const v = (uv.getY(ia) + uv.getY(ib) + uv.getY(ic)) / 3;
          factor += DENSITY_WEIGHT.tone * (1 - smooth(TEX.l0, TEX.l1, lum(u, v)));
        }
      }
      const expected = triArea[t] * density * factor * OVERSAMPLE;
      let n = Math.floor(expected);
      if (Math.random() < expected - n) n++;
      if (!n) continue;
      const rMin = rBase / Math.sqrt(factor);
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      const rot1 = Math.random();
      const rot2 = Math.random();
      for (let k = 0; k < n; k++) {
        const r1 = (halton(k + 1, 2) + rot1) % 1;
        const r2 = (halton(k + 1, 3) + rot2) % 1;
        const s = Math.sqrt(r1);
        const w0 = 1 - s;
        const w1 = s * (1 - r2);
        const w2 = s * r2;
        cand.push(ia, ib, ic, w0, w1, w2, w0 * a.x + w1 * b.x + w2 * c.x, w0 * a.y + w1 * b.y + w2 * c.y, w0 * a.z + w1 * b.z + w2 * c.z, rMin);
      }
    }
    const STRIDE = 10;
    const nc = cand.length / STRIDE;
    const order = new Uint32Array(nc);
    for (let i = 0; i < nc; i++) order[i] = i;
    for (let i = nc - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    // 2. dart throwing on a hash grid: keep a candidate only if no accepted dot is closer than the
    // mean of the two dots' own minimum spacings (adaptive Poisson disk). Cells are the largest spacing.
    const cell = rBase;
    const grid = new Map(); // numeric cell hash -> flat [x, y, z, rMin] list; a hash collision only costs an extra distance check
    const hash = (gx, gy, gz) => ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) | 0;
    let kept = 0;
    for (let oi = 0; oi < nc; oi++) {
      const i = order[oi] * STRIDE;
      const x = cand[i + 6];
      const y = cand[i + 7];
      const z = cand[i + 8];
      const rm = cand[i + 9];
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
      const k = hash(cx, cy, cz);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(x, y, z, rm);

      P.set(x, y, z);
      let alpha = smooth(minY, minY + BOTTOM_FADE, P.y);
      if (e.cls === "hair") {
        alpha *= smooth(minY, minY + HAIR_FADE, P.y);
        // fringe: thin the hair in front of the forehead, more toward the tips
        const front = smooth(fringeZ, fringeZ + FRINGE.band, P.z);
        const side = 1 - smooth(halfW * FRINGE.sideFrac - FRINGE.sideSoft, halfW * FRINGE.sideFrac + FRINGE.sideSoft, Math.abs(P.x));
        const below = 1 - smooth(fringeY - FRINGE.ySoft, fringeY + FRINGE.ySoft, P.y);
        const keep = 1 - FRINGE.strength * front * side * below;
        if (Math.random() > keep) continue;
      }
      if (alpha < 0.02) continue;
      const dm = Math.hypot(P.x - mouthC.x, P.y - mouthC.y, (P.z - mouthC.z) * 0.5);
      const mouth = e.cls === "hair" ? 0 : 1 - smooth(mouthR * 0.6, mouthR, dm);
      let size = sizeMul;
      if (lum) {
        const w0 = cand[i + 3];
        const w1 = cand[i + 4];
        const w2 = cand[i + 5];
        const ia = cand[i];
        const ib = cand[i + 1];
        const ic = cand[i + 2];
        const u = w0 * uv.getX(ia) + w1 * uv.getX(ib) + w2 * uv.getX(ic);
        const v = w0 * uv.getY(ia) + w1 * uv.getY(ib) + w2 * uv.getY(ic);
        const l = smooth(TEX.l0, TEX.l1, lum(u, v));
        size *= TEX.dark + (TEX.bright - TEX.dark) * l;
        if (mouth > 0) size += (Math.min(size, sizeMul * LIP_SIZE_CAP) - size) * mouth;
      }
      let dotKind = kind;
      if (isScalp && Math.random() < scalpMask(P)) {
        dotKind = KIND.hair;
        size = SIZE_MUL.hair;
      }
      const tkey = `${ei}:${cand[i]}:${cand[i + 1]}`; // a directed edge belongs to one triangle in a consistently wound mesh
      let tid = uniqIndex.get(tkey);
      if (tid === undefined) {
        tid = uniq.length / 4;
        uniqIndex.set(tkey, tid);
        uniq.push(ei, cand[i], cand[i + 1], cand[i + 2]);
      }
      dotTri.push(tid);
      bary.push(cand[i + 3], cand[i + 4], cand[i + 5]);
      info.push(size, dotKind, mouth, alpha);
      kept++;
    }
    perClass[e.mesh.name || e.cls] = `${e.cls}: ${kept} dots, ${nc} candidates, area ${areas.get(e).sum.toFixed(4)} m²`;
  }
  console.info("[pointcloud] sampling", perClass);
  const count = bary.length / 3;
  const uniqA = new Uint32Array(uniq);
  const dotTriA = new Uint32Array(dotTri);
  const triCountU = uniqA.length / 4;
  const triFrame = new Float32Array(triCountU * 12); // per triangle: a, u = b - a, v = c - a, unit normal
  console.info(`[pointcloud] ${triCountU} triangles carry dots`);
  const baryA = new Float32Array(bary);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const offset = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const activeIdx = new Uint32Array(count);
  const isActive = new Uint8Array(count);
  let activeCount = 0;
  console.info(`[pointcloud] ${count} dots from ${entries.length} meshes`);

  for (const e of entries) e.deformer = makeDeformer(e.mesh);

  // ---- points object ----
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const nrmAttr = new THREE.BufferAttribute(normals, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  nrmAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aNormal", nrmAttr);
  const infoA = new Float32Array(info);
  geometry.setAttribute("aInfo", new THREE.BufferAttribute(infoA, 4));
  // fly-in starts: the shell, or (with a start shape) points on the picture in camera space
  const shellFly = makeFlyStarts(count);
  const flyA = new Float32Array(shellFly);
  const flyAttr = new THREE.BufferAttribute(flyA, 4);
  geometry.setAttribute("aFly", flyAttr);
  const shapeA = new Float32Array(count * 2);
  const shapeAttr = new THREE.BufferAttribute(shapeA, 2);
  geometry.setAttribute("aShape", shapeAttr);
  const material = createPointMaterial({ center: mouthC, yRange: [minY, hb.max.y] });
  const uniforms = material.uniforms;
  const points = new THREE.Points(geometry, material);
  points.name = "head-pointcloud";
  points.frustumCulled = false;
  points.renderOrder = 1;
  points.visible = false;
  scene.add(points);

  // depth prepass clones so dots on the far side are hidden by the head itself
  const prepassMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: PREPASS_OFFSET.factor,
    polygonOffsetUnits: PREPASS_OFFSET.units
  });
  function makePrepass(e) {
    const m = e.mesh;
    let pm;
    if (m.isSkinnedMesh) {
      pm = new THREE.SkinnedMesh(m.geometry, prepassMaterial);
      pm.bindMode = m.bindMode;
      pm.bind(m.skeleton, m.bindMatrix);
    } else {
      pm = new THREE.Mesh(m.geometry, prepassMaterial);
    }
    pm.name = m.name + "_cloudprepass";
    pm.frustumCulled = false;
    pm.renderOrder = -10;
    return pm;
  }
  function syncPrepass(e) {
    const pm = e.prepass;
    const m = e.mesh;
    pm.position.copy(m.position);
    pm.quaternion.copy(m.quaternion);
    pm.scale.copy(m.scale);
    if (m.morphTargetInfluences) {
      pm.morphTargetInfluences = m.morphTargetInfluences;
      pm.morphTargetDictionary = m.morphTargetDictionary;
    }
  }

  // ---- pointer ----
  const pointer = { x: 0, y: 0, on: false, fresh: false };
  const onMove = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
    if (!pointer.on) pointer.fresh = true; // first sample after entering: no velocity yet
    pointer.on = true;
  };
  const onLeave = () => {
    pointer.on = false;
  };
  const target = new Float32Array(count * 3); // where each displaced dot is being pulled to, relative to home
  const touched = new Uint32Array(count); // frame stamp of the last target set
  const pointerVel = new THREE.Vector3();
  const rayHit = new THREE.Vector3();
  const prevHit = new THREE.Vector3();
  const FOCUS = 0.55; // metres along the ray where the pointer's motion is measured (about the head's distance)
  const bound = { x: 0, y: 0, z: 0, r: 0 }; // rough bounding sphere of the cloud, refreshed now and then
  let frameId = 0;
  let clock = 0;
  canvas.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerdown", onMove, { passive: true });
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", onLeave);

  const stats = { ms: 0, frames: 0 };
  const rayO = new THREE.Vector3();
  const rayD = new THREE.Vector3();
  const size = new THREE.Vector2();
  const skeletons = new Set();
  for (const e of entries) if (e.mesh.skeleton) skeletons.add(e.mesh.skeleton);

  function activate(i) {
    if (isActive[i]) return;
    isActive[i] = 1;
    activeIdx[activeCount++] = i;
  }

  /** Set each nearby dot's target displacement from the pointer's ray and motion. */
  function scatter(dtSec) {
    frameId++;
    if (!pointer.on || reduced || !settledHome()) return;
    rayO.setFromMatrixPosition(camera.matrixWorld);
    rayD.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(rayO).normalize();
    rayHit.copy(rayD).multiplyScalar(FOCUS).add(rayO);
    if (pointer.fresh || dtSec <= 0) {
      pointerVel.set(0, 0, 0);
      pointer.fresh = false;
    } else {
      // smoothed pointer velocity in world units, so a sweep drags dots along with it
      const vx = (rayHit.x - prevHit.x) / dtSec;
      const vy = (rayHit.y - prevHit.y) / dtSec;
      const vz = (rayHit.z - prevHit.z) / dtSec;
      pointerVel.x += (vx - pointerVel.x) * 0.35;
      pointerVel.y += (vy - pointerVel.y) * 0.35;
      pointerVel.z += (vz - pointerVel.z) * 0.35;
    }
    prevHit.copy(rayHit);
    const R = SCATTER.radius;
    const reach2 = (R * SCATTER.reach) ** 2;
    const inv = 1 / (R * R);
    // whole-cloud test first: a pointer that misses the head costs nothing per dot
    if (frameId % 30 === 1 || bound.r === 0) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let n = 0;
      for (let i = 0; i < count; i += 97) {
        cx += positions[i * 3];
        cy += positions[i * 3 + 1];
        cz += positions[i * 3 + 2];
        n++;
      }
      bound.x = cx / n;
      bound.y = cy / n;
      bound.z = cz / n;
      let r2 = 0;
      for (let i = 0; i < count; i += 97) {
        const ex = positions[i * 3] - bound.x;
        const ey = positions[i * 3 + 1] - bound.y;
        const ez = positions[i * 3 + 2] - bound.z;
        r2 = Math.max(r2, ex * ex + ey * ey + ez * ez);
      }
      bound.r = Math.sqrt(r2) * 1.1 + 0.02;
    }
    {
      const bx = bound.x - rayO.x;
      const by = bound.y - rayO.y;
      const bz = bound.z - rayO.z;
      const t = bx * rayD.x + by * rayD.y + bz * rayD.z;
      const qx = bx - t * rayD.x;
      const qy = by - t * rayD.y;
      const qz = bz - t * rayD.z;
      const lim = bound.r + R * SCATTER.reach;
      if (qx * qx + qy * qy + qz * qz > lim * lim) return;
    }
    const ox = rayO.x;
    const oy = rayO.y;
    const oz = rayO.z;
    const dx = rayD.x;
    const dy = rayD.y;
    const dz = rayD.z;
    const drag = SCATTER.drag;
    const wx = pointerVel.x * drag;
    const wy = pointerVel.y * drag;
    const wz = pointerVel.z * drag;
    for (let i = 0; i < count; i++) {
      const hx = positions[i * 3] - offset[i * 3] - ox;
      const hy = positions[i * 3 + 1] - offset[i * 3 + 1] - oy;
      const hz = positions[i * 3 + 2] - offset[i * 3 + 2] - oz;
      const t = hx * dx + hy * dy + hz * dz;
      if (t <= 0) continue;
      const px = hx - t * dx;
      const py = hy - t * dy;
      const pz = hz - t * dz;
      const d2 = px * px + py * py + pz * pz;
      if (d2 >= reach2) continue;
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      if (nx * dx + ny * dy + nz * dz > -SCATTER.facing) continue; // far side or an inner surface: left alone
      const g = Math.exp(-d2 * inv); // Gaussian falloff: no edge
      const d = Math.sqrt(d2);
      const radial = (SCATTER.outward * g) / Math.max(d, 1e-4);
      const lift = SCATTER.lift * g;
      let tx = px * radial - dx * lift + wx * g;
      let ty = py * radial - dy * lift + wy * g;
      let tz = pz * radial - dz * lift + wz * g;
      // keep it out of the surface: at least ride x its slide along it, off it
      const tn = tx * nx + ty * ny + tz * nz;
      const slide = Math.sqrt(Math.max(0, tx * tx + ty * ty + tz * tz - tn * tn));
      const up = SCATTER.ride * slide - tn;
      if (up > 0) {
        tx += nx * up;
        ty += ny * up;
        tz += nz * up;
      }
      target[i * 3] = tx;
      target[i * 3 + 1] = ty;
      target[i * 3 + 2] = tz;
      touched[i] = frameId;
      activate(i);
    }
  }

  /** Spring every displaced dot toward its target (home once the pointer has moved on), with a light swirl. */
  function springs(dtSec) {
    if (!activeCount) return;
    clock += dtSec;
    const k = SCATTER.k;
    const c = SCATTER.c;
    const max = SCATTER.maxOffset;
    const swirl = SCATTER.swirl;
    const f = 90; // swirl wavelength about 7 cm
    const t1 = clock * 2.1;
    const t2 = clock * 2.7;
    const t3 = clock * 1.6;
    let w = 0;
    for (let a = 0; a < activeCount; a++) {
      const i = activeIdx[a];
      if (touched[i] !== frameId) target[i * 3] = target[i * 3 + 1] = target[i * 3 + 2] = 0;
      const hx = positions[i * 3] - offset[i * 3];
      const hy = positions[i * 3 + 1] - offset[i * 3 + 1];
      const hz = positions[i * 3 + 2] - offset[i * 3 + 2];
      const ox = offset[i * 3];
      const oy = offset[i * 3 + 1];
      const oz = offset[i * 3 + 2];
      const amp = swirl * Math.sqrt(ox * ox + oy * oy + oz * oz);
      // a divergence-free-looking drift: each axis driven by the next axis's phase
      const sx = sinT(hy * f + t1) * amp;
      const sy = sinT(hz * f + t2) * amp;
      const sz = sinT(hx * f + t3) * amp;
      let settled = true;
      for (let j = 0; j < 3; j++) {
        const o = offset[i * 3 + j];
        const tg = target[i * 3 + j];
        let v = vel[i * 3 + j];
        v += (k * (tg - o) - c * v) * dtSec + (j === 0 ? sx : j === 1 ? sy : sz) * dtSec;
        let no = o + v * dtSec;
        if (no > max) no = max;
        else if (no < -max) no = -max;
        offset[i * 3 + j] = no;
        vel[i * 3 + j] = v;
        if (Math.abs(no) > SCATTER.settle || Math.abs(v) > SCATTER.settle * 20 || Math.abs(tg) > SCATTER.settle) settled = false;
      }
      // the spring's overshoot on the way home must not carry the dot into the surface either
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      const on = offset[i * 3] * nx + offset[i * 3 + 1] * ny + offset[i * 3 + 2] * nz;
      if (on < 0) {
        offset[i * 3] -= on * nx;
        offset[i * 3 + 1] -= on * ny;
        offset[i * 3 + 2] -= on * nz;
        const vn = vel[i * 3] * nx + vel[i * 3 + 1] * ny + vel[i * 3 + 2] * nz;
        if (vn < 0) {
          vel[i * 3] -= vn * nx;
          vel[i * 3 + 1] -= vn * ny;
          vel[i * 3 + 2] -= vn * nz;
        }
      }
      if (settled) {
        offset[i * 3] = offset[i * 3 + 1] = offset[i * 3 + 2] = 0;
        vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
        isActive[i] = 0;
      } else {
        activeIdx[w++] = i;
      }
    }
    activeCount = w;
  }

  function place() {
    // 1. each triangle's deformed frame and normal, once
    for (let t = 0; t < triCountU; t++) {
      const out = entries[uniqA[t * 4]].deformer.out;
      const ia = uniqA[t * 4 + 1] * 3;
      const ib = uniqA[t * 4 + 2] * 3;
      const ic = uniqA[t * 4 + 3] * 3;
      const ax = out[ia];
      const ay = out[ia + 1];
      const az = out[ia + 2];
      const ux = out[ib] - ax;
      const uy = out[ib + 1] - ay;
      const uz = out[ib + 2] - az;
      const vx = out[ic] - ax;
      const vy = out[ic + 1] - ay;
      const vz = out[ic + 2] - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      const o = t * 12;
      triFrame[o] = ax;
      triFrame[o + 1] = ay;
      triFrame[o + 2] = az;
      triFrame[o + 3] = ux;
      triFrame[o + 4] = uy;
      triFrame[o + 5] = uz;
      triFrame[o + 6] = vx;
      triFrame[o + 7] = vy;
      triFrame[o + 8] = vz;
      triFrame[o + 9] = nx * inv;
      triFrame[o + 10] = ny * inv;
      triFrame[o + 11] = nz * inv;
    }
    // 2. every dot from its triangle's frame
    for (let i = 0; i < count; i++) {
      const o = dotTriA[i] * 12;
      const w1 = baryA[i * 3 + 1];
      const w2 = baryA[i * 3 + 2];
      positions[i * 3] = triFrame[o] + w1 * triFrame[o + 3] + w2 * triFrame[o + 6] + offset[i * 3];
      positions[i * 3 + 1] = triFrame[o + 1] + w1 * triFrame[o + 4] + w2 * triFrame[o + 7] + offset[i * 3 + 1];
      positions[i * 3 + 2] = triFrame[o + 2] + w1 * triFrame[o + 5] + w2 * triFrame[o + 8] + offset[i * 3 + 2];
      normals[i * 3] = triFrame[o + 9];
      normals[i * 3 + 1] = triFrame[o + 10];
      normals[i * 3 + 2] = triFrame[o + 11];
    }
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
  }

  // ---- assembly transitions: state on the CPU, motion in the vertex shader ----
  // mode 0 is the fly-in (p 1 = assembled), mode 1 the dissolve (p 1 = gone)
  const fly = { mode: startDispersed ? 1 : 0, p: 1, anim: null }; // anim: { to, dur, assemble, resolve }
  const settledHome = () => !fly.anim && fly.mode === 0 && fly.p >= 1;
  const gone = () => (fly.mode === 1 ? fly.p >= 1 : fly.p <= 0);

  // start shape: on while a picture is set; alpha is its fade-in; a clear asked for mid-morph waits for the end
  const shape = { on: false, alpha: 0, pendingClear: false };
  // dispersed with a start shape: the dots sit on the picture (the fly-in at progress 0)
  const showingShape = () => shape.on && !fly.anim && gone();

  function applyFly() {
    const showShape = showingShape();
    const empty = !fly.anim && gone() && !showShape;
    uniforms.uProg.value = showShape ? 0 : fly.p;
    uniforms.uMode.value = showShape ? 0 : fly.mode;
    uniforms.uTravel.value = reduced ? 0 : 1;
    uniforms.uShape.value = shape.on ? 1 : 0;
    // The depth prepass hides the far side and the eye and mouth interiors. Early in the fly-in it would also
    // hide dots in flight behind an invisible head, so it is off then and the shader hides settled dots on the
    // far side instead. The dissolve keeps it: dots leave the surface outward, so they stay in front of it.
    // The start picture is not on the head's surface, so it never has the prepass.
    const prepassOn = active && !empty && !showShape && (fly.mode === 1 || fly.p >= FLY.prepassAt || reduced);
    uniforms.uBackFade.value = prepassOn ? 0 : 1;
    points.visible = active && !empty;
    for (const e of entries) if (e.prepass) e.prepass.visible = e.visible && prepassOn;
  }

  function endFly(done) {
    const a = fly.anim;
    if (!a) return;
    fly.anim = null;
    if (done) {
      fly.mode = a.assemble ? 0 : 1;
      fly.p = 1;
    }
    if (shape.pendingClear) clearShape();
    applyFly();
    a.resolve(done);
  }

  /** Resolves true when the head is assembled (or gone), false if another transition interrupts it. */
  function transition(assemble, durationMs) {
    if (disposed) return Promise.resolve(false);
    endFly(false);
    if (gone()) {
      fly.mode = 1;
      fly.p = 1;
    }
    if (assemble ? settledHome() : gone()) {
      applyFly();
      return Promise.resolve(true);
    }
    if (!active) {
      fly.mode = assemble ? 0 : 1;
      fly.p = 1;
      applyFly();
      return Promise.resolve(true);
    }
    // From rest, start the full motion; part-way through the other one, run that one backwards (no jump).
    if (assemble && gone()) {
      fly.mode = 0;
      fly.p = 0;
    } else if (!assemble && settledHome()) {
      fly.mode = 1;
      fly.p = 0;
    }
    const to = assemble ? (fly.mode === 0 ? 1 : 0) : fly.mode === 1 ? 1 : 0;
    const dur = reduced ? REDUCED_FADE_MS : Math.max(1, +durationMs || 0);
    return new Promise((resolve) => {
      fly.anim = { to, dur, assemble, resolve };
      applyFly();
    });
  }

  function stepFly(dtMs) {
    const a = fly.anim;
    const d = Math.max(0, dtMs || 0) / a.dur;
    fly.p = a.to > fly.p ? Math.min(a.to, fly.p + d) : Math.max(a.to, fly.p - d);
    if (fly.p === a.to) endFly(true);
    else applyFly();
  }

  /** Head centre and height for the shader, from a sparse sample of the live dots. */
  function measureFly() {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < count; i += 61) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (!(x1 >= x0)) return;
    uniforms.uCenter.value.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    uniforms.uYRange.value.set(y0, y1);
  }

  /** Deform the meshes for the current pose (morphs, skinning, world matrices). */
  function pose() {
    root.updateMatrixWorld(true);
    for (const sk of skeletons) sk.update();
    for (const e of entries) {
      e.deformer.update();
      if (e.prepass) syncPrepass(e);
    }
  }

  function syncProjection() {
    renderer.getDrawingBufferSize(size);
    uniforms.uProj.value = size.y / 2 / Math.tan(THREE.MathUtils.degToRad((camera.fov || 30) / 2));
    uniforms.uDpr.value = renderer.getPixelRatio();
  }

  /** The picture is stored in camera space, so it stays put on screen while the camera eases. */
  function syncShape(dtMs) {
    camera.updateMatrixWorld();
    uniforms.uShapeMatrix.value.copy(camera.matrixWorld);
    // the fade-in keeps running into the morph, so a morph started at once (no hold on the picture) is still seen
    const morphing = fly.anim && fly.mode === 0;
    if (showingShape() || morphing) shape.alpha = reduced ? 1 : Math.min(1, shape.alpha + Math.max(0, dtMs || 0) / SHAPE.appearMs);
    else shape.alpha = 0; // the head is up: the next showing fades in again
    uniforms.uShapeAlpha.value = shape.alpha;
  }

  function clearShape() {
    if (!shape.on) {
      shape.pendingClear = false;
      return;
    }
    if (fly.anim && fly.mode === 0) {
      shape.pendingClear = true; // mid-morph: the dots are still leaving the picture
      return;
    }
    shape.on = false;
    shape.pendingClear = false;
    shape.alpha = 0;
    flyA.set(shellFly);
    flyAttr.needsUpdate = true;
    applyFly();
  }

  /**
   * Start the fly-in from a picture instead of the shell. shape.points: xyz per sample in camera space (the
   * picture's plane in front of the camera); shape.shade: 0..1 per sample (1 darkest); shape.jitter: metres
   * between samples (each sample's dots are spread over that cell); shape.area: the picture's area in m² (default
   * samples x jitter²), which sets the dot radius for SHAPE.coverage; shape.dotRadius overrides that radius.
   * Every dot starts visible on the picture, darker samples carrying more of them. Null restores the shell.
   * Returns true when the picture is on stage (the cloud is active).
   */
  function setStartShape(s) {
    if (disposed) return false;
    const pts = s?.points;
    const n = pts ? Math.floor(pts.length / 3) : 0;
    if (!n) {
      clearShape();
      return false;
    }
    shape.pendingClear = false;
    const t0 = performance.now();

    // head dots where they are now, in camera space
    pose();
    place();
    camera.updateMatrixWorld();
    const V = camera.matrixWorldInverse.elements;
    const hx = new Float32Array(count);
    const hy = new Float32Array(count);
    const hz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      hx[i] = V[0] * x + V[4] * y + V[8] * z + V[12];
      hy[i] = V[1] * x + V[5] * y + V[9] * z + V[13];
      hz[i] = V[2] * x + V[6] * y + V[10] * z + V[14];
    }

    // every dot gets a spot on the picture: samples are drawn in proportion to toneWeight + tone (stratified,
    // so the spread is even) and the dot is scattered over its sample's cell
    const shadeOf = (j) => (s.shade ? Math.min(1, Math.max(0, s.shade[j] ?? 1)) : 1);
    const cum = new Float64Array(n);
    let acc = 0;
    for (let j = 0; j < n; j++) cum[j] = acc += SHAPE.toneWeight + shadeOf(j);
    const jit = Math.max(0, +s.jitter || 0);
    const rx = new Float32Array(count);
    const ry = new Float32Array(count);
    const rz = new Float32Array(count);
    const rs = new Float32Array(count);
    const vid = new Uint32Array(count);
    const dots = new Uint32Array(count);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let k = 0; k < count; k++) {
      const u = ((k + Math.random()) / count) * acc;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      rx[k] = pts[lo * 3] + (Math.random() - 0.5) * jit;
      ry[k] = pts[lo * 3 + 1] + (Math.random() - 0.5) * jit;
      rz[k] = pts[lo * 3 + 2];
      rs[k] = shadeOf(lo);
      vid[k] = k;
      dots[k] = k;
      if (rx[k] < x0) x0 = rx[k];
      if (rx[k] > x1) x1 = rx[k];
    }
    rankMatch(dots, hx, hy, vid, rx, ry);

    // stagger key per dot (0 leaves first)
    let d0 = Infinity;
    let d1 = -Infinity;
    const dist = SHAPE.key === "dist" ? new Float32Array(count) : null;
    if (dist) {
      for (let j = 0; j < count; j++) {
        const i = dots[j];
        const v = vid[j];
        const d = Math.hypot(rx[v] - hx[i], ry[v] - hy[i], rz[v] - hz[i]);
        dist[j] = d;
        if (d < d0) d0 = d;
        if (d > d1) d1 = d;
      }
    }
    const xs = x1 - x0 || 1;
    const ds = d1 - d0 || 1;
    for (let j = 0; j < count; j++) {
      const i = dots[j];
      const v = vid[j];
      flyA[i * 4] = rx[v];
      flyA[i * 4 + 1] = ry[v];
      flyA[i * 4 + 2] = rz[v];
      shapeA[i * 2] = rs[v];
      const xN = (rx[v] - x0) / xs;
      shapeA[i * 2 + 1] = dist ? 1 - (dist[j] - d0) / ds : SHAPE.key === "far" ? 1 - xN : xN;
    }
    flyAttr.needsUpdate = true;
    shapeAttr.needsUpdate = true;

    // dot radius for the target coverage: 1 - exp(-density * pi * r^2) = coverage
    const area = s.area > 0 ? s.area : n * jit * jit;
    let radius = s.dotRadius > 0 ? s.dotRadius : 0;
    if (!radius && area > 0) radius = Math.sqrt(-Math.log(1 - SHAPE.coverage) / (Math.PI * (count / area)));
    uniforms.uShapeRadius.value = radius || DOT.radius;

    if (!shape.on || !showingShape()) shape.alpha = 0;
    shape.on = true;
    syncShape(0);
    syncProjection();
    applyFly();
    console.info(`[pointcloud] start shape: ${count} dots on ${n} samples, radius ${(uniforms.uShapeRadius.value * 1000).toFixed(3)} mm, ${(performance.now() - t0).toFixed(0)} ms`);
    return active;
  }

  function setActive(on) {
    if (disposed) return;
    active = !!on;
    if (!active && fly.anim) {
      fly.p = fly.anim.to;
      endFly(true);
    }
    for (const h of hidden) h.mesh.visible = active ? false : h.visible;
    for (const e of entries) {
      if (active) {
        // Hair cards are thin and partly thinned out, so they do not occlude; the head does.
        if (e.cls !== "hair") {
          if (!e.prepass) e.prepass = makePrepass(e);
          syncPrepass(e);
          if (e.mesh.parent && e.prepass.parent !== e.mesh.parent) e.mesh.parent.add(e.prepass);
        }
        e.mesh.visible = false;
      } else {
        if (e.prepass?.parent) e.prepass.parent.remove(e.prepass);
        e.mesh.visible = e.visible;
      }
    }
    applyFly(); // points and prepass visibility
  }

  return {
    points,
    get count() {
      return count;
    },
    get active() {
      return active;
    },
    setActive,
    /** "assembled" | "dispersed" | "assembling" | "dispersing" */
    get assembly() {
      if (fly.anim) return fly.anim.assemble ? "assembling" : "dispersing";
      return settledHome() ? "assembled" : "dispersed";
    },
    /** Fly the dots in from around the stage and build the head. */
    assemble(opts) {
      return transition(true, opts?.durationMs ?? 1600);
    },
    /** Dissolve the head: dots drift outward and up and fade. */
    disperse(opts) {
      return transition(false, opts?.durationMs ?? 1100);
    },
    /**
     * Start the fly-in from a picture drawn in dots (see setStartShape above); while dispersed the dots sit on
     * it, and assemble() morphs them into the head. Null goes back to the shell (after a morph in progress).
     */
    setStartShape,
    get hasStartShape() {
      return shape.on;
    },
    setHold(v) {
      uniforms.uHold.value = Math.max(0, Math.min(1, v || 0));
    },
    setReducedMotion(on) {
      reduced = !!on;
      if (reduced) {
        offset.fill(0);
        vel.fill(0);
        isActive.fill(0);
        activeCount = 0;
      }
      applyFly();
    },
    /** Call after the driver and head pose have been updated for this frame, before render. */
    update(dtMs) {
      if (!active || disposed) return;
      if (shape.on) syncShape(dtMs);
      if (!fly.anim && gone()) {
        // nothing on stage but maybe the start picture, which needs no deform
        if (shape.on) syncProjection();
        return;
      }
      const t0 = performance.now();
      const dtSec = Math.min(0.05, Math.max(0, (dtMs || 0) / 1000));
      pose();
      scatter(dtSec);
      springs(dtSec);
      place();
      if (fly.anim) {
        measureFly();
        stepFly(dtMs);
      }
      syncProjection();
      // one-off cost report after the first few seconds
      stats.ms += performance.now() - t0;
      if (++stats.frames === 240) console.info(`[pointcloud] cpu ${(stats.ms / stats.frames).toFixed(2)} ms/frame for ${count} dots`);
    },
    dispose() {
      if (disposed) return;
      endFly(false);
      disposed = true;
      setActive(false);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onLeave);
      scene.remove(points);
      geometry.dispose();
      material.dispose();
      prepassMaterial.dispose();
    }
  };
}
