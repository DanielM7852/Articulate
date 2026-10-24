export const CUES = {
  "round-lips": {
    sound: "oo", caption: "Round your lips, like saying “oo”.",
    shapes: { mouthPucker: 0.85, mouthFunnel: 0.5, jawOpen: 0.15 },
    cutawayPose: "oo",
  },
  "spread-lips": {
    sound: "ee", caption: "Spread your lips, like a small smile.",
    shapes: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, jawOpen: 0.1 },
    cutawayPose: "ee",
  },
  "open-jaw": {
    sound: "ah", caption: "Drop your jaw and open wide.",
    shapes: { jawOpen: 0.65, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
    cutawayPose: "ah",
  },
};

export const CUE_SHAPE_NAMES = ["jawOpen", "mouthPucker", "mouthFunnel", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight"];
