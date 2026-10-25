import * as THREE from "three";

const TOP_N = 60;

function pickMesh(morphMeshes) {
  const cands = (morphMeshes || []).filter(
    (m) => m.morphTargetDictionary && m.morphTargetDictionary.mouthPucker !== undefined
  );
  if (!cands.length) return null;
  const head = cands.find((m) => m.name.includes("Head"));
  if (head) return head;
  return cands.reduce((a, b) =>
    b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a
  );
}

export function computeMouthAnchor(driver) {
  const mesh = pickMesh(driver.morphMeshes);
  const morph = mesh && mesh.geometry.morphAttributes.position?.[mesh.morphTargetDictionary.mouthPucker];
  if (!mesh || !morph) {
    console.warn("computeMouthAnchor: no mesh with a mouthPucker morph, using fallback");
    return {
      mesh: null,
      restCenter: new THREE.Vector3(0, 1.55, 0.09),
      radius: 0.03,
      headLocal: new THREE.Vector3(0, 0, 0.1),
    };
  }

  const geo = mesh.geometry;
  const base = geo.attributes.position;
  const n = base.count;
  const mags = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mags[i] = Math.hypot(morph.getX(i), morph.getY(i), morph.getZ(i));
  }
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => mags[b] - mags[a])
    .slice(0, Math.min(TOP_N, n));

  const restCenter = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const i of idx) restCenter.add(v.fromBufferAttribute(base, i));
  restCenter.divideScalar(idx.length);

  let maxD = 0;
  for (const i of idx) {
    v.fromBufferAttribute(base, i);
    maxD = Math.max(maxD, Math.hypot(v.x - restCenter.x, v.y - restCenter.y));
  }
  const radius = Math.min(0.05, Math.max(0.02, maxD));

  driver.root.updateMatrixWorld(true);
  if (mesh.skeleton) mesh.skeleton.update();
  const world = new THREE.Vector3();
  for (const i of idx) {
    mesh.getVertexPosition(i, v);
    mesh.localToWorld(v);
    world.add(v);
  }
  world.divideScalar(idx.length);
  const headLocal = driver.headBone.worldToLocal(world);

  // The mouth sits at the front of the head, so a side view centred on it pushes the back of the head
  // out of frame. sideShift moves the side-view pivot (head-local) to the middle of the head's depth.
  const toHead = new THREE.Matrix4().copy(driver.headBone.matrixWorld).invert();
  let zMin = Infinity;
  let zMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v);
    v.applyMatrix4(mesh.matrixWorld).applyMatrix4(toHead);
    if (v.z < zMin) zMin = v.z;
    if (v.z > zMax) zMax = v.z;
    if (v.y < yMin) yMin = v.y;
    if (v.y > yMax) yMax = v.y;
  }
  const ok = Number.isFinite(zMin);
  const sideShift = new THREE.Vector3(0, 0, ok ? (zMin + zMax) / 2 - headLocal.z : 0);
  const headDepth = ok ? zMax - zMin : 0;
  const headHeight = ok ? yMax - yMin : 0;

  return { mesh, restCenter, radius, headLocal, sideShift, headDepth, headHeight };
}
