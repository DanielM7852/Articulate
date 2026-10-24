import * as THREE from "three";
import { classify } from "./hologram.js";

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
const COLOR_NAVY = "#203E68";
const COLOR_HALO = "#CBD7E6";
const COLOR_GREY = "#DADFD9";

// dots per square metre of surface, by mesh class; and an overall cap
const DENSITY = { full: 230000, eyes: 360000, teeth: 260000, hair: 70000 };
const MAX_DOTS = 320000;
// Even spacing: candidates are generated at OVERSAMPLE x the density, then accepted only
// if no accepted dot lies within SPACING / sqrt(density) of them (dart throwing).
const OVERSAMPLE = 4;
const SPACING = 0.82;
const DOT = { radius: 0.00068, mouthSwell: 0.3, holdSwell: 0.25, rimSwell: 0.12, minPx: 1.5 }; // metres
const KIND = { head: 0, hair: 1, eyes: 2, teeth: 3 };
const SIZE_MUL = { full: 1, hair: 0.85, eyes: 0.8, teeth: 0.8 };
const MOUTH_RADIUS_MUL = 1.6;
const BOTTOM_FADE = 0.06; // metres of soft fade at the lowest part of the head
const HAIR_FADE = 0.08; // metres above the head bottom: the long hair fades out
// thin the fringe in front of the forehead so the face reads (same shape as the hologram style)
const FRINGE = { zStartFrac: 0.62, band: 0.07, sideFrac: 0.75, sideSoft: 0.03, yDrop: 0.05, ySoft: 0.03, strength: 0.9 };
// pointer scatter: a spring per dot (k, c per second), pushed by an acceleration inside `radius` of the ray
const SCATTER = { radius: 0.03, push: 6, lift: 0.7, k: 70, c: 9, maxOffset: 0.05, settle: 2e-4 }; // lift: share of the push aimed back at the viewer
const PREPASS_OFFSET = { factor: 2, units: 4 };
// dot size from the skin texture: darker texels (lips, brows, nostrils) get bigger dots, like the hologram style
const TEX = { l0: 0.25, l1: 1.0, dark: 1.5, bright: 0.65, max: 1024 };

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

const VERT = /* glsl */ `
attribute vec3 aNormal;
attribute vec4 aInfo; // x: size multiplier, y: kind, z: mouth weight, w: alpha
uniform float uProj; // device pixels per metre at one metre
uniform float uRadius;
uniform float uHold;
varying float vRim;
varying float vKind;
varying float vMouth;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * aNormal);
  float facing = abs(dot(n, normalize(-mv.xyz)));
  float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 2.0);
  float r = uRadius * aInfo.x * (1.0 + ${DOT.mouthSwell.toFixed(2)} * aInfo.z + uHold * ${DOT.holdSwell.toFixed(2)} * aInfo.z + ${DOT.rimSwell.toFixed(2)} * rim);
  gl_PointSize = max(${DOT.minPx.toFixed(1)}, 2.0 * r * uProj / -mv.z);
  gl_Position = projectionMatrix * mv;
  vRim = rim;
  vKind = aInfo.y;
  vMouth = aInfo.z;
  vAlpha = aInfo.w;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColNavy;
uniform vec3 uColHalo;
uniform vec3 uColGrey;
varying float vRim;
varying float vKind;
varying float vMouth;
varying float vAlpha;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  float cov = 1.0 - smoothstep(0.82, 1.0, d);
  if (cov < 0.02) discard;
  // each dot shaded as a tiny sphere lit from the upper left, like the hologram style
  vec3 sn = vec3(q, sqrt(max(1.0 - d * d, 0.0)));
  float lit = clamp(dot(sn, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float shade = mix(0.55, 1.15, lit);
  float spec = 0.35 * pow(lit, 10.0);
  vec3 base = uColNavy;
  if (vKind > 2.5) base = mix(uColGrey, uColNavy, 0.25);
  else if (vKind > 1.5) base = uColNavy * 0.75;
  else if (vKind > 0.5) base = uColNavy * 0.82;
  vec3 col = base * shade + uColHalo * (spec + 0.2 * vRim) + uColHalo * 0.08 * vMouth;
  gl_FragColor = vec4(col, cov * vAlpha);
  #include <colorspace_fragment>
}
`;

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

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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

export function createPointCloud({ renderer, scene, camera, canvas, root, anchor, reducedMotion = false }) {
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

  const tri = []; // [entryIndex, ia, ib, ic] flattened
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

    // 1. candidates, several per final dot, in a random order so acceptance is unbiased
    const cand = []; // [ia, ib, ic, w0, w1, w2, x, y, z] flattened
    for (let t = 0; t < triArea.length; t++) {
      const expected = triArea[t] * density * OVERSAMPLE;
      let n = Math.floor(expected);
      if (Math.random() < expected - n) n++;
      if (!n) continue;
      const ia = idx ? idx.getX(t * 3) : t * 3;
      const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
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
        cand.push(ia, ib, ic, w0, w1, w2, w0 * a.x + w1 * b.x + w2 * c.x, w0 * a.y + w1 * b.y + w2 * c.y, w0 * a.z + w1 * b.z + w2 * c.z);
      }
    }
    const nc = cand.length / 9;
    const order = new Uint32Array(nc);
    for (let i = 0; i < nc; i++) order[i] = i;
    for (let i = nc - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    // 2. dart throwing on a hash grid: keep a candidate only if nothing accepted is within rMin
    const rMin = SPACING / Math.sqrt(density);
    const r2min = rMin * rMin;
    const cell = rMin;
    const grid = new Map(); // numeric cell hash -> flat xyz list; a hash collision only costs an extra distance check
    const hash = (gx, gy, gz) => ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) | 0;
    let kept = 0;
    for (let oi = 0; oi < nc; oi++) {
      const i = order[oi] * 9;
      const x = cand[i + 6];
      const y = cand[i + 7];
      const z = cand[i + 8];
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const cz = Math.floor(z / cell);
      let free = true;
      for (let gx = cx - 1; gx <= cx + 1 && free; gx++) {
        for (let gy = cy - 1; gy <= cy + 1 && free; gy++) {
          for (let gz = cz - 1; gz <= cz + 1 && free; gz++) {
            const list = grid.get(hash(gx, gy, gz));
            if (!list) continue;
            for (let q = 0; q < list.length; q += 3) {
              const ddx = list[q] - x;
              const ddy = list[q + 1] - y;
              const ddz = list[q + 2] - z;
              if (ddx * ddx + ddy * ddy + ddz * ddz < r2min) {
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
      list.push(x, y, z);

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
      }
      tri.push(ei, cand[i], cand[i + 1], cand[i + 2]);
      bary.push(cand[i + 3], cand[i + 4], cand[i + 5]);
      info.push(size, kind, mouth, alpha);
      kept++;
    }
    perClass[e.mesh.name || e.cls] = `${e.cls}: ${kept} dots, ${nc} candidates, area ${areas.get(e).sum.toFixed(4)} m²`;
  }
  console.info("[pointcloud] sampling", perClass);
  const count = bary.length / 3;
  const triA = new Uint32Array(tri);
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
  geometry.setAttribute("aInfo", new THREE.BufferAttribute(new Float32Array(info), 4));
  const uniforms = {
    uProj: { value: 1000 },
    uRadius: { value: DOT.radius },
    uHold: { value: 0 },
    uColNavy: { value: new THREE.Color(COLOR_NAVY) },
    uColHalo: { value: new THREE.Color(COLOR_HALO) },
    uColGrey: { value: new THREE.Color(COLOR_GREY) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    alphaToCoverage: true,
    depthWrite: true,
    depthTest: true,
    fog: false
  });
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
  const pointer = { x: 0, y: 0, on: false };
  const onMove = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
    pointer.on = true;
  };
  const onLeave = () => {
    pointer.on = false;
  };
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

  function scatter(dtSec) {
    if (!pointer.on || reduced) return;
    rayO.setFromMatrixPosition(camera.matrixWorld);
    rayD.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(rayO).normalize();
    const R = SCATTER.radius;
    const R2 = R * R;
    const push = SCATTER.push * dtSec;
    const ox = rayO.x;
    const oy = rayO.y;
    const oz = rayO.z;
    const dx = rayD.x;
    const dy = rayD.y;
    const dz = rayD.z;
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
      if (d2 >= R2) continue;
      const d = Math.sqrt(d2);
      const f = 1 - d / R;
      const g = (push * f * f) / Math.max(d, 1e-4);
      const lift = push * f * f * SCATTER.lift;
      // outward from the ray, and back toward the viewer so the burst reads in depth
      vel[i * 3] += px * g - dx * lift;
      vel[i * 3 + 1] += py * g - dy * lift;
      vel[i * 3 + 2] += pz * g - dz * lift;
      activate(i);
    }
  }

  function springs(dtSec) {
    if (!activeCount) return;
    const k = SCATTER.k;
    const c = SCATTER.c;
    const max = SCATTER.maxOffset;
    let w = 0;
    for (let a = 0; a < activeCount; a++) {
      const i = activeIdx[a];
      let settled = true;
      for (let j = 0; j < 3; j++) {
        const o = offset[i * 3 + j];
        let v = vel[i * 3 + j];
        v += (-k * o - c * v) * dtSec;
        let no = o + v * dtSec;
        if (no > max) no = max;
        else if (no < -max) no = -max;
        offset[i * 3 + j] = no;
        vel[i * 3 + j] = v;
        if (Math.abs(no) > SCATTER.settle || Math.abs(v) > SCATTER.settle * 20) settled = false;
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
    for (let i = 0; i < count; i++) {
      const ei = triA[i * 4];
      const out = entries[ei].deformer.out;
      const ia = triA[i * 4 + 1] * 3;
      const ib = triA[i * 4 + 2] * 3;
      const ic = triA[i * 4 + 3] * 3;
      const w0 = baryA[i * 3];
      const w1 = baryA[i * 3 + 1];
      const w2 = baryA[i * 3 + 2];
      const ax = out[ia];
      const ay = out[ia + 1];
      const az = out[ia + 2];
      const ux = out[ib] - ax;
      const uy = out[ib + 1] - ay;
      const uz = out[ib + 2] - az;
      const vx = out[ic] - ax;
      const vy = out[ic + 1] - ay;
      const vz = out[ic + 2] - az;
      positions[i * 3] = ax + w1 * ux + w2 * vx + offset[i * 3];
      positions[i * 3 + 1] = ay + w1 * uy + w2 * vy + offset[i * 3 + 1];
      positions[i * 3 + 2] = az + w1 * uz + w2 * vz + offset[i * 3 + 2];
      // face normal of the deformed triangle
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
      void w0;
    }
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
  }

  function setActive(on) {
    if (disposed) return;
    active = !!on;
    points.visible = active;
    for (const h of hidden) h.mesh.visible = active ? false : h.visible;
    for (const e of entries) {
      if (active) {
        // Hair cards are thin and partly thinned out, so they do not occlude; the head does.
        if (e.cls !== "hair") {
          if (!e.prepass) e.prepass = makePrepass(e);
          syncPrepass(e);
          if (e.mesh.parent && e.prepass.parent !== e.mesh.parent) e.mesh.parent.add(e.prepass);
          e.prepass.visible = e.visible;
        }
        e.mesh.visible = false;
      } else {
        if (e.prepass?.parent) e.prepass.parent.remove(e.prepass);
        e.mesh.visible = e.visible;
      }
    }
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
    },
    /** Call after the driver and head pose have been updated for this frame, before render. */
    update(dtMs) {
      if (!active || disposed) return;
      const t0 = performance.now();
      const dtSec = Math.min(0.05, Math.max(0, (dtMs || 0) / 1000));
      root.updateMatrixWorld(true);
      for (const sk of skeletons) sk.update();
      for (const e of entries) {
        e.deformer.update();
        if (e.prepass) syncPrepass(e);
      }
      scatter(dtSec);
      springs(dtSec);
      place();
      renderer.getDrawingBufferSize(size);
      uniforms.uProj.value = size.y / 2 / Math.tan(THREE.MathUtils.degToRad((camera.fov || 30) / 2));
      // one-off cost report after the first few seconds
      stats.ms += performance.now() - t0;
      if (++stats.frames === 240) console.info(`[pointcloud] cpu ${(stats.ms / stats.frames).toFixed(2)} ms/frame for ${count} dots`);
    },
    dispose() {
      if (disposed) return;
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
