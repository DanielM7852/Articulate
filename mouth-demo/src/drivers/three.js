import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CUE_SHAPE_NAMES } from "../cues.js";

const BLINK_MS = 150;

function collectMorphMeshes(root) {
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary) meshes.push(o);
  });
  return meshes;
}

function reportMorphs(meshes) {
  for (const m of meshes) {
    console.log(`[three] ${m.name}:`, Object.keys(m.morphTargetDictionary).join(", "));
  }
  for (const name of CUE_SHAPE_NAMES) {
    if (!meshes.some((m) => name in m.morphTargetDictionary)) {
      console.warn(`[three] model is missing blend shape "${name}"`);
    }
  }
}

function applyShape(meshes, name, v) {
  for (const m of meshes) {
    const i = m.morphTargetDictionary[name];
    if (i !== undefined) m.morphTargetInfluences[i] = v;
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const mat of mats) {
      for (const val of Object.values(mat)) {
        if (val && val.isTexture) val.dispose();
      }
      mat.dispose();
    }
  });
}

const nextBlinkDelay = () => 3000 + Math.random() * 3000;

export async function createThreeDriver({ scene, url }) {
  const gltf = await new GLTFLoader().loadAsync(url);
  scene.add(gltf.scene);
  const root = gltf.scene.getObjectByName("Armature") ?? gltf.scene;

  const fail = (msg) => {
    scene.remove(gltf.scene);
    disposeTree(gltf.scene);
    throw new Error(msg);
  };

  const headBone = root.getObjectByName("Head") ?? root.getObjectByName("mixamorigHead");
  if (!headBone) fail("three: Head bone not found");

  const morphMeshes = collectMorphMeshes(root);
  reportMorphs(morphMeshes);

  let untilBlink = nextBlinkDelay();
  let blinkT = -1;

  function setBlink(v) {
    applyShape(morphMeshes, "eyeBlinkLeft", v);
    applyShape(morphMeshes, "eyeBlinkRight", v);
  }

  return {
    name: "three",
    root,
    headBone,
    morphMeshes,
    setShape(name, v) {
      applyShape(morphMeshes, name, v);
    },
    releaseShapes(names) {
      for (const name of names) applyShape(morphMeshes, name, 0);
    },
    update(dtMs) {
      if (blinkT < 0) {
        untilBlink -= dtMs;
        if (untilBlink > 0) return;
        blinkT = 0;
      }
      blinkT += dtMs;
      if (blinkT >= BLINK_MS) {
        blinkT = -1;
        untilBlink = nextBlinkDelay();
        setBlink(0);
        return;
      }
      const p = blinkT / BLINK_MS;
      setBlink(p < 0.5 ? p * 2 : (1 - p) * 2);
    },
    dispose() {
      scene.remove(gltf.scene);
      disposeTree(gltf.scene);
    },
  };
}
