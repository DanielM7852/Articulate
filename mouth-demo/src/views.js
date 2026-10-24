import * as THREE from "three";

export const SIDE_AZIMUTH = -Math.PI / 2;

const AZIMUTHS = { front: 0, side: SIDE_AZIMUTH };
const LIMIT_AZ = THREE.MathUtils.degToRad(60);
const LIMIT_POLAR = THREE.MathUtils.degToRad(20);
const FOLLOW = 0.1;
const DIST_EASE = 0.15;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createViews({ camera, controls, canvas }) {
  const pivot = new THREE.Vector3().copy(controls.target);
  const goal = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const sph = new THREE.Spherical();

  let anchorObj = null;
  const anchorOffset = new THREE.Vector3();
  let worldUp = 0.015;
  let currentView = "front";
  let anim = null; // { from, to, elapsed, duration, resolve, distance }
  let reduced = false;
  let timers = [];
  let pendingResolve = null;
  let zoom = 1; // camera distance multiplier: below 1 moves closer

  function updateGoal() {
    if (!anchorObj) return false;
    anchorObj.updateWorldMatrix(true, false);
    goal.copy(anchorOffset);
    anchorObj.localToWorld(goal);
    goal.y += worldUp;
    return true;
  }

  function setAnchor(object3D, localOffset, opts = {}) {
    const first = !anchorObj;
    anchorObj = object3D;
    anchorOffset.copy(localOffset);
    worldUp = opts.worldUp ?? 0.015;
    if (first && updateGoal()) pivot.copy(goal);
  }

  function distanceFor() {
    return 0.55 * Math.max(1, 0.9 / camera.aspect) * zoom;
  }

  function setZoom(z) {
    zoom = Number.isFinite(z) ? Math.min(1.6, Math.max(0.5, z)) : 1;
  }

  function applyLimits(settled) {
    if (settled) {
      const base = AZIMUTHS[currentView];
      controls.minAzimuthAngle = base - LIMIT_AZ;
      controls.maxAzimuthAngle = base + LIMIT_AZ;
      controls.minPolarAngle = Math.PI / 2 - LIMIT_POLAR;
      controls.maxPolarAngle = Math.PI / 2 + LIMIT_POLAR;
    } else {
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI;
    }
  }

  function place(azimuth, polar, distance) {
    sph.set(distance, polar, azimuth);
    tmp.setFromSpherical(sph);
    camera.position.copy(controls.target).add(tmp);
    camera.lookAt(controls.target);
  }

  function snap() {
    if (updateGoal()) pivot.copy(goal);
    controls.target.copy(pivot);
    place(AZIMUTHS[currentView], Math.PI / 2, distanceFor());
    applyLimits(true);
    controls.update();
  }

  function finishAnim() {
    if (!anim) return;
    const a = anim;
    anim = null;
    controls.enabled = true;
    applyLimits(true);
    place(a.to.az, a.to.polar, distanceFor());
    controls.update();
    a.resolve();
  }

  function cancelPending() {
    timers.forEach(clearTimeout);
    timers = [];
    if (anim) {
      const r = anim.resolve;
      anim = null;
      r();
    }
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r();
    }
    controls.enabled = true;
    canvas.style.opacity = "";
  }

  function setView(name, { animate = true, durationMs = 1200 } = {}) {
    if (!(name in AZIMUTHS)) return Promise.resolve();
    cancelPending();
    currentView = name;
    const toAz = AZIMUTHS[name];

    if (!animate) {
      snapToView();
      return Promise.resolve();
    }

    if (reduced) {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        controls.enabled = false;
        canvas.style.transition = "opacity 150ms";
        canvas.style.opacity = "0";
        timers.push(setTimeout(() => {
          snapToView();
          controls.enabled = false;
          canvas.style.opacity = "1";
        }, 150));
        timers.push(setTimeout(() => {
          timers = [];
          pendingResolve = null;
          controls.enabled = true;
          canvas.style.opacity = "";
          resolve();
        }, 300));
      });
    }

    // start from wherever the user dragged to
    tmp.copy(camera.position).sub(controls.target);
    sph.setFromVector3(tmp);
    return new Promise((resolve) => {
      anim = {
        from: { az: sph.theta, polar: sph.phi },
        to: { az: toAz, polar: Math.PI / 2 },
        elapsed: 0,
        duration: Math.max(1, durationMs),
        distance: sph.radius,
        resolve,
      };
      controls.enabled = false;
      applyLimits(false);
    });
  }

  // snap to the current view but keep the pivot as is
  function snapToView() {
    controls.target.copy(pivot);
    place(AZIMUTHS[currentView], Math.PI / 2, distanceFor());
    applyLimits(true);
    controls.update();
  }

  function update(scaledDtMs) {
    if (updateGoal()) {
      const prev = tmp.copy(pivot);
      pivot.lerp(goal, FOLLOW);
      const dx = pivot.x - prev.x;
      const dy = pivot.y - prev.y;
      const dz = pivot.z - prev.z;
      controls.target.x += dx;
      controls.target.y += dy;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
    }
    if (anim) {
      anim.elapsed += scaledDtMs;
      const t = Math.min(1, anim.elapsed / anim.duration);
      const e = easeInOutCubic(t);
      const az = anim.from.az + (anim.to.az - anim.from.az) * e;
      const polar = anim.from.polar + (anim.to.polar - anim.from.polar) * e;
      // blend from the starting radius to the live aspect-fitted distance
      const dist = anim.distance + (distanceFor() - anim.distance) * e;
      place(az, polar, dist);
      if (t >= 1) finishAnim();
      return;
    }
    // ease the camera distance toward the aspect-fitted value
    tmp.copy(camera.position).sub(controls.target);
    const cur = tmp.length();
    if (cur > 1e-6) {
      const want = distanceFor();
      if (Math.abs(want - cur) > 1e-5) {
        tmp.multiplyScalar((cur + (want - cur) * DIST_EASE) / cur);
        camera.position.copy(controls.target).add(tmp);
      }
    }
    controls.update();
  }

  function setReducedMotion(on) {
    reduced = !!on;
  }

  function dispose() {
    cancelPending();
    controls.enabled = true;
  }

  return {
    setAnchor,
    snap,
    setView,
    setZoom,
    get view() { return currentView; },
    get isAnimating() { return !!anim || !!pendingResolve; },
    update,
    setReducedMotion,
    dispose,
  };
}
