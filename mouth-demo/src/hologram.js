import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---- tuning knobs -------------------------------------------------------
const USE_BLOOM = false; // light theme renders straight, no bloom
export const BLOOM = { strength: 0.55, radius: 0.35, threshold: 0.45 };
const COLOR_NAVY = "#203E68";
const COLOR_HALO = "#CBD7E6";
const SCROLL_SPEED = 0.8; // row phase units per second (upward drift of the dot grid)
const SWING_SCROLL_BOOST = 5; // extra scroll multiplier at full swing
const SWING_RISE_MS = 250;
const SWING_SETTLE_MS = 700;
const COL_PER_ROW = 0.9; // columns per row frequency (hex-like stagger)
const MOUTH_EMPH = { rowMul: 1.2, radius: 0.44, opacity: 1.0, coverCap: 0.95 }; // denser, larger, opaque, no dropout
const RIM_POWER = 2;
const RIM_RADIUS = 0.1; // extra dot radius at silhouettes
const RIM_OPACITY = 0.15;
const BREATH = 0.1; // dot radius shimmer
const RIPPLE = { speed: 0.35, width: 0.03, durationMs: 1300, swell: 0.2 }; // m/s, m
const GLIDE = { minGapMs: 6000, maxGapMs: 8000, firstGapMs: 3500, durationMs: 2200, width: 0.012, swell: 0.18 };
const REVEAL_EDGE = 0.025; // metres of enlarged leading-edge dots
const EDGE_SWELL = 0.22;
const BOTTOM_FADE = 0.06; // metres of soft fade at the lowest part of the head
const HOLD_SWELL = 0.1;
const ALIAS_FROM = 0.5; // fwidth(row phase) where dots blend to average coverage
const ALIAS_TO = 0.8;
const HEAD_RADIUS = 0.09; // metres, cylindrical column coordinate around the head axis
const PREPASS_OFFSET = { factor: 2, units: 4 };
const LIP = { targets: ["mouthPucker", "mouthFunnel"], lo: 0.4, hi: 0.7, radial: 0.35, radius: 0.5, darken: 0.2, line: 0.9 };
const TEX = { rMax: 0.55, rMin: 0.22, l0: 0.25, l1: 1.0, lipLo: 0.45, lipHi: 0.6, morphW: 0.0, cavityR: 0.1, cavityDark: 0.05 };
const DEBUG_VIEW = 0; // 1: lip mask, 2: luminance
const LIP_TEETH = false; // teeth get no lip weight
const PREPASS_ORDER = -10;
const HOLO_ORDER = 1;

// per-class params: rowFreq = dot rows per metre, radius in row-pitch units
const CLASS_PARAMS = {
  full: { rowFreq: 340, radius: 0.38, opacity: 0.92, dropout: 0.06, side: THREE.FrontSide, prepass: true },
  eyes: { rowFreq: 400, radius: 0.46, opacity: 1.0, dropout: 0.0, side: THREE.FrontSide, prepass: true }
};

const HIDDEN_RE = /body|outfit|footwear|shoe|shirt|top|bottom|cloth|jacket|pants/i;

function classify(name) {
  if (/eye/i.test(name) && !/lash|brow/i.test(name)) return "eyes";
  if (/head|teeth|tongue/i.test(name)) return "full";
  if (/hair|glasses|lash|brow|beard/i.test(name)) return "hidden";
  if (HIDDEN_RE.test(name)) return "hidden";
  return "hidden";
}

function rep(src, from, to, label, misses) {
  if (!src.includes(from)) {
    misses.push(label);
    return src;
  }
  return src.replace(from, to);
}

const VERT_PARS = /* glsl */ `
varying vec3 vRestPos;
varying vec3 vHNormal;
varying vec3 vViewPos;
attribute float aLip;
varying float vLip;
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uPhase;
uniform float uShimmer;
uniform vec3 uMouthCenter;
uniform float uMouthRadius;
uniform float uRippleTime;
uniform float uReveal;
uniform vec2 uFade;
uniform float uGlideY;
uniform float uHold;
uniform vec3 uColNavy;
uniform vec3 uColHalo;
uniform float uRowFreq;
uniform float uRadius;
uniform float uOpacity;
uniform float uDropout;
uniform vec2 uCylC;
varying vec3 vRestPos;
varying vec3 vHNormal;
varying vec3 vViewPos;
varying float vLip;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// one dot lattice with a constant row frequency (so fwidth only reflects real surface slope)
void dotLattice(float rf, float R0, float dropout, float swell, float coverCap, out float a, out float shade, out float spec) {
  float phase = vRestPos.y * rf - uPhase;
  float row = floor(phase);
  float fy = fract(phase) - 0.5;
  // columns wrap around the head's vertical axis; whole column count per turn hides the seam at the back
  float circ = 6.2831853 * ${HEAD_RADIUS.toFixed(3)};
  float cf = max(floor(circ * rf * ${COL_PER_ROW.toFixed(2)}), 1.0) / circ;
  float u = atan(vRestPos.x - uCylC.x, vRestPos.z - uCylC.y) * ${HEAD_RADIUS.toFixed(3)};
  float su = u * cf + 0.5 * mod(row, 2.0);
  float col = floor(su);
  float fx = fract(su) - 0.5;
  vec2 q = vec2(fx * rf / cf, fy); // units of row pitch

  float h = hash21(vec2(col, row));
  float breath = 1.0 + ${BREATH.toFixed(2)} * uShimmer * sin(uTime * 1.1 + h * 6.2831);
  float R = min(R0 * breath + swell, 0.56);

  float d = length(q);
  float fw = fwidth(d) + 1e-5;
  a = 1.0 - smoothstep(R - fw, R + fw, d);
  if (h < dropout) a = 0.0;
  // dots finer than a few pixels: average coverage instead of noise
  float alias = smoothstep(${ALIAS_FROM.toFixed(2)}, ${ALIAS_TO.toFixed(2)}, fwidth(phase));
  float cover = clamp(3.14159 * R * R * 1.6, 0.0, coverCap);
  a = mix(a, cover, alias);

  // fake sphere: lit from upper left, darker toward the edge
  float rr2 = clamp(d / R, 0.0, 1.0);
  vec3 sn = vec3(q / R, sqrt(max(1.0 - rr2 * rr2, 0.0)));
  float lit = clamp(dot(sn, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  shade = mix(mix(0.55, 1.15, lit), 1.0, alias);
  spec = 0.35 * pow(lit, 10.0) * (1.0 - alias);
}
`;

const FRAG_BODY = /* glsl */ `
vec3 outgoingLight;
{
  vec3 tex = diffuseColor.rgb; // avatar diffuse (linear), sampled by map_fragment
  float y = vRestPos.y;
  if (y > uReveal) discard;

  float dMouth = distance(vRestPos, uMouthCenter);
  float m = 1.0 - smoothstep(uMouthRadius * 0.8, uMouthRadius * 1.25, dMouth);

  vec3 nrm = normalize(vHNormal);
  float rim = pow(1.0 - abs(dot(nrm, normalize(vViewPos))), ${RIM_POWER.toFixed(1)});

  float ripple = 0.0;
  if (uRippleTime >= 0.0) {
    float rr = uRippleTime * ${RIPPLE.speed.toFixed(3)};
    float k = (dMouth - rr) / ${RIPPLE.width.toFixed(3)};
    float life = 1.0 - smoothstep(${(RIPPLE.durationMs * 0.0004).toFixed(3)}, ${(RIPPLE.durationMs * 0.001).toFixed(3)}, uRippleTime);
    ripple = exp(-k * k) * life;
  }
  float edge = smoothstep(uReveal - ${REVEAL_EDGE.toFixed(3)}, uReveal, y);
  float gl = (y - uGlideY) / ${GLIDE.width.toFixed(3)};
  float glide = exp(-gl * gl) * (1.0 - smoothstep(0.0, 0.01, uHold));

  float swell = rim * ${RIM_RADIUS.toFixed(2)} + ripple * ${RIPPLE.swell.toFixed(2)} + glide * ${GLIDE.swell.toFixed(2)}
    + edge * ${EDGE_SWELL.toFixed(2)};
  float drop = max(uDropout * (1.0 - rim) - 0.12 * ripple, 0.0);

  float aB, shB, spB, aM, shM, spM;
  // halftone: darker texture -> bigger dots; red (lips) -> mouth emphasis
  float lum = sqrt(max(dot(tex, vec3(0.2126, 0.7152, 0.0722)), 0.0));
  float redness = (tex.r - max(tex.g, tex.b)) / (tex.r + 0.02); // chroma ratio: lips ~0.8, skin ~0.5
  float L = max(smoothstep(${TEX.lipLo.toFixed(2)}, ${TEX.lipHi.toFixed(2)}, redness), vLip * ${TEX.morphW.toFixed(2)});
  L = clamp(L, 0.0, 1.0);
  float cavity = (1.0 - smoothstep(0.0, ${TEX.cavityDark.toFixed(2)}, dot(tex, vec3(0.3333)))) * m * (1.0 - L);
  float tR = mix(${TEX.rMax.toFixed(2)}, ${TEX.rMin.toFixed(2)}, smoothstep(${TEX.l0.toFixed(2)}, ${TEX.l1.toFixed(2)}, lum)) * (uRadius / 0.38);
  tR = mix(tR, ${TEX.cavityR.toFixed(2)}, cavity);
  dotLattice(uRowFreq, tR, drop, swell, 0.7, aB, shB, spB);
  dotLattice(uRowFreq * ${MOUTH_EMPH.rowMul.toFixed(2)}, mix(tR, ${LIP.radius.toFixed(2)}, L), 0.0, swell + uHold * ${HOLD_SWELL.toFixed(2)}, ${MOUTH_EMPH.coverCap.toFixed(2)}, aM, shM, spM);
  float ml = clamp(max(m * ${LIP.radial.toFixed(2)} * (1.0 - cavity), L), 0.0, 1.0);
  float a = mix(aB, aM, ml);
  float shade = mix(shB, shM, ml);
  float spec = mix(spB, spM, ml);
  // thin solid contour where the lip weight crosses 0.5
  float lg = fwidth(vLip) + 1e-4;
  float line = (1.0 - smoothstep(0.6, 1.4, abs(vLip - 0.5) / lg)) * ${LIP.line.toFixed(2)};
  a = max(a, line);
  if (a < 0.02) discard;

  vec3 col3 = uColNavy * shade * (1.0 - ${LIP.darken.toFixed(2)} * L) + uColHalo * spec;
  col3 = mix(col3, uColHalo, 0.35 * edge);

  float fade = smoothstep(uFade.x, uFade.y, y);
  float op = mix(uOpacity, ${MOUTH_EMPH.opacity.toFixed(2)}, ml);
  op = min(op + rim * ${RIM_OPACITY.toFixed(2)} + 0.2 * edge, 1.0);
  outgoingLight = col3;
  if (${DEBUG_VIEW} == 1) { outgoingLight = vec3(L); a = 1.0; }
  if (${DEBUG_VIEW} == 2) { outgoingLight = vec3(lum); a = 1.0; }
  if (${DEBUG_VIEW} == 3) { outgoingLight = tex; a = 1.0; }
  diffuseColor.a = a * op * fade;
}
`;

function patchShader(shader, uniforms, misses) {
  Object.assign(shader.uniforms, uniforms);
  let v = shader.vertexShader;
  // meshbasic only builds normals for skinning/envmap; always build them for the rim
  v = rep(v, "#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )", "#if 1", "vert:normal-block", misses);
  v = rep(v, "#include <morphtarget_pars_vertex>", "#include <morphtarget_pars_vertex>\n" + VERT_PARS, "vert:pars", misses);
  v = rep(v, "#include <morphtarget_vertex>", "#include <morphtarget_vertex>\nvRestPos = transformed;\nvLip = aLip;", "vert:restpos", misses);
  v = rep(
    v,
    "#include <project_vertex>",
    "#include <project_vertex>\nvHNormal = normalize(transformedNormal);\nvViewPos = -mvPosition.xyz;",
    "vert:view",
    misses
  );
  shader.vertexShader = v;

  let f = shader.fragmentShader;
  f = rep(f, "uniform float opacity;", "uniform float opacity;\n" + FRAG_PARS, "frag:pars", misses);
  f = rep(f, "vec3 outgoingLight = reflectedLight.indirectDiffuse;", FRAG_BODY, "frag:body", misses);
  shader.fragmentShader = f;
}

export function createHologram({ renderer, scene, camera, root, style = "hologram", reducedMotion = false }) {
  let currentStyle = "solid";
  let reduced = !!reducedMotion;
  let composer = null;
  let bloomPass = null;
  let disposed = false;

  // shared time-like uniforms (same { value } objects in every material)
  const shared = {
    uTime: { value: 0 },
    uPhase: { value: 0 },
    uShimmer: { value: reduced ? 0 : 1 },
    uMouthCenter: { value: new THREE.Vector3(0, 1.58, 0.1) },
    uMouthRadius: { value: 0.04 },
    uRippleTime: { value: -1 },
    uReveal: { value: 1e3 },
    uFade: { value: new THREE.Vector2(-1e3, -1e3) },
    uGlideY: { value: -1e3 },
    uHold: { value: 0 },
    uCylC: { value: new THREE.Vector2(0, 0) },
    uColNavy: { value: new THREE.Color(COLOR_NAVY) },
    uColHalo: { value: new THREE.Color(COLOR_HALO) }
  };

  // classify meshes once
  const entries = [];
  const summary = {};
  root.traverse((o) => {
    // avatar meshes are all skinned; skip helpers parented to bones (e.g. the highlight ring)
    if (!o.isSkinnedMesh) return;
    const cls = classify(o.name || "");
    summary[o.name || "(unnamed)"] = cls;
    entries.push({
      mesh: o,
      cls,
      material: o.material,
      visible: o.visible,
      renderOrder: o.renderOrder,
      prepass: null
    });
  });
  console.info("[hologram] mesh classification", summary);

  function addLipAttribute(mesh, zero) {
    const g = mesh.geometry;
    if (!g || g.attributes.aLip) return;
    const n = g.attributes.position.count;
    const out = new Float32Array(n);
    const dict = mesh.morphTargetDictionary || {};
    const morphs = g.morphAttributes.position || [];
    if (!zero) {
      for (const name of LIP.targets) {
        const t = morphs[dict[name]];
        if (!t) continue;
        const len = new Float32Array(n);
        const nz = [];
        for (let i = 0; i < n; i++) {
          let dx = t.getX(i);
          let dy = t.getY(i);
          let dz = t.getZ(i);
          if (!g.morphTargetsRelative) {
            dx -= g.attributes.position.getX(i);
            dy -= g.attributes.position.getY(i);
            dz -= g.attributes.position.getZ(i);
          }
          len[i] = Math.hypot(dx, dy, dz);
          if (len[i] > 1e-6) nz.push(len[i]);
        }
        if (!nz.length) continue;
        nz.sort((a, b) => a - b);
        const p95 = nz[Math.floor(nz.length * 0.95)] || nz[nz.length - 1];
        for (let i = 0; i < n; i++) out[i] = Math.max(out[i], Math.min(len[i] / p95, 1));
      }
      for (let i = 0; i < n; i++) out[i] = THREE.MathUtils.smoothstep(out[i], LIP.lo, LIP.hi);
    }
    g.setAttribute("aLip", new THREE.BufferAttribute(out, 1));
  }
  for (const e of entries) {
    if (e.cls === "full") addLipAttribute(e.mesh, /teeth/i.test(e.mesh.name) && !LIP_TEETH);
  }

  // reveal range from geometry bounds (rest space)
  let minY = Infinity;
  let maxY = -Infinity;
  let headMinY = Infinity;
  for (const e of entries) {
    if (e.cls === "hidden") continue;
    const g = e.mesh.geometry;
    if (!g) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    if (/head/i.test(e.mesh.name) && !/hair/i.test(e.mesh.name)) {
      headMinY = Math.min(headMinY, b.min.y);
      shared.uCylC.value.set((b.min.x + b.max.x) / 2, b.min.z + HEAD_RADIUS + 0.02);
    }
    minY = Math.min(minY, b.min.y);
    maxY = Math.max(maxY, b.max.y);
  }
  if (!isFinite(minY)) {
    minY = 1.4;
    maxY = 1.9;
  }
  if (isFinite(headMinY)) minY = headMinY;
  shared.uFade.value.set(minY, minY + BOTTOM_FADE);

  // hologram materials: one per class, created lazily, reused across style switches
  const materials = new Map();
  function getMaterial(e) {
    const cls = e.cls;
    if (materials.has(e)) return materials.get(e);
    const p = CLASS_PARAMS[cls];
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: (e.material && e.material.map) || null,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: p.side,
      fog: false,
      toneMapped: false
    });
    const own = {
      uRowFreq: { value: p.rowFreq },
      uRadius: { value: p.radius },
      uOpacity: { value: p.opacity },
      uDropout: { value: p.dropout }
    };
    mat.onBeforeCompile = (shader) => {
      const misses = [];
      patchShader(shader, { ...shared, ...own }, misses);
      if (misses.length) console.warn("[hologram] shader injection missed:", misses.join(", "));
    };
    mat.customProgramCacheKey = () => "hologram-v5";
    mat.userData.hologramClass = cls;
    materials.set(e, mat);
    return mat;
  }

  let prepassMaterial = null;
  function getPrepassMaterial() {
    if (!prepassMaterial) {
      prepassMaterial = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: PREPASS_OFFSET.factor,
        polygonOffsetUnits: PREPASS_OFFSET.units
      });
    }
    return prepassMaterial;
  }

  function makePrepass(e) {
    const m = e.mesh;
    let pm;
    if (m.isSkinnedMesh) {
      pm = new THREE.SkinnedMesh(m.geometry, getPrepassMaterial());
      pm.bindMode = m.bindMode;
      pm.bind(m.skeleton, m.bindMatrix);
    } else {
      pm = new THREE.Mesh(m.geometry, getPrepassMaterial());
    }
    pm.name = m.name + "_prepass";
    pm.frustumCulled = false;
    pm.renderOrder = PREPASS_ORDER;
    pm.matrixAutoUpdate = true;
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

  function applyHologram() {
    for (const e of entries) {
      const m = e.mesh;
      if (e.cls === "hidden") {
        m.visible = false;
        continue;
      }
      m.material = getMaterial(e);
      m.renderOrder = HOLO_ORDER;
      if (CLASS_PARAMS[e.cls].prepass && m.parent) {
        if (!e.prepass) e.prepass = makePrepass(e);
        syncPrepass(e);
        e.prepass.visible = e.visible;
        if (e.prepass.parent !== m.parent) m.parent.add(e.prepass);
      }
    }
  }

  function restoreOriginals() {
    for (const e of entries) {
      e.mesh.material = e.material;
      e.mesh.visible = e.visible;
      e.mesh.renderOrder = e.renderOrder;
      if (e.prepass && e.prepass.parent) e.prepass.parent.remove(e.prepass);
    }
  }

  function ensureComposer() {
    if (composer) return;
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    const size = renderer.getSize(new THREE.Vector2());
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(size.clone(), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  // ---- effect state (all driven by update(scaledDtMs)) ----
  let matT = 0;
  let matDur = 0;
  let materializing = false;
  let rippleT = -1;
  let glideT = -1;
  let glideWait = GLIDE.firstGapMs;
  let swingTarget = 0;
  let swingAmt = 0;

  function fullyRevealed() {
    shared.uReveal.value = 1e3;
    materializing = false;
  }

  function setStyle(s) {
    if (s === currentStyle || disposed) return;
    if (s === "hologram") {
      applyHologram();
      currentStyle = "hologram";
    } else {
      restoreOriginals();
      currentStyle = "solid";
    }
  }

  const api = {
    get style() {
      return currentStyle;
    },
    setStyle,
    setMouth(center, radius) {
      shared.uMouthCenter.value.copy(center);
      if (radius > 0) shared.uMouthRadius.value = radius;
    },
    materialize(durationMs = 1200) {
      if (reduced || durationMs <= 0) {
        fullyRevealed();
        return;
      }
      materializing = true;
      matT = 0;
      matDur = durationMs;
      shared.uReveal.value = minY - REVEAL_EDGE;
    },
    triggerRipple() {
      if (reduced) return;
      rippleT = 0;
      shared.uRippleTime.value = 0;
    },
    setHold(v) {
      shared.uHold.value = Math.max(0, Math.min(1, v || 0));
    },
    setSwing(on) {
      swingTarget = on ? 1 : 0;
    },
    setReducedMotion(on) {
      reduced = !!on;
      shared.uShimmer.value = reduced ? 0 : 1;
      if (reduced) {
        rippleT = -1;
        shared.uRippleTime.value = -1;
        glideT = -1;
        shared.uGlideY.value = -1e3;
        swingAmt = 0;
        if (materializing) fullyRevealed();
      }
    },
    update(dtMs) {
      const dt = Math.max(0, dtMs || 0);
      shared.uTime.value += dt / 1000;

      if (!reduced) {
        const tau = swingTarget > swingAmt ? SWING_RISE_MS : SWING_SETTLE_MS;
        swingAmt += (swingTarget - swingAmt) * (1 - Math.exp(-dt / tau));
        shared.uPhase.value += (dt / 1000) * SCROLL_SPEED * (1 + SWING_SCROLL_BOOST * swingAmt);
      }

      if (materializing) {
        matT += dt;
        const k = Math.min(1, matT / matDur);
        const e = k * k * (3 - 2 * k);
        shared.uReveal.value = minY - REVEAL_EDGE + (maxY - minY + REVEAL_EDGE * 2) * e;
        if (k >= 1) fullyRevealed();
      }

      if (rippleT >= 0) {
        rippleT += dt;
        if (rippleT >= RIPPLE.durationMs) {
          rippleT = -1;
          shared.uRippleTime.value = -1;
        } else {
          shared.uRippleTime.value = rippleT / 1000;
        }
      }

      if (!reduced) {
        if (glideT >= 0) {
          glideT += dt;
          if (glideT >= GLIDE.durationMs) {
            glideT = -1;
            shared.uGlideY.value = -1e3;
          } else {
            shared.uGlideY.value = minY + (maxY - minY) * (glideT / GLIDE.durationMs);
          }
        } else if (!materializing && shared.uHold.value <= 0.01) {
          glideWait -= dt;
          if (glideWait <= 0) {
            glideT = 0;
            glideWait = GLIDE.minGapMs + Math.random() * (GLIDE.maxGapMs - GLIDE.minGapMs);
          }
        }
      }
    },
    render() {
      if (currentStyle === "hologram") {
        for (const e of entries) {
          if (e.prepass) syncPrepass(e);
        }
      }
      if (USE_BLOOM && currentStyle === "hologram") {
        ensureComposer();
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    },
    setSize(width, height) {
      if (!composer) return;
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    },
    dispose() {
      if (disposed) return;
      restoreOriginals();
      currentStyle = "solid";
      disposed = true;
      for (const e of entries) e.prepass = null;
      for (const mt of materials.values()) mt.dispose();
      if (prepassMaterial) prepassMaterial.dispose();
      if (composer) {
        for (const p of composer.passes) if (p.dispose) p.dispose();
        composer.dispose();
        composer = null;
      }
    }
  };

  if (reduced) fullyRevealed();
  if (style === "hologram") setStyle("hologram");
  return api;
}
