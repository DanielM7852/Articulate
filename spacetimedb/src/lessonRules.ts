// Bounded lesson settings. Teachers pick from this list; nothing here is a clinical prescription.
export const TARGETS = ["i", "u", "a", "head"] as const;
export const CONTEXTS = ["sound", "word", "phrase"] as const;
export const CUES = ["", "spread-lips", "round-lips", "open-jaw"] as const;
export const ASSISTANCE = ["cue-target", "target-only", "none"] as const;
export const PERFORMANCE_FINDINGS = [
  "mouth_more_open",
  "mouth_less_open",
  "tongue_forward",
  "tongue_back",
  "finish",
] as const;
export const CAPTURE_FINDINGS = ["silence", "clipping", "too_short", "no_mic", "insufficient"] as const;

/** Engineering rule: this many recent verified, comparable performance findings. */
export const MIN_REPEAT = 3;
export const MAX_REPS = 8;
export const MAX_NOTE = 160;

export type LessonSettings = {
  target: (typeof TARGETS)[number];
  context: (typeof CONTEXTS)[number];
  cueId: (typeof CUES)[number];
  assistance: (typeof ASSISTANCE)[number];
  referenceReplay: boolean;
  repetitions: number;
  note: string;
};

const KEYS = ["target", "context", "cueId", "assistance", "referenceReplay", "repetitions", "note"] as const;

export function defaultSettings(): LessonSettings {
  return {
    target: "i",
    context: "sound",
    cueId: "spread-lips",
    assistance: "cue-target",
    referenceReplay: false,
    repetitions: 1,
    note: "",
  };
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

export function parseSettings(raw: string): LessonSettings {
  if (raw.length > 800) throw new Error("invalid settings");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid settings");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid settings");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!KEYS.includes(key as (typeof KEYS)[number])) throw new Error("invalid settings");
  if (!includes(TARGETS, obj.target) || !includes(CONTEXTS, obj.context)) throw new Error("invalid settings");
  if (!includes(CUES, obj.cueId) || !includes(ASSISTANCE, obj.assistance)) throw new Error("invalid settings");
  if (typeof obj.referenceReplay !== "boolean") throw new Error("invalid settings");
  if (typeof obj.repetitions !== "number" || !Number.isInteger(obj.repetitions) || obj.repetitions < 1 || obj.repetitions > MAX_REPS) {
    throw new Error("invalid settings");
  }
  if (typeof obj.note !== "string" || obj.note.length > MAX_NOTE) throw new Error("invalid settings");
  if (/[<>`{}]|javascript:|\n|\r/i.test(obj.note)) throw new Error("invalid settings");
  return {
    target: obj.target,
    context: obj.context,
    cueId: obj.cueId,
    assistance: obj.assistance,
    referenceReplay: obj.referenceReplay,
    repetitions: obj.repetitions,
    note: obj.note,
  };
}

export function canonical(settings: LessonSettings): string {
  return JSON.stringify({
    target: settings.target,
    context: settings.context,
    cueId: settings.cueId,
    assistance: settings.assistance,
    referenceReplay: settings.referenceReplay,
    repetitions: settings.repetitions,
    note: settings.note,
  });
}

export function describe(settings: LessonSettings): string {
  const cue = settings.cueId === "" ? "no cue" : settings.cueId;
  const replay = settings.referenceReplay ? "on" : "off";
  const note = settings.note ? ` Note: ${settings.note}` : "";
  return `Target ${settings.target}. Context ${settings.context}. Cue ${cue}. Assistance ${settings.assistance}. Reference replay ${replay}. Repetitions ${settings.repetitions}.${note}`;
}

export function describeChange(previous: LessonSettings | null, next: LessonSettings): string {
  if (!previous) return describe(next);
  const parts: string[] = [];
  if (previous.target !== next.target) parts.push(`Target ${previous.target} -> ${next.target}`);
  if (previous.context !== next.context) parts.push(`Context ${previous.context} -> ${next.context}`);
  if (previous.cueId !== next.cueId) parts.push(`Cue ${previous.cueId || "none"} -> ${next.cueId || "none"}`);
  if (previous.assistance !== next.assistance) parts.push(`Assistance ${previous.assistance} -> ${next.assistance}`);
  if (previous.referenceReplay !== next.referenceReplay) parts.push(`Reference replay ${next.referenceReplay ? "on" : "off"} -> ${next.referenceReplay ? "on" : "off"}`);
  if (previous.repetitions !== next.repetitions) parts.push(`Repetitions ${previous.repetitions} -> ${next.repetitions}`);
  if (previous.note !== next.note) parts.push(next.note ? `Note: ${next.note}` : "Note cleared");
  return parts.length ? `${parts.join(". ")}.` : "No visible setting changed.";
}

export function findingKind(finding: string): "performance" | "capture" | "none" {
  if (finding === "" || finding === "none") return "none";
  if ((CAPTURE_FINDINGS as readonly string[]).includes(finding)) return "capture";
  if ((PERFORMANCE_FINDINGS as readonly string[]).includes(finding)) return "performance";
  throw new Error("invalid settings");
}
