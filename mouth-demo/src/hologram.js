import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---- tuning knobs -------------------------------------------------------
export const BLOOM = { strength: 0.55, radius: 0.35, threshold: 0.45 };
const COLOR_BASE = "#FF2BA6";
const COLOR_CORE = "#FFD1EC";
const BAND_FREQ = 180; // bands per metre
const SCROLL_SPEED = 0.35; // band phase units per second (upward)
const SWING_SCROLL_BOOST = 5; // extra scroll multiplier at full swing
const SWING_RISE_MS = 250;
const SWING_SETTLE_MS = 700;
const MOUTH_EMPH = { bandMul: 1.7, dutyAdd: 0.15, brightGain: 0.6, dashFreqMul: 1.0, thresholdKeep: 0 };
const RIM_POWER = 2;
const RIPPLE = { speed: 0.35, width: 0.03, durationMs: 1300, gain: 0.5 }; // m/s, m
const GLIDE = { minGapMs: 6000, maxGapMs: 8000, firstGapMs: 3500, durationMs: 2200, width: 0.012, gain: 0.6 };
const REVEAL_EDGE = 0.025; // metres of bright leading edge
const BOTTOM_FADE = 0.06; // metres of soft fade at the lowest part of the head
const HOLD_GAIN = 0.35;
const RIM_GAIN = 0.7;
const EDGE_GAIN = 1.0;
const SOFT_CLIP = 1.4; // highlight rolloff: 1 - exp(-c * SOFT_CLIP)
const PREPASS_ORDER = -10;
const HOLO_ORDER = 1;

// per-class tuned params (hair/glasses share "sparse")
const CLASS_PARAMS = {
  full: { bandMul: 1, duty: 0.35, dashFreq: 260, threshold: 0.3, bright: 0.6, side: THREE.FrontSide, prepass: true },
  eyes: { bandMul: 1.4, duty: 0.55, dashFreq: 200, threshold: 0.12, bright: 1.0, side: THREE.FrontSide, prepass: true },
  sparse: { bandMul: 0.7, duty: 0.25, dashFreq: 200, threshold: 0.55, bright: 0.25, side: THREE.DoubleSide, prepass: false }
};

const HIDDEN_RE = /body|outfit|footwear|shoe|shirt|top|bottom|cloth|jacket|pants/i;

function classify(name) {
  if (/eye/i.test(name) && !/lash|brow/i.test(name)) return "eyes";
  if (/head|teeth|tongue/i.test(name)) return "full";
  if (/hair|glasses|lash|brow|beard/i.test(name)) return "sparse";
  if (HIDDEN_RE.test(name)) return "hidden";
  return "sparse";
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
uniform vec3 uColBase;
uniform vec3 uColCore;
uniform float uBandFreq;
uniform float uDuty;
uniform float uDashFreq;
uniform float uDashThresh;
uniform float uBright;
varying vec3 vRestPos;
varying vec3 vHNormal;
varying vec3 vViewPos;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
`;

const FRAG_BODY = /* glsl */ `
vec3 outgoingLight;
{
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

  float bf = uBandFreq * (1.0 + (${MOUTH_EMPH.bandMul.toFixed(2)} - 1.0) * m);
  float phase = y * bf - uPhase;
  float bi = floor(phase);
  float bfrac = phase - bi;
  float duty = uDuty + ${MOUTH_EMPH.dutyAdd.toFixed(2)} * m + 0.15 * rim;
  duty = min(duty, 0.9);
  float alias = step(0.5, fwidth(phase)); // bands finer than ~2 px: fill at average coverage instead of noise
  if (alias < 0.5 && bfrac > duty) discard;

  float df = uDashFreq * (1.0 + (${MOUTH_EMPH.dashFreqMul.toFixed(2)} - 1.0) * m);
  float u = vRestPos.x + 0.8 * vRestPos.z;
  float su = u * df;
  float seg = floor(su);
  float h = hash21(vec2(seg, bi));
  float h2 = hash21(vec2(bi, 7.3));
  float thr = uDashThresh * (1.0 - (1.0 - ${MOUTH_EMPH.thresholdKeep.toFixed(2)}) * m);
  thr += 0.12 * uShimmer * sin(uTime * 0.7 + h2 * 6.2831);
  thr -= 0.25 * ripple;
  if (alias < 0.5 && h < thr) discard;

  // capsule shape inside the kept segment: rounded dash ends read as dots
  float T = duty / bf;
  float L = mix(1.0 / df, 10.0, m); // solid lines (no dash caps) inside the mouth
  vec2 p = vec2((fract(su) - 0.5) * min(L, 1.0 / df), (bfrac / duty - 0.5) * T);
  float hl = max(L * 0.5 - T * 0.5, 0.0);
  float d = length(vec2(max(abs(p.x) - hl, 0.0), p.y));
  float fw = fwidth(d) + 1e-6;
  float a = 1.0 - smoothstep(T * 0.5 - fw, T * 0.5 + fw, d);
  a = mix(a, min(duty * 1.5, 0.75), alias);
  if (a < 0.02) discard;

  float edge = smoothstep(uReveal - ${REVEAL_EDGE.toFixed(3)}, uReveal, y);
  float gl = (y - uGlideY) / ${GLIDE.width.toFixed(3)};
  float glide = exp(-gl * gl) * (1.0 - smoothstep(0.0, 0.01, uHold));
  float hold = uHold * m;

  float heat = rim * 0.6 + m * 0.1 + ripple * 0.5 + glide * 0.6 + edge + hold * 0.15;
  float gain = 1.0 + rim * ${RIM_GAIN.toFixed(2)} + m * ${MOUTH_EMPH.brightGain.toFixed(2)} + ripple * ${RIPPLE.gain.toFixed(2)}
    + glide * ${GLIDE.gain.toFixed(2)} + edge * ${EDGE_GAIN.toFixed(2)} + hold * ${HOLD_GAIN.toFixed(2)};
  float fade = smoothstep(uFade.x, uFade.y, y);

  outgoingLight = mix(uColBase, uColCore, clamp(heat, 0.0, 1.0)) * uBright * gain * fade;
  outgoingLight = (vec3(1.0) - exp(-outgoingLight * ${SOFT_CLIP.toFixed(2)})) * 0.9;
  diffuseColor.a = a;
}
`;

function patchShader(shader, uniforms, misses) {
  Object.assign(shader.uniforms, uniforms);
  let v = shader.vertexShader;
  // meshbasic only builds normals for skinning/envmap; always build them for the rim
  v = rep(v, "#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )", "#if 1", "vert:normal-block", misses);
  v = rep(v, "#include <morphtarget_pars_vertex>", "#include <morphtarget_pars_vertex>\n" + VERT_PARS, "vert:pars", misses);
  v = rep(v, "#include <morphtarget_vertex>", "#include <morphtarget_vertex>\nvRestPos = transformed;", "vert:restpos", misses);
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
    uColBase: { value: new THREE.Color(COLOR_BASE) },
    uColCore: { value: new THREE.Color(COLOR_CORE) }
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
    if (/head/i.test(e.mesh.name) && !/hair/i.test(e.mesh.name)) headMinY = Math.min(headMinY, b.min.y);
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
  const materials = {};
  function getMaterial(cls) {
    if (materials[cls]) return materials[cls];
    const p = CLASS_PARAMS[cls];
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: p.side,
      fog: false,
      toneMapped: false
    });
    const own = {
      uBandFreq: { value: BAND_FREQ * p.bandMul },
      uDuty: { value: p.duty },
      uDashFreq: { value: p.dashFreq },
      uDashThresh: { value: p.threshold },
      uBright: { value: p.bright }
    };
    mat.onBeforeCompile = (shader) => {
      const misses = [];
      patchShader(shader, { ...shared, ...own }, misses);
      if (misses.length) console.warn("[hologram] shader injection missed:", misses.join(", "));
    };
    mat.customProgramCacheKey = () => "hologram-v1";
    mat.userData.hologramClass = cls;
    materials[cls] = mat;
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
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
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
      m.material = getMaterial(e.cls);
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
      for (const k of Object.keys(materials)) materials[k].dispose();
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
