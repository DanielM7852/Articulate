import { TalkingHead } from "@met4citizen/talkinghead";
import { CUE_SHAPE_NAMES } from "../cues.js";

function collectMorphMeshes(root) {
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary) meshes.push(o);
  });
  return meshes;
}

function warnMissingShapes(meshes) {
  for (const name of CUE_SHAPE_NAMES) {
    if (!meshes.some((m) => name in m.morphTargetDictionary)) {
      console.warn(`[talkinghead] model is missing blend shape "${name}"`);
    }
  }
}

function installDemoMood(head) {
  const neutral = head.animMoods.neutral;
  head.animMoods.demo = {
    ...neutral,
    anims: neutral.anims.filter((a) => a.name !== "mouth"),
  };
  head.setMood("demo");
  // setMood does not remove anims that the new mood lacks.
  head.animQueue = head.animQueue.filter((a) => a.template?.name !== "mouth");
  // animate() also nudges the baseline of one random shape per frame; keep that to brows,
  // nose and cheek squints so the lips stay still between demonstrations.
  const isMouth = (n) => n.startsWith("mouth") || n === "cheekPuff";
  for (const n of head.mtRandomized.filter(isMouth)) {
    const mt = head.mtAvatar[n];
    if (mt) Object.assign(mt, { base: head.mood.baseline[n] || 0, needsUpdate: true });
  }
  head.mtRandomized = head.mtRandomized.filter((n) => !isMouth(n));
}

export async function createTalkingHeadDriver({ container, scene, camera, url, signal }) {
  let head = null;
  try {
    head = new TalkingHead(container, {
      avatarOnly: true,
      avatarOnlyCamera: camera,
      avatarOnlyScene: scene,
      lipsyncModules: [],
      modelMovementFactor: 0.2,
      avatarIdleHeadMove: 0.15,
      avatarIdleEyeContact: 0.3,
      avatarIgnoreCamera: true,
    });
    await head.showAvatar({ url, body: "F", avatarMood: "neutral" });
    if (signal?.aborted) throw new Error("aborted");

    installDemoMood(head);
    head.start();

    const root = head.armature;
    const headBone = root?.getObjectByName("Head") ?? root?.getObjectByName("mixamorigHead");
    if (!headBone) throw new Error("talkinghead: Head bone not found");
    const morphMeshes = collectMorphMeshes(root);
    warnMissingShapes(morphMeshes);

    const h = head;
    return {
      name: "talkinghead",
      root,
      headBone,
      morphMeshes,
      setShape(name, v) {
        const mt = h.mtAvatar[name];
        if (mt) Object.assign(mt, { realtime: v, needsUpdate: true });
        // alternative: h.setFixedValue(name, v);
      },
      releaseShapes(names) {
        for (const name of names) {
          const mt = h.mtAvatar[name];
          if (mt) Object.assign(mt, { realtime: null, needsUpdate: true });
        }
      },
      update(dtMs) {
        h.animate(dtMs);
      },
      dispose() {
        h.dispose();
      },
    };
  } catch (err) {
    try {
      head?.dispose();
    } catch (e) {
      console.warn("[talkinghead] dispose after failure:", e);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
