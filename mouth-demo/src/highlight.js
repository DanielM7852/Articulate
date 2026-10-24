import * as THREE from "three";

export const HIGHLIGHT_TUNING = { offset: [0, 0, 0], radius: null };

const STEP = 0.002;
const PERIOD_MS = 900;
const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "[", "]"]);

export function createHighlight({ headBone, camera, anchor }) {
  const offset = HIGHLIGHT_TUNING.offset.slice();
  let radius = HIGHLIGHT_TUNING.radius ?? anchor.radius;
  let visibility = 0;
  let pulsing = false;
  let phase = 0;
  let pulseVal = 0;
  let calibrating = false;

  const material = new THREE.MeshBasicMaterial({
    color: "#3CF2FF",
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  function buildGeometry() {
    const r = radius * 1.35;
    return new THREE.RingGeometry(r, r + 0.004, 64);
  }

  const mesh = new THREE.Mesh(buildGeometry(), material);
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
    let opacity = 0.85 * vis;
    if (doPulse) {
      scale = 1 + 0.08 * s;
      opacity = (0.5 + 0.5 * s) * vis;
    }
    pulseVal = pulsing ? s * visibility : 0;
    material.opacity = opacity;
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
      mesh.geometry.dispose();
      mesh.geometry = buildGeometry();
    }
    applyPosition();
    HIGHLIGHT_TUNING.offset = offset.slice();
    HIGHLIGHT_TUNING.radius = radius;
    logTuning();
    return true;
  }

  function dispose() {
    mesh.removeFromParent();
    mesh.geometry.dispose();
    material.dispose();
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
