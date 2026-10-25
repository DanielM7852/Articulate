export const CUES = {
  "round-lips": {
    sound: "oo", caption: "Round your lips, like saying “oo”.",
    shapes: { mouthPucker: 1.0, mouthFunnel: 0.8, jawOpen: 0.12 },
    cutawayPose: "oo",
    label: "Lips round, tongue back",
  },
  "spread-lips": {
    sound: "ee", caption: "Spread your lips, like a small smile.",
    shapes: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, jawOpen: 0.1 },
    cutawayPose: "ee",
    label: "Lips spread, tongue high and forward",
  },
  "open-jaw": {
    sound: "ah", caption: "Drop your jaw and open wide.",
    shapes: { jawOpen: 0.65, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
    cutawayPose: "ah",
    label: "Jaw open, tongue low",
  },
  "tongue-tip": {
    sound: "t", caption: "Tongue tip up behind the top teeth, then let go.",
    shapes: { jawOpen: 0.18, mouthLowerDownLeft: 0.08, mouthLowerDownRight: 0.08 },
    cutawayPose: "tongueTip", marker: "ridge",
    label: "Tip up, behind the top teeth",
  },
  "tongue-tip-r": {
    sound: "tr", caption: "Tongue tip up behind the top teeth, then pull it back for the r.",
    shapes: { jawOpen: 0.18, mouthLowerDownLeft: 0.08, mouthLowerDownRight: 0.08 },
    cutawayPose: "tongueTip", then: "r", marker: "ridge",
    label: "Tip up, behind the top teeth",
    labels: ["Tip up, behind the top teeth", "Then pull it back for the r"],
  },
  "tongue-r": {
    sound: "r", caption: "Curl the tongue tip back, or bunch it up. Lips a little round.",
    shapes: { jawOpen: 0.15, mouthPucker: 0.3, mouthFunnel: 0.2 },
    cutawayPose: "r",
    label: "Tip back, lips a little round",
  },
  "tongue-back": {
    sound: "k", caption: "Back of the tongue up against the soft roof, then release.",
    shapes: { jawOpen: 0.2, mouthLowerDownLeft: 0.06, mouthLowerDownRight: 0.06 },
    cutawayPose: "velar", marker: "velum",
    label: "Back of the tongue up",
  },
};

export const CUE_SHAPE_NAMES = ["jawOpen", "mouthPucker", "mouthFunnel", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight"];
