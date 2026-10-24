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
const COLOR_GREY = "#DADFD9";
const SCROLL_SPEED = 0.22; // row phase units per second (upward drift of the dot grid): slow enough to read as alive, not as motion
const SWING_SCROLL_BOOST = 2; // extra scroll multiplier at full swing
const SWING_RISE_MS = 250;
const SWING_SETTLE_MS = 700;
const COL_PER_ROW = 0.9; // columns per row frequency (hex-like stagger)
const MOUTH_EMPH = { rowMul: 1.2, radius: 0.44, opacity: 1.0, coverCap: 0.95 }; // denser, larger, opaque, no dropout
const RIM_POWER = 2;
const RIM_RADIUS = 0.1; // extra dot radius at silhouettes
const RIM_OPACITY = 0.15;
const BREATH = 0.035; // dot radius shimmer (kept faint so the lattice holds still)
const RIPPLE = { speed: 0.35, width: 0.03, durationMs: 1300, swell: 0.12 }; // m/s, m
const GLIDE = { minGapMs: 14000, maxGapMs: 22000, firstGapMs: 6000, durationMs: 2600, width: 0.012, swell: 0.08 }; // a rare, faint scan line
const REVEAL_EDGE = 0.025; // metres of enlarged leading-edge dots
const EDGE_SWELL = 0.22;
const BOTTOM_FADE = 0.06; // metres of soft fade at the lowest part of the head
const HOLD_SWELL = 0.1;
const ALIAS_FROM = 0.5; // fwidth(row phase) where dots blend to average coverage
const ALIAS_TO = 0.8;
const HEAD_RADIUS = 0.09; // metres, cylindrical column coordinate around the head axis
const PREPASS_OFFSET = { factor: 2, units: 4 };
const LIP = { targets: ["mouthPucker", "mouthFunnel"], lo: 0.4, hi: 0.7, radial: 0.35, radius: 0.5, darken: 0.2 };
const TEX = { rMax: 0.55, rMin: 0.22, l0: 0.25, l1: 1.0, lipLo: 0.45, lipHi: 0.6, morphW: 0.0, cavityR: 0.1, cavityDark: 0.05 };
const INTERIOR = { lumLo: 0.42, lumHi: 0.56, dark: 0.6 }; // mouth interior on the head: sqrt-luminance ramp, navy multiplier
const TEETH = { lumLo: 0.55, lumHi: 0.7, redLo: 0.3, redHi: 0.5, shade: 0.5 }; // teeth texel = bright and low chroma
const DEBUG_VIEW = 0; // 1: lip mask, 2: luminance, 3: texture, 4: redness/lum, 5: interior/teeth
const LIP_TEETH = false; // teeth get no lip weight
// hair: the avatar's long fringed style is restyled in the shader (hologram style only)
const HAIR = { rowFreq: 300, radius: 0.54, opacity: 0.95, radiusLo: 0.92, coverCap: 0.85, rimHalo: 0.0 }; // dense, near-merging dark mass; radiusLo = bright-texel radius multiplier
const HAIR_CUT = {
  frontFrac: 0.45, // fringe cut starts this fraction of the way from the head's back to its front (rest-space z)
  sideFrac: 1.0, // fringe cut spans |x| < this * head half-width (hair outside that frames the face)
  hairlineDrop: 0.065, // metres below the crown: hair above this line stays over the top of the head
  soft: 0.016, // metres of soft edge on the cut
  scalpLift: 0.004, // metres: forehead hairline of the scalp cap sits this far above the fringe cut line
  temple: 0.05, // metres the scalp hairline drops at the temples (|x| from 0.045 to 0.085)
  nape: 0.07, // metres the scalp hairline drops behind the ears
  lenLo: 0.19, // metres above the head mesh bottom (neck base; chin is ~0.07) where the hair is gone
  lenHi: 0.23 // metres above the head mesh bottom where the hair is fully visible (short bob, ~ear/jaw-angle level)
};
// hair mode (hologram style only): "cap" = hair cards hidden, short crop painted on the scalp;
// "full" = original Wolf3D_Hair cards uncut; "trim" = cards cut (fringe/length) + scalp cap. Override with ?hair=...
const HAIR_MODE = (() => {
  try {
    const q = new URLSearchParams(location.search).get("hair");
    if (q === "cap" || q === "full" || q === "trim") return q;
  } catch (e) {
    /* no location */
  }
  return "full";
})();
const HAIR_CAP = {
  hairlineDrop: 0.085, // metres below the crown (note: GLB accessor bounds are stale; measured head bounds are 1.394..1.782): forehead hairline about 4 cm above the brows
  soft: 0.011, // metres: soft hairline edge (about 1 cm)
  temple: 0.045, // metres the hairline drops at the temples (|x| from 0.045 to 0.085), to just above/in front of the ears
  nape: 0.17, // metres the hairline drops behind the ears, down to the nape
  fill: 0.8 // minimum dot coverage inside the cap (near-merging, full navy)
};
// "full" mode fringe thinning: a wide soft attenuation (no cut) of the hair in front of the forehead
const HAIR_FRINGE = {
  zStartFrac: 0.62, // thinning begins this fraction of the way from the head's back to its front (rest-space z)
  band: 0.07, // metres over which thinning ramps up toward the front (tips of the fringe thin the most)
  sideFrac: 0.75, // |x| < this * head half-width (soft edge); hair framing the face stays
  sideSoft: 0.03, // metres of soft edge at the sides
  yDrop: 0.05, // metres below the crown: fringe region is below this line (hair above stays over the top of the head)
  ySoft: 0.03, // metres of soft edge on the y line
  strength: 0.9 // maximum attenuation at the tips (keep -> 1 - strength)
};
const HAIR_FULL = { fadeLo: 0.0, fadeHi: 0.08 }; // metres above the head mesh bottom (end of the visible neck): soft fade of the long hair
const PREPASS_ORDER = -10;
const HOLO_ORDER = 1;

// per-class params: rowFreq = dot rows per metre, radius in row-pitch units
const CLASS_PARAMS = {
  teeth: { rowFreq: 340, radius: 0.38, opacity: 0.92, dropout: 0.0, side: THREE.FrontSide, prepass: true },
  full: { rowFreq: 340, radius: 0.38, opacity: 0.92, dropout: 0.0, side: THREE.FrontSide, prepass: true },
  hair: { rowFreq: HAIR.rowFreq, radius: HAIR.radius, opacity: HAIR.opacity, dropout: 0.0, side: THREE.FrontSide, prepass: true },
  eyes: { rowFreq: 400, radius: 0.46, opacity: 1.0, dropout: 0.0, side: THREE.FrontSide, prepass: true }
};

const HIDDEN_RE = /body|outfit|footwear|shoe|shirt|top|bottom|cloth|jacket|pants/i;

function classify(name) {
  if (/eye/i.test(name) && !/lash|brow/i.test(name)) return "eyes";
  if (/teeth/i.test(name)) return "teeth";
  if (/head|tongue/i.test(name)) return "full";
  if (/hair/i.test(name)) return "hair";
  if (/glasses|lash|brow|beard/i.test(name)) return "hidden";
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

// hair cut/trim mask in rest space (shared by the hologram and the hair depth prepass)
const HAIR_FN = /* glsl */ `
uniform vec4 uHairCut; // zFront, xSide, yLine, soft
uniform vec4 uFringe; // zStart, xHalf, yLine, strength
uniform vec3 uFringeW; // z band, x soft, y soft
uniform vec2 uHairLen; // y where hair is gone, y where hair is fully visible
uniform vec4 uCap; // hairline y at the forehead centre, soft, temple drop, nape drop
// scalp cap: the head mesh itself is drawn as dense dark hair dots above a soft hairline (dropping at the temples and behind the ears)
float headHairMask(vec3 p) {
  float y0 = uCap.x
    - uCap.z * smoothstep(0.045, 0.085, abs(p.x))
    - uCap.w * (1.0 - smoothstep(-0.03, 0.0, p.z));
  return smoothstep(y0 - uCap.y, y0 + uCap.y, p.y);
}
float hairKeep(vec3 p) {
  float s = uHairCut.w;
  float front = smoothstep(uHairCut.x - s, uHairCut.x + s, p.z)
    * (1.0 - smoothstep(uHairCut.y - s, uHairCut.y + s, abs(p.x)))
    * (1.0 - smoothstep(uHairCut.z - s, uHairCut.z + s, p.y));
  // wide soft thinning of the fringe in front of the forehead (no hard edge)
  float fr = smoothstep(uFringe.x, uFringe.x + uFringeW.x, p.z)
    * (1.0 - smoothstep(uFringe.y - uFringeW.y, uFringe.y + uFringeW.y, abs(p.x)))
    * (1.0 - smoothstep(uFringe.z - uFringeW.z, uFringe.z + uFringeW.z, p.y));
  return (1.0 - front) * (1.0 - uFringe.w * fr) * smoothstep(uHairLen.x, uHairLen.y, p.y);
}
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
uniform vec2 uCylC;
uniform float uIsHair;
uniform float uHeadHair;
uniform float uKind; // 0 head/other, 1 teeth, 2 tongue
varying vec3 vRestPos;
varying vec3 vHNormal;
varying vec3 vViewPos;
varying float vLip;

${HAIR_FN}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// one dot lattice with a constant row frequency (so fwidth only reflects real surface slope)
void dotLattice(float rf, float R0, float dropout, float swell, float coverCap, float colAlias, out float a, out float shade, out float spec) {
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
  float alias = smoothstep(${ALIAS_FROM.toFixed(2)}, ${ALIAS_TO.toFixed(2)}, max(fwidth(phase), colAlias * fwidth(su) * rf / cf) * (1.0 + colAlias));
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

  float aB, shB, spB, aM, shM, spM;
  // halftone: darker texture -> bigger dots; red (lips) -> mouth emphasis
  float lum = sqrt(max(dot(tex, vec3(0.2126, 0.7152, 0.0722)), 0.0));
  float redness = (tex.r - max(tex.g, tex.b)) / (tex.r + 0.02); // chroma ratio: lips ~0.8, skin ~0.5
  float L = max(smoothstep(${TEX.lipLo.toFixed(2)}, ${TEX.lipHi.toFixed(2)}, redness), vLip * ${TEX.morphW.toFixed(2)});
  L = clamp(L, 0.0, 1.0);
  float cavity = (1.0 - smoothstep(0.0, ${TEX.cavityDark.toFixed(2)}, dot(tex, vec3(0.3333)))) * m * (1.0 - L);
  float tR = mix(${TEX.rMax.toFixed(2)}, ${TEX.rMin.toFixed(2)}, smoothstep(${TEX.l0.toFixed(2)}, ${TEX.l1.toFixed(2)}, lum)) * (uRadius / 0.38);
  tR = mix(tR, ${TEX.cavityR.toFixed(2)}, cavity);
  float hk = 1.0;
  if (uIsHair > 0.5) {
    // dark hair texture: do not let the halftone balloon, keep an even small-dot texture
    tR = uRadius * mix(${HAIR.radiusLo.toFixed(2)}, 1.0, smoothstep(0.1, 0.5, lum));
    hk = hairKeep(vRestPos);
    tR *= mix(0.5, 1.0, hk);
    cavity = 0.0;
  }
  float hm = 0.0;
  if (uHeadHair > 0.5) {
    hm = headHairMask(vRestPos);
    tR = mix(tR, ${HAIR.radius.toFixed(2)}, hm);
  }
  float hairy = max(uIsHair, hm);
  dotLattice(uRowFreq, tR, 0.0, swell, mix(0.7, ${HAIR.coverCap.toFixed(2)}, hairy), hairy, aB, shB, spB);
  shB = mix(shB, 0.62, hm * (1.0 - aB)); // cap gaps: dark navy fill, no lit highlight
  spB *= 1.0 - hm;
  dotLattice(uRowFreq * ${MOUTH_EMPH.rowMul.toFixed(2)}, mix(tR, ${LIP.radius.toFixed(2)}, L), 0.0, swell + uHold * ${HOLD_SWELL.toFixed(2)}, ${MOUTH_EMPH.coverCap.toFixed(2)}, 0.0, aM, shM, spM);
  float ml = clamp(max(m * ${LIP.radial.toFixed(2)} * (1.0 - cavity), L), 0.0, 1.0);
  float a = mix(aB, aM, ml);
  a = max(a, ${HAIR_CAP.fill.toFixed(2)} * hm);
  float shade = mix(shB, shM, ml);
  float spec = mix(spB, spM, ml);
  // mouth interior (cavity/gums/tongue) = solid dark navy, teeth = solid near-white, both opaque and dot-free
  float interior = 0.0;
  float tooth = 0.0;
  if (uKind > 1.5) {
    interior = 1.0;
  } else if (uKind > 0.5) {
    tooth = smoothstep(${TEETH.lumLo.toFixed(2)}, ${TEETH.lumHi.toFixed(2)}, lum) * (1.0 - smoothstep(${TEETH.redLo.toFixed(2)}, ${TEETH.redHi.toFixed(2)}, redness));
    interior = 1.0 - tooth;
  } else {
    interior = m * (1.0 - smoothstep(${INTERIOR.lumLo.toFixed(2)}, ${INTERIOR.lumHi.toFixed(2)}, lum)) * (1.0 - L);
    interior = smoothstep(0.35, 0.65, interior);
  }
  if (uIsHair > 0.5) { interior = 0.0; a = aB * smoothstep(0.05, 0.6, hk); }
  a = mix(a, 1.0, max(interior, tooth));
  if (a < 0.02) discard;

  vec3 col3 = uColNavy * shade * (1.0 - ${LIP.darken.toFixed(2)} * L) + uColHalo * spec;
  col3 = mix(col3, uColNavy * ${INTERIOR.dark.toFixed(2)}, interior);
  col3 = mix(col3, mix(vec3(1.0), uColHalo, clamp(rim * ${TEETH.shade.toFixed(2)}, 0.0, 1.0)), tooth);
  col3 = mix(col3, uColHalo, 0.35 * edge * (1.0 - max(interior, tooth)));
  col3 = mix(col3, uColHalo, uIsHair * ${HAIR.rimHalo.toFixed(2)} * rim);
  col3 *= 1.0 - 0.3 * hm;

  float fade = smoothstep(uFade.x, uFade.y, y);
  float op = mix(uOpacity, ${MOUTH_EMPH.opacity.toFixed(2)}, ml);
  op = mix(op, 1.0, max(interior, tooth));
  op = min(op + rim * ${RIM_OPACITY.toFixed(2)} + 0.2 * edge, 1.0);
  outgoingLight = col3;
  if (${DEBUG_VIEW} == 1) { outgoingLight = vec3(L); a = 1.0; }
  if (${DEBUG_VIEW} == 2) { outgoingLight = vec3(lum); a = 1.0; }
  if (${DEBUG_VIEW} == 3) { outgoingLight = tex; a = 1.0; }
  if (${DEBUG_VIEW} == 5) { outgoingLight = vec3(interior, tooth, 0.0); a = 1.0; }
  if (${DEBUG_VIEW} == 4) { outgoingLight = vec3(redness, lum, 0.0); a = 1.0; }
  diffuseColor.a = a * op * fade;
}
`;

const PORC = {
  light: "-0.4, 0.6, 0.7", wrapOff: 0.5, wrapDiv: 1.5, rimPow: 2.4, rimMix: 0.85,
  lineFreq: 120.0, lineAlpha: 0.18, fadeNear: 0.035, fadeFar: 0.14, minAlpha: 0.2,
  lipDotRowMul: 1.4, lipDotRadius: 0.42, lipHoldSwell: 0.06
};

const PORC_PARS = /* glsl */ `
uniform float uLipDots;
uniform vec3 uColGrey;
`;

const PORC_BODY = /* glsl */ `
vec3 outgoingLight;
{
  vec3 tex = diffuseColor.rgb;
  float y = vRestPos.y;
  if (y > uReveal) discard;

  vec3 dv = vRestPos - uMouthCenter;
  float dMouth = length(dv);
  float m = 1.0 - smoothstep(uMouthRadius * 0.8, uMouthRadius * 1.25, dMouth);

  vec3 nrm = normalize(vHNormal);
  vec3 V = normalize(vViewPos);
  float ndv = abs(dot(nrm, V));
  float rim = pow(1.0 - ndv, ${PORC.rimPow.toFixed(1)});

  float lum = sqrt(max(dot(tex, vec3(0.2126, 0.7152, 0.0722)), 0.0));
  float redness = (tex.r - max(tex.g, tex.b)) / (tex.r + 0.02);
  // lip mask from a blurred (mip-biased) chroma sample, then a crisp fwidth-sized edge
  vec3 texB = texture2D(map, vMapUv, 3.5).rgb;
  float redB = (texB.r - max(texB.g, texB.b)) / (texB.r + 0.02);
  float lw = max(fwidth(redB) * 0.75, 0.015);
  float L = smoothstep(0.56 - lw, 0.56 + lw, redB);
  if (uKind > 0.5) L = 0.0;
  L *= smoothstep(0.02, 0.25, vLip);
  L *= 1.0 - smoothstep(uMouthRadius * 1.0, uMouthRadius * 1.4, dMouth); // lips live only near the mouth

  float interior = 0.0;
  float tooth = 0.0;
  if (uKind > 1.5) {
    interior = 1.0;
  } else if (uKind > 0.5) {
    tooth = smoothstep(${TEETH.lumLo.toFixed(2)}, ${TEETH.lumHi.toFixed(2)}, lum) * (1.0 - smoothstep(${TEETH.redLo.toFixed(2)}, ${TEETH.redHi.toFixed(2)}, redness));
    interior = 1.0 - tooth;
  } else {
    interior = m * (1.0 - smoothstep(${INTERIOR.lumLo.toFixed(2)}, ${INTERIOR.lumHi.toFixed(2)}, lum)) * (1.0 - L);
    interior = smoothstep(0.35, 0.65, interior) * (1.0 - smoothstep(0.016, 0.026, dv.y)); // not the nostrils
  }

  // wrapped diffuse, fixed view-space light
  float w = clamp((dot(nrm, normalize(vec3(${PORC.light}))) + ${PORC.wrapOff.toFixed(2)}) / ${PORC.wrapDiv.toFixed(2)}, 0.0, 1.0);
  vec3 shadow = mix(uColGrey, uColHalo, 0.5);
  vec3 col3 = mix(shadow, vec3(1.0), w);
  col3 = mix(col3, uColNavy, ${PORC.rimMix.toFixed(2)} * rim);

  // hairline contour isolines (constant frequency)
  float phase = vRestPos.y * ${PORC.lineFreq.toFixed(1)};
  float fwp = fwidth(phase) + 1e-5;
  float dl = abs(fract(phase + 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.25 * fwp, 0.9 * fwp + 1e-4, dl);
  line *= 1.0 - smoothstep(0.35, 0.7, fwp);
  line *= (1.0 - m) * (1.0 - L);
  col3 = mix(col3, uColNavy, line * ${PORC.lineAlpha.toFixed(2)});

  // lips: solid navy, or fine navy dots on the porcelain base
  float lipEdge = smoothstep(0.35, 0.65, L);
  float lipA = lipEdge;
  if (uLipDots > 0.5) {
    float aD, shD, spD;
    dotLattice(uRowFreq * ${PORC.lipDotRowMul.toFixed(2)}, ${PORC.lipDotRadius.toFixed(2)}, 0.0, uHold * ${PORC.lipHoldSwell.toFixed(2)}, 0.95, 0.0, aD, shD, spD);
    lipA = lipEdge * aD;
  }
  vec3 lipCol = uColNavy * mix(0.8, 1.1, w) * (1.0 - 0.18 * uHold);
  lipCol = mix(lipCol, uColNavy * 0.7, rim * uHold);
  col3 = mix(col3, lipCol, lipA);

  // interior and teeth
  col3 = mix(col3, uColNavy * ${INTERIOR.dark.toFixed(2)}, interior);
  col3 = mix(col3, mix(vec3(1.0), uColHalo, (1.0 - w) * 0.7), tooth);

  float edge = smoothstep(uReveal - ${REVEAL_EDGE.toFixed(3)}, uReveal, y);
  col3 = mix(col3, uColNavy, 0.5 * edge * (1.0 - max(interior, tooth)));

  // upper-face de-emphasis (nose/cheeks/chin stay solid)
  float up = dv.y > 0.0 ? dv.y : dv.y * 0.45;
  float dU = length(vec2(dv.x * 0.5, up));
  float op = mix(1.0, ${PORC.minAlpha.toFixed(2)}, smoothstep(${PORC.fadeNear.toFixed(2)}, ${PORC.fadeFar.toFixed(2)}, dU));
  op = max(op, rim * 0.5);
  op = max(op, max(lipEdge * step(0.5, 1.0), max(interior, tooth)));
  op = max(op, edge * 0.5);
  float fade = smoothstep(uFade.x, uFade.y, y);
  outgoingLight = col3;
  diffuseColor.a = op * fade;
  if (diffuseColor.a < 0.01) discard;
}
`;

function patchVertex(shader, misses) {
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
}

// depth-only prepass for hair: same cut/trim as the hologram so cut hair does not punch holes in the face dots
function patchHairPrepass(shader, uniforms, misses) {
  Object.assign(shader.uniforms, uniforms);
  patchVertex(shader, misses);
  let f = shader.fragmentShader;
  f = rep(f, "uniform float opacity;", "uniform float opacity;\nvarying vec3 vRestPos;\n" + HAIR_FN, "hairpre:pars", misses);
  f = rep(f, "#include <map_fragment>", "#include <map_fragment>\nif (hairKeep(vRestPos) < 0.5) discard;", "hairpre:body", misses);
  shader.fragmentShader = f;
}

function patchShader(shader, uniforms, misses, porcelain) {
  Object.assign(shader.uniforms, uniforms);
  patchVertex(shader, misses);
  let f = shader.fragmentShader;
  f = rep(f, "uniform float opacity;", "uniform float opacity;\n" + FRAG_PARS, "frag:pars", misses);
  f = rep(f, "vec3 outgoingLight = reflectedLight.indirectDiffuse;", porcelain ? PORC_BODY : FRAG_BODY, "frag:body", misses);
  if (porcelain) f = rep(f, "uniform float opacity;", "uniform float opacity;\n" + PORC_PARS, "frag:pars2", misses);
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
    uHairCut: { value: new THREE.Vector4(1e3, 1e3, -1e3, HAIR_CUT.soft) },
    uFringe: { value: new THREE.Vector4(1e3, 1e3, -1e3, 0) },
    uFringeW: { value: new THREE.Vector3(HAIR_FRINGE.band, HAIR_FRINGE.sideSoft, HAIR_FRINGE.ySoft) },
    uHairLen: { value: new THREE.Vector2(-1e3, -1e3) },
    uCap: { value: new THREE.Vector4(1e3, 0.01, 0, 0) },
    uColNavy: { value: new THREE.Color(COLOR_NAVY) },
    uColHalo: { value: new THREE.Color(COLOR_HALO) },
    uColGrey: { value: new THREE.Color(COLOR_GREY) },
    uLipDots: { value: 0 }
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
    if (e.cls === "full" || e.cls === "teeth") addLipAttribute(e.mesh, e.cls === "teeth" && !LIP_TEETH);
    else if (e.cls === "hair") addLipAttribute(e.mesh, true);
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
      const hw = (b.max.x - b.min.x) / 2;
      if (HAIR_MODE === "trim") {
        shared.uHairCut.value.set(
          b.min.z + (b.max.z - b.min.z) * HAIR_CUT.frontFrac,
          hw * HAIR_CUT.sideFrac,
          b.max.y - HAIR_CUT.hairlineDrop,
          HAIR_CUT.soft
        );
        shared.uHairLen.value.set(b.min.y + HAIR_CUT.lenLo, b.min.y + HAIR_CUT.lenHi);
        shared.uCap.value.set(b.max.y - HAIR_CUT.hairlineDrop + HAIR_CUT.scalpLift, HAIR_CUT.soft * 0.9, HAIR_CUT.temple, HAIR_CUT.nape);
      } else if (HAIR_MODE === "full") {
        // no fringe/face cut; only a soft fade of the long hair at the end of the visible neck
        shared.uHairLen.value.set(b.min.y + HAIR_FULL.fadeLo, b.min.y + HAIR_FULL.fadeHi);
        shared.uFringe.value.set(
          b.min.z + (b.max.z - b.min.z) * HAIR_FRINGE.zStartFrac,
          hw * HAIR_FRINGE.sideFrac,
          b.max.y - HAIR_FRINGE.yDrop,
          HAIR_FRINGE.strength
        );
      } else {
        shared.uCap.value.set(b.max.y - HAIR_CAP.hairlineDrop, HAIR_CAP.soft, HAIR_CAP.temple, HAIR_CAP.nape);
      }
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
  const porcMaterials = new Map();
  function getMaterial(e, porcelain = false) {
    const cls = e.cls;
    const cache = porcelain ? porcMaterials : materials;
    if (cache.has(e)) return cache.get(e);
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
      uIsHair: { value: cls === "hair" ? 1 : 0 },
      uHeadHair: { value: cls === "full" && /head/i.test(e.mesh.name || "") && HAIR_MODE !== "full" ? 1 : 0 },
      uKind: { value: cls === "teeth" ? 1 : /tongue/i.test(e.mesh.name || "") ? 2 : 0 }
    };
    mat.onBeforeCompile = (shader) => {
      const misses = [];
      patchShader(shader, { ...shared, ...own }, misses, porcelain);
      if (misses.length) console.warn("[hologram] shader injection missed:", misses.join(", "));
    };
    mat.customProgramCacheKey = () => (porcelain ? "porcelain-v1" : cls === "hair" ? "hologram-hair-v9" : "hologram-v9");
    mat.userData.hologramClass = cls;
    cache.set(e, mat);
    return mat;
  }

  let prepassMaterial = null;
  let hairPrepassMaterial = null;
  function getPrepassMaterial(cls) {
    const opts = {
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: PREPASS_OFFSET.factor,
      polygonOffsetUnits: PREPASS_OFFSET.units
    };
    if (cls === "hair") {
      if (!hairPrepassMaterial) {
        hairPrepassMaterial = new THREE.MeshBasicMaterial({ ...opts, side: THREE.FrontSide });
        hairPrepassMaterial.onBeforeCompile = (shader) => {
          const misses = [];
          patchHairPrepass(shader, shared, misses);
          if (misses.length) console.warn("[hologram] shader injection missed:", misses.join(", "));
        };
        hairPrepassMaterial.customProgramCacheKey = () => "hair-prepass-v2";
      }
      return hairPrepassMaterial;
    }
    if (!prepassMaterial) prepassMaterial = new THREE.MeshBasicMaterial(opts);
    return prepassMaterial;
  }

  function makePrepass(e) {
    const m = e.mesh;
    let pm;
    if (m.isSkinnedMesh) {
      pm = new THREE.SkinnedMesh(m.geometry, getPrepassMaterial(e.cls));
      pm.bindMode = m.bindMode;
      pm.bind(m.skeleton, m.bindMatrix);
    } else {
      pm = new THREE.Mesh(m.geometry, getPrepassMaterial(e.cls));
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

  function applyHologram(porcelain = false) {
    for (const e of entries) {
      const m = e.mesh;
      if (e.cls === "hidden") {
        m.visible = false;
        continue;
      }
      const off = e.cls === "hair" && (porcelain || HAIR_MODE === "cap"); // hair is a hologram-only look
      m.material = getMaterial(e, porcelain);
      m.renderOrder = HOLO_ORDER;
      m.visible = e.visible && !off;
      if (CLASS_PARAMS[e.cls].prepass && m.parent) {
        if (!e.prepass) e.prepass = makePrepass(e);
        syncPrepass(e);
        e.prepass.visible = e.visible && !off;
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
    if (s === "hologram" || s === "porcelain" || s === "hybrid") {
      shared.uLipDots.value = s === "hybrid" ? 1 : 0;
      applyHologram(s !== "hologram");
      currentStyle = s;
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
      if (currentStyle !== "solid") {
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
      for (const mt of porcMaterials.values()) mt.dispose();
      if (prepassMaterial) prepassMaterial.dispose();
      if (hairPrepassMaterial) hairPrepassMaterial.dispose();
      if (composer) {
        for (const p of composer.passes) if (p.dispose) p.dispose();
        composer.dispose();
        composer = null;
      }
    }
  };

  if (reduced) fullyRevealed();
  if (style !== "solid") setStyle(style);
  return api;
}
