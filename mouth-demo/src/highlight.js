import * as THREE from "three";

export const HIGHLIGHT_TUNING = { offset: [0, 0, 0], radius: null };

const STEP = 0.002;
const PERIOD_MS = 900;
const RX_FACTOR = 1.15; // horizontal radius = anchor radius * this
const RY_RATIO = 0.6; // vertical radius = horizontal radius * this
const STROKE = 0.0012; // navy stroke width (m)
const UNDERLAY = 0.0018; // extra white underlay beyond the stroke (m)
const PEAK_OPACITY = 0.75;
const PULSE_MIN_OPACITY = 0.45;
const PULSE_SCALE = 0.04;
const SEGMENTS = 96;

// Triangle strip between two offset curves of an ellipse; offsets follow the
// true normal so the stroke width stays even all the way around.
function ellipseStrip(rx, ry, d0, d1) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    let nx = c / rx;
    let ny = sn / ry;
    const l = Math.hypot(nx, ny);
    nx /= l;
    ny /= l;
    const x = rx * c;
    const y = ry * sn;
    pos.push(x + nx * d0, y + ny * d0, 0, x + nx * d1, y + ny * d1, 0);
    const a = i * 2;
    const b = ((i + 1) % SEGMENTS) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "[", "]"]);

export function createHighlight({ headBone, camera, anchor }) {
  const offset = HIGHLIGHT_TUNING.offset.slice();
  let radius = HIGHLIGHT_TUNING.radius ?? anchor.radius;
  let visibility = 0;
  let pulsing = false;
  let phase = 0;
  let pulseVal = 0;
  let calibrating = false;

  // palette only: thin navy stroke over a faint white underlay
  const COLORS = ["#FFFFFF", "#203E68"]; // underlay, stroke
  const LAYER_OPACITY = [0.55, 1];
  const LAYERS = [
    [-STROKE, STROKE + UNDERLAY], // underlay offsets (m) from the base ellipse
    [0, STROKE],
  ];
  const materials = COLORS.map(
    (color) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
  );

  function buildGeometries() {
    const rx = radius * RX_FACTOR;
    const ry = rx * RY_RATIO;
    return LAYERS.map(([d0, d1]) => ellipseStrip(rx, ry, d0, d1));
  }

  const mesh = new THREE.Group();
  const parts = buildGeometries().map((geo, i) => {
    const part = new THREE.Mesh(geo, materials[i]);
    part.renderOrder = 999 + i;
    part.frustumCulled = false;
    mesh.add(part);
    return part;
  });
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  headBone.add(mesh);

  function applyPosition() {
    mesh.position.set(
      anchor.headLocal.x + offset[0],
      anchor.headLocal.y + offset[1],
      anchor.headLocal.z + offset[2]
    );
  }
  applyPosition();

  const pPos = new THREE.Vector3();
  const pQuat = new THREE.Quaternion();
  const pScale = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();

  function setVisibility(v) {
    visibility = Math.min(1, Math.max(0, v));
  }

  function setPulse(on) {
    pulsing = !!on;
  }

  function update(scaledDtMs) {
    phase += scaledDtMs / PERIOD_MS;
    const s = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    const vis = calibrating ? 1 : visibility;
    const doPulse = pulsing || calibrating;
    let scale = 1;
    let opacity = PEAK_OPACITY * vis;
    if (doPulse) {
      scale = 1 + PULSE_SCALE * s;
      opacity = (PULSE_MIN_OPACITY + (PEAK_OPACITY - PULSE_MIN_OPACITY) * s) * vis;
    }
    pulseVal = pulsing ? s * visibility : 0;
    materials.forEach((m, i) => { m.opacity = opacity * LAYER_OPACITY[i]; });
    mesh.visible = opacity >= 0.01;
    if (!mesh.visible) return;

    headBone.updateWorldMatrix(true, false);
    headBone.matrixWorld.decompose(pPos, pQuat, pScale);
    mesh.scale.set(scale / pScale.x, scale / pScale.y, scale / pScale.z);
    camera.getWorldQuaternion(camQuat);
    mesh.quaternion.copy(pQuat).invert().multiply(camQuat);
  }

  function logTuning() {
    const f = (n) => Number(n.toFixed(4));
    console.log(
      `HIGHLIGHT_TUNING = { offset: [${f(offset[0])}, ${f(offset[1])}, ${f(offset[2])}], radius: ${f(radius)} }`
    );
  }

  function toggleCalibration() {
    calibrating = !calibrating;
    if (calibrating) logTuning();
    return calibrating;
  }

  function handleKey(e) {
    if (!calibrating || !KEYS.has(e.key)) return false;
    let resize = false;
    switch (e.key) {
      case "ArrowUp": offset[1] += STEP; break;
      case "ArrowDown": offset[1] -= STEP; break;
      case "ArrowLeft": offset[0] -= STEP; break;
      case "ArrowRight": offset[0] += STEP; break;
      case "PageUp": offset[2] += STEP; break;
      case "PageDown": offset[2] -= STEP; break;
      case "[": radius = Math.max(0.005, radius - STEP); resize = true; break;
      case "]": radius += STEP; resize = true; break;
    }
    if (resize) {
      const geos = buildGeometries();
      parts.forEach((p, i) => {
        p.geometry.dispose();
        p.geometry = geos[i];
      });
    }
    applyPosition();
    HIGHLIGHT_TUNING.offset = offset.slice();
    HIGHLIGHT_TUNING.radius = radius;
    logTuning();
    return true;
  }

  function dispose() {
    mesh.removeFromParent();
    for (const p of parts) p.geometry.dispose();
    for (const m of materials) m.dispose();
  }

  return {
    mesh,
    setVisibility,
    setPulse,
    get pulseValue() { return pulseVal; },
    update,
    toggleCalibration,
    get calibrating() { return calibrating; },
    handleKey,
    dispose,
  };
}
