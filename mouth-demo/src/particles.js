import * as THREE from "three";

// ---- tuning knobs -------------------------------------------------------
const Z_MIN = -4;
const Z_MAX = -2;
const RISE_SPEED = 0.045; // NDC units per second
const SWAY_AMOUNT = 0.03;
const SWING_DRIFT = 0.5; // NDC units per second at full swing
const SWING_EASE_MS = 400;
const REDUCED_DRIFT = 0.12; // drift scale under reduced motion
const SIZE_PX = [2, 4.5];
const ALPHA = [0.15, 0.5];
const MOUTH_HOLE = { cx: 0, cy: -0.35, rx: 0.5, ry: 0.6 }; // NDC ellipse kept empty

const VERT = /* glsl */ `
attribute vec3 aSeed; // x: ndc x, y: ndc y, z: phase
attribute vec4 aProps; // x: size, y: alpha, z: tint, w: depth speed factor
uniform vec2 uTan; // tan(fov/2) * aspect, tan(fov/2)
uniform float uRise;
uniform float uDriftX;
uniform float uTime;
uniform float uSway;
uniform float uTwinkle;
uniform float uPx;
varying float vAlpha;
varying float vTint;

void main() {
  float depth = aProps.w;
  float ny = mod(aSeed.y + 1.0 + uRise * depth, 2.0) - 1.0;
  float nx = mod(aSeed.x + 1.0 + uDriftX * depth + sin(uTime * 0.4 + aSeed.z) * uSway, 2.0) - 1.0;
  float z = position.z;
  vec3 p = vec3(nx * uTan.x * -z, ny * uTan.y * -z, z);

  float e = pow((nx - ${MOUTH_HOLE.cx.toFixed(2)}) / ${MOUTH_HOLE.rx.toFixed(2)}, 2.0)
    + pow((ny - ${MOUTH_HOLE.cy.toFixed(2)}) / ${MOUTH_HOLE.ry.toFixed(2)}, 2.0);
  float hole = smoothstep(1.0, 1.4, e);
  float upper = mix(0.35, 1.0, smoothstep(-0.6, 0.8, ny));
  float side = mix(0.5, 1.0, smoothstep(0.2, 0.8, abs(nx)));
  float tw = 1.0 - uTwinkle * (0.35 + 0.35 * sin(uTime * (1.5 + aSeed.z * 0.3) + aSeed.z * 6.2831));
  vAlpha = aProps.y * hole * upper * side * tw;
  vAlpha *= 1.0 - smoothstep(0.85, 1.0, abs(ny));
  vTint = aProps.z;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aProps.x * uPx;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
varying float vAlpha;
varying float vTint;

void main() {
  vec4 c = vec4(mix(uColA, uColB, vTint), vAlpha);
  gl_FragColor = c;
  #include <colorspace_fragment>
}
`;

export function createParticles({ camera, count = 300, reducedMotion = false }) {
  let reduced = !!reducedMotion;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  const props = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const corner = Math.random() < 0.6;
    const side = Math.random() < 0.5 ? -1 : 1;
    const nx = corner ? side * (0.5 + Math.random() * 0.5) : Math.random() * 2 - 1;
    const ny = corner ? 0.1 + Math.random() * 0.9 : Math.random() * 2 - 1;
    const z = Z_MIN + Math.random() * (Z_MAX - Z_MIN);
    positions.set([0, 0, z], i * 3);
    seeds.set([nx, ny, Math.random() * 6.2831], i * 3);
    props.set(
      [
        SIZE_PX[0] + Math.random() * (SIZE_PX[1] - SIZE_PX[0]),
        ALPHA[0] + Math.random() * (ALPHA[1] - ALPHA[0]),
        Math.random() < 0.25 ? 0.7 + Math.random() * 0.3 : Math.random() * 0.4,
        0.6 + Math.random() * 0.8
      ],
      i * 4
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute("aProps", new THREE.BufferAttribute(props, 4));

  const uniforms = {
    uTan: { value: new THREE.Vector2(1, 1) },
    uRise: { value: 0 },
    uDriftX: { value: 0 },
    uTime: { value: 0 },
    uSway: { value: SWAY_AMOUNT },
    uTwinkle: { value: reduced ? 0 : 1 },
    uPx: { value: (typeof window !== "undefined" && window.devicePixelRatio) || 1 },
    uColA: { value: new THREE.Color("#FF2BA6") },
    uColB: { value: new THREE.Color("#FFD1EC") }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });

  const points = new THREE.Points(geometry, material);
  points.name = "background-particles";
  points.frustumCulled = false;
  points.renderOrder = -1;
  camera.add(points);

  let swingDir = 0;
  let swingVel = 0;

  function syncCamera() {
    const t = Math.tan(THREE.MathUtils.degToRad((camera.fov || 40) / 2));
    uniforms.uTan.value.set(t * (camera.aspect || 1), t);
  }
  syncCamera();

  return {
    points,
    update(dtMs) {
      const dt = Math.max(0, dtMs || 0);
      const s = dt / 1000;
      syncCamera();
      uniforms.uTime.value += s * (reduced ? REDUCED_DRIFT : 1);
      uniforms.uRise.value += s * RISE_SPEED * (reduced ? REDUCED_DRIFT : 1);
      const target = reduced ? 0 : swingDir * SWING_DRIFT;
      swingVel += (target - swingVel) * (1 - Math.exp(-dt / SWING_EASE_MS));
      uniforms.uDriftX.value += s * swingVel;
    },
    setVisible(on) {
      points.visible = !!on;
    },
    setSwing(dir) {
      swingDir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    },
    setReducedMotion(on) {
      reduced = !!on;
      uniforms.uTwinkle.value = reduced ? 0 : 1;
      uniforms.uSway.value = reduced ? SWAY_AMOUNT * REDUCED_DRIFT : SWAY_AMOUNT;
    },
    dispose() {
      camera.remove(points);
      geometry.dispose();
      material.dispose();
    }
  };
}
