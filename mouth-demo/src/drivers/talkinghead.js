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

/**
 * A calm "demo" mood. The library's neutral idle sways the whole upper body, darts
 * the eyes around and fidgets the mouth, which pulls attention from the mouth shape
 * being demonstrated. Here the guide breathes, blinks and drifts its head very
 * slightly; the eyes are driven by the demo itself (gaze toward the learner).
 */
const DROPPED_ANIMS = new Set(["mouth", "misc", "head", "eyes"]);
const GENTLE_HEAD = {
  name: "head",
  idle: { delay: [1000, 3000], dt: [[2500, 6000]], vs: { bodyRotateX: [[-0.015, 0.03]], bodyRotateY: [[-0.05, 0.05]], bodyRotateZ: [[-0.02, 0.02]] } },
  speaking: { dt: [[0, 1000, 0]], vs: { bodyRotateX: [[-0.02, 0.05, 1, 2]], bodyRotateY: [[-0.04, 0.04]], bodyRotateZ: [[-0.03, 0.03]] } },
};

function installDemoMood(head) {
  const neutral = head.animMoods.neutral;
  head.animMoods.demo = {
    ...neutral,
    anims: [...neutral.anims.filter((a) => !DROPPED_ANIMS.has(a.name)), GENTLE_HEAD],
  };
  head.setMood("demo");
  // setMood does not remove anims that the new mood lacks.
  head.animQueue = head.animQueue.filter((a) => !DROPPED_ANIMS.has(a.template?.name));
  // animate() also nudges the baseline of one random shape per frame. Keep that to the
  // brows only, so the lips and eyes stay still between demonstrations. (The list must
  // not be empty: animate() indexes into it every frame.)
  const isBrow = (n) => n.startsWith("brow");
  for (const n of head.mtRandomized.filter((n) => !isBrow(n))) {
    const mt = head.mtAvatar[n];
    if (mt) Object.assign(mt, { base: head.mood.baseline[n] || 0, needsUpdate: true });
  }
  const brows = head.mtRandomized.filter(isBrow);
  head.mtRandomized = brows.length ? brows : head.mtRandomized.slice(0, 1);
}

export async function createTalkingHeadDriver({ container, scene, camera, url, signal }) {
  let head = null;
  try {
    head = new TalkingHead(container, {
      avatarOnly: true,
      avatarOnlyCamera: camera,
      avatarOnlyScene: scene,
      lipsyncModules: [],
      modelMovementFactor: 0.12,
      avatarIdleHeadMove: 0,
      avatarIdleEyeContact: 0,
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
