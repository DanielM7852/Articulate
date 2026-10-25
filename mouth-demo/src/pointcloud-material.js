import * as THREE from "three";

/**
 * The point material of Ava's dot head (pointcloud.js), shared so other dot clouds (the teacher dashboard's
 * learner face) render with the same sprites, light, size and shade rules, tones and transitions.
 * Moved here unchanged from pointcloud.js; pointcloud.js imports it back.
 */

export const COLOR_NAVY = "#203E68";
export const COLOR_HALO = "#CBD7E6";
export const COLOR_GREY = "#DADFD9";

export const DOT = { radius: 0.00068, mouthSwell: 0.1, holdSwell: 0.08, rimSwell: 0.12, minPx: 1.5, maxPx: 7 }; // metres; px limits in CSS pixels
export const KIND = { head: 0, hair: 1, eyes: 2, teeth: 3 };
export const SIZE_MUL = { full: 1, hair: 1.15, eyes: 0.8, teeth: 0.8 };
// hair reads as a dark mass so its silhouette frames the face: base = navy * base, highlights scaled by spec
export const HAIR_TONE = { base: 0.42, spec: 0.25 };
// teeth: a soft grey-navy, not a bright white slit between the lips
export const TEETH_TONE = { navyMix: 0.78, spec: 0.35 };
// lighting by surface orientation: shadowed dots larger and darker, lit dots smaller and brighter (tone -> size)
export const LIGHT = { sizeShadow: 1.22, sizeLit: 0.82, shadeShadow: 0.78, shadeLit: 1.08 };
/**
 * Assembly transitions (intro and outro), computed in the vertex shader so they cost nothing on the CPU.
 * Every dot has a fixed start point in a wide shell around the head (aFly.xyz, relative to the head centre,
 * mostly off screen and behind) and a random phase (aFly.w). One progress uniform sweeps across the dots as
 * a staggered wave (chin first, broken up by the phase); each dot eases home along a spiral around the
 * vertical axis. The dissolve is a looser motion, not a rewind: top first, dots drift outward and up with a
 * slow curl, shrinking and fading.
 */
export const FLY = {
  radius: [0.22, 0.6], // metres from the head centre: the start shell
  flatY: 0.7, // squash the shell vertically, so most dots come in from the sides
  depth: 0.6, // squash the shell toward the camera axis...
  back: 0.3, // ...and push it behind the head (metres), so few dots pass near the camera
  spread: 0.6, // share of the timeline used to stagger the dots; the rest is each dot's own flight
  random: 0.25, // stagger key: 0 is a clean bottom-up wave, 1 is fully random
  swirl: 1.2, // radians of spiral around the vertical axis over one flight
  fadeIn: 0.3, // share of a dot's own flight spent fading in
  flightSize: 0.55, // dot size far from home (grows to 1 on arrival)
  near: [0.18, 0.32], // metres from the camera: dots passing closer than this fade out
  // timeline progress at which the depth prepass returns: it hides the far side and the eye and mouth interiors,
  // but dots arriving from behind would vanish into it, so it waits until nearly every dot is home
  prepassAt: 0.78,
  eyesIn: 0.08 // timeline share over which the eyes and teeth fade back in after that
};
/**
 * Start shape: instead of the shell, the fly-in can start from a picture drawn in dots (the landing page's ribbon).
 * Every dot of the head starts visible on the picture (darker samples carry more dots) and travels from there to
 * its spot on the head: nothing appears from elsewhere. Dots are paired by rank (left to right in strips, then
 * bottom to top within each strip), so the left of the picture flows into the left of the head. The wave drains
 * the picture progressively, starting from the end set by `key`.
 */
export const SHAPE = {
  swirl: 0.2, // radians of spiral over one flight: a morph, not a tornado
  key: "x", // stagger: "x" drains the picture from its left end, "far" from its right end, "dist" the farthest dots first
  random: 0.15, // stagger key: 0 is a clean sweep, 1 fully random
  spread: 0.4, // share of the timeline used to stagger the dots; the rest is each dot's own flight
  light: 1.0, // dot tone on the picture (navy multiplier) for the lightest and the darkest samples
  dark: 0.4,
  sizeLight: 0.8, // dot radius multiplier on the picture, by tone
  sizeDark: 1.15,
  alphaLight: 0.65, // dot opacity on the picture, by tone (the lighter parts read lighter)
  alphaDark: 1.0,
  toneWeight: 0.35, // dots per sample: toneWeight + tone, so darker samples carry more dots
  coverage: 0.72, // share of the picture's area the dots cover on average; sets their radius from their density
  minPx: 1.0, // device px: smallest dot drawn on the picture; smaller ones are drawn at this size, fainter
  appearMs: 80 // the picture fades in when it is first shown (under the image it replaces, which fades over 200 ms)
};
export const DISSOLVE = { spread: 0.6, random: 0.3, out: 0.07, outZ: 0.3, up: 0.16, curl: 0.035, fadeStart: 0.1, fadeEnd: 0.9, shrink: 0.45 };

export const VERT = /* glsl */ `
attribute vec3 aNormal;
attribute vec4 aInfo; // x: size multiplier, y: kind, z: mouth weight, w: alpha
attribute vec4 aFly; // xyz: fly-in start relative to the head centre, w: per-dot random in [0, 1)
uniform float uProj; // device pixels per metre at one metre
uniform float uDpr;
uniform float uRadius;
uniform float uHold;
uniform float uProg; // progress of the current transition, 0..1
uniform float uMode; // 0: fly-in (uProg 1 is assembled), 1: dissolve (uProg 1 is gone)
uniform float uTravel; // 1: dots travel; 0: reduced motion, a plain crossfade
uniform float uBackFade; // while the depth prepass is off: hide settled dots behind the head's centre plane
uniform vec3 uCenter;
uniform vec2 uYRange;
attribute vec2 aShape; // start picture: x tone (1 darkest), y stagger key (0 leaves first)
uniform float uShape; // 1: the fly-in starts from a picture; aFly.xyz is then in camera space
uniform mat4 uShapeMatrix; // camera space to world, for the picture
uniform float uShapeRadius; // dot radius on the picture, metres
uniform float uShapeAlpha; // the picture's own fade-in
varying float vShape;
varying float vShade;
varying float vRim;
varying float vKind;
varying float vMouth;
varying float vAlpha;
varying float vLit;

void main() {
  vec3 p = position;
  float fade = 1.0;
  float grow = 1.0;
  float settled = 1.0; // weight of the far-side hiding (prepass off): 1 at home, 0 far away
  float shapeMix = 0.0; // 1 on the start picture, 0 at home
  bool shaped = uShape > 0.5 && uMode < 0.5;
  bool moving = uMode > 0.5 || uProg < 1.0;
  if (moving) {
    float yN = clamp((position.y - uYRange.x) / max(uYRange.y - uYRange.x, 1e-3), 0.0, 1.0);
    if (uTravel < 0.5) {
      if (shaped && uProg < 0.5) {
        // reduced motion from a picture: it fades out, then the head fades in
        p = (uShapeMatrix * vec4(aFly.xyz, 1.0)).xyz;
        shapeMix = 1.0;
        settled = 0.0;
        fade = (1.0 - 2.0 * uProg) * uShapeAlpha;
      } else if (shaped) {
        fade = 2.0 * uProg - 1.0;
      } else {
        fade = uMode > 0.5 ? 1.0 - uProg : uProg;
      }
    } else if (shaped) {
      // morph from the picture: the wave drains it progressively; each dot peels off, travels and settles,
      // turning a little about the head's vertical axis. Every dot is visible the whole way.
      vec3 start = (uShapeMatrix * vec4(aFly.xyz, 1.0)).xyz;
      float key = mix(aShape.y, aFly.w, ${SHAPE.random.toFixed(2)});
      float q = clamp((uProg - key * ${SHAPE.spread.toFixed(2)}) / ${(1 - SHAPE.spread).toFixed(2)}, 0.0, 1.0);
      float e = q * q * (3.0 - 2.0 * q); // ease in and out: leaves the picture gently, lands softly
      float ang = ${SHAPE.swirl.toFixed(2)} * (1.0 - e);
      float cs = cos(ang);
      float sn = sin(ang);
      vec3 home = position - uCenter;
      home = vec3(cs * home.x + sn * home.z, home.y, cs * home.z - sn * home.x);
      p = mix(start, uCenter + home, e);
      fade = uShapeAlpha;
      if (aInfo.y > 1.5) fade *= mix(1.0 - e, 1.0, smoothstep(${FLY.prepassAt.toFixed(2)}, ${(FLY.prepassAt + FLY.eyesIn).toFixed(2)}, uProg));
      shapeMix = 1.0 - e;
      settled = e;
    } else if (uMode < 0.5) {
      // fly-in: a wave from the chin up, broken up by each dot's phase
      float key = mix(yN, aFly.w, ${FLY.random.toFixed(2)});
      float q = clamp((uProg - key * ${FLY.spread.toFixed(2)}) / ${(1 - FLY.spread).toFixed(2)}, 0.0, 1.0);
      float rq = 1.0 - q;
      float e = 1.0 - rq * rq * rq; // ease-out cubic: arrives fast, settles softly
      float ang = ${FLY.swirl.toFixed(2)} * (1.0 - e);
      vec3 rel = mix(position - uCenter, aFly.xyz, 1.0 - e);
      float cs = cos(ang);
      float sn = sin(ang);
      p = uCenter + vec3(cs * rel.x + sn * rel.z, rel.y, cs * rel.z - sn * rel.x);
      fade = smoothstep(0.0, ${FLY.fadeIn.toFixed(2)}, q);
      grow = mix(${FLY.flightSize.toFixed(2)}, 1.0, e);
      // eyeballs and teeth read right only behind the prepass: hide them as they land, fade them in once it is back
      if (aInfo.y > 1.5) fade *= mix(1.0 - e, 1.0, smoothstep(${FLY.prepassAt.toFixed(2)}, ${(FLY.prepassAt + FLY.eyesIn).toFixed(2)}, uProg));
      settled = e;
    } else {
      // dissolve: top first; drift outward and up with a slow curl, shrinking and fading
      float key = mix(1.0 - yN, aFly.w, ${DISSOLVE.random.toFixed(2)});
      float q = clamp((uProg - key * ${DISSOLVE.spread.toFixed(2)}) / ${(1 - DISSOLVE.spread).toFixed(2)}, 0.0, 1.0);
      float e = q * q; // ease-in: lets go gently, then drifts away
      float ph = aFly.w * 6.2832 + q * 2.5;
      vec3 outward = normalize(position - uCenter + vec3(0.0, 0.0, 1e-4)) * vec3(1.0, 1.0, ${DISSOLVE.outZ.toFixed(2)}); // little toward the camera
      p = position + e * (outward * ${DISSOLVE.out.toFixed(3)} + vec3(0.0, ${DISSOLVE.up.toFixed(3)}, 0.0) + vec3(sin(ph), 0.0, cos(ph)) * ${DISSOLVE.curl.toFixed(3)});
      fade = 1.0 - smoothstep(${DISSOLVE.fadeStart.toFixed(2)}, ${DISSOLVE.fadeEnd.toFixed(2)}, q);
      grow = 1.0 - ${DISSOLVE.shrink.toFixed(2)} * q;
    }
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (moving) {
    if (uBackFade > 0.0) {
      float cz = (modelViewMatrix * vec4(uCenter, 1.0)).z;
      fade *= 1.0 - uBackFade * settled * smoothstep(0.0, 0.03, cz - mv.z);
    }
    fade *= smoothstep(${FLY.near[0].toFixed(2)}, ${FLY.near[1].toFixed(2)}, -mv.z);
  }
  vec3 n = normalize(normalMatrix * aNormal);
  // on the picture every dot faces the viewer, so it is lit evenly
  if (shapeMix > 0.0) n = normalize(mix(n, vec3(0.0, 0.0, 1.0), shapeMix) + vec3(0.0, 0.0, 1e-3));
  vec3 toEye = normalize(-mv.xyz);
  float facing = abs(dot(n, toEye));
  float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 2.0);
  // key light from the upper left, in view space; hair cards are two-sided, so take the lit side
  float lambert = dot(n, normalize(vec3(-0.45, 0.6, 0.75)));
  if (aInfo.y > 0.5 && aInfo.y < 1.5) lambert = abs(lambert);
  float lit = smoothstep(-0.15, 0.85, lambert);
  float sizeLight = mix(${LIGHT.sizeShadow.toFixed(2)}, ${LIGHT.sizeLit.toFixed(2)}, lit);
  float r = uRadius * aInfo.x * sizeLight * grow * (1.0 + ${DOT.mouthSwell.toFixed(2)} * aInfo.z + uHold * ${DOT.holdSwell.toFixed(2)} * aInfo.z + ${DOT.rimSwell.toFixed(2)} * rim);
  r = mix(r, uShapeRadius * mix(${SHAPE.sizeLight.toFixed(2)}, ${SHAPE.sizeDark.toFixed(2)}, aShape.x), shapeMix);
  // capped so a dot lifted toward the camera does not balloon
  float px = 2.0 * r * uProj / -mv.z;
  float minPx = mix(${DOT.minPx.toFixed(1)}, ${SHAPE.minPx.toFixed(1)}, shapeMix);
  float ps = clamp(px, minPx, ${DOT.maxPx.toFixed(1)} * uDpr);
  gl_PointSize = ps;
  gl_Position = projectionMatrix * mv;
  vRim = rim;
  vKind = aInfo.y;
  vMouth = aInfo.z;
  // on the picture: opacity by tone, and a dot drawn larger than its size is fainter so the coverage holds
  float sub = px / ps;
  float shapeAlpha = mix(${SHAPE.alphaLight.toFixed(2)}, ${SHAPE.alphaDark.toFixed(2)}, aShape.x) * min(1.0, sub * sub);
  vAlpha = mix(aInfo.w, shapeAlpha, shapeMix) * fade;
  vLit = lit;
  vShape = shapeMix;
  vShade = aShape.x;
}
`;

export const FRAG = /* glsl */ `
uniform vec3 uColNavy;
uniform vec3 uColHalo;
uniform vec3 uColGrey;
varying float vRim;
varying float vKind;
varying float vMouth;
varying float vAlpha;
varying float vLit;
varying float vShape;
varying float vShade;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  float cov = 1.0 - smoothstep(0.82, 1.0, d);
  if (cov < 0.02 || vAlpha < 0.004) discard; // (settled dots never go below 0.02)
  // each dot is a tiny sphere lit from the upper left; the surface's own lighting (vLit) sets its overall tone
  vec3 sn = vec3(q, sqrt(max(1.0 - d * d, 0.0)));
  float lit = clamp(dot(sn, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float shade = mix(0.55, 1.15, lit) * mix(${LIGHT.shadeShadow.toFixed(2)}, ${LIGHT.shadeLit.toFixed(2)}, vLit);
  float spec = 0.35 * pow(lit, 10.0) * (0.4 + 0.6 * vLit);
  float rimGlow = 0.2 * vRim;
  vec3 base = uColNavy;
  if (vKind > 2.5) {
    base = mix(uColGrey, uColNavy, ${TEETH_TONE.navyMix.toFixed(2)});
    spec *= ${TEETH_TONE.spec.toFixed(2)};
  } else if (vKind > 1.5) base = uColNavy * 0.75;
  else if (vKind > 0.5) {
    base = uColNavy * ${HAIR_TONE.base.toFixed(2)};
    spec *= ${HAIR_TONE.spec.toFixed(2)};
    rimGlow = 0.0;
  }
  if (vShape > 0.0) {
    // on the start picture: one navy, darker where the picture is darker
    base = mix(base, uColNavy * mix(${SHAPE.light.toFixed(2)}, ${SHAPE.dark.toFixed(2)}, vShade), vShape);
    spec *= 1.0 - 0.5 * vShape;
    rimGlow *= 1.0 - vShape;
  }
  vec3 col = base * shade + uColHalo * (spec + rimGlow) + uColHalo * 0.04 * vMouth;
  gl_FragColor = vec4(col, cov * vAlpha);
  #include <colorspace_fragment>
}
`;

/**
 * The cloud's ShaderMaterial with its uniforms (material.uniforms, the same object the caller updates).
 * radius: dot radius in world units (default DOT.radius, metres); center, yRange: the head centre and its
 * vertical extent, used by the assembly transitions.
 */
export function createPointMaterial({ radius = DOT.radius, center, yRange } = {}) {
  const uniforms = {
    uProj: { value: 1000 },
    uDpr: { value: 1 },
    uRadius: { value: radius },
    uHold: { value: 0 },
    uProg: { value: 1 },
    uMode: { value: 0 },
    uTravel: { value: 1 },
    uBackFade: { value: 0 },
    uCenter: { value: center ? new THREE.Vector3().copy(center) : new THREE.Vector3() },
    uYRange: { value: new THREE.Vector2(yRange ? yRange[0] : 0, yRange ? yRange[1] : 1) },
    uShape: { value: 0 },
    uShapeMatrix: { value: new THREE.Matrix4() },
    uShapeRadius: { value: DOT.radius },
    uShapeAlpha: { value: 0 },
    uColNavy: { value: new THREE.Color(COLOR_NAVY) },
    uColHalo: { value: new THREE.Color(COLOR_HALO) },
    uColGrey: { value: new THREE.Color(COLOR_GREY) }
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    alphaToCoverage: true,
    depthWrite: true,
    depthTest: true,
    fog: false
  });
}
