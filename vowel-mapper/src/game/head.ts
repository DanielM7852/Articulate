import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { MIN_POINTS } from '../reference/check';
import { EH_RADIUS_V1 } from '../reference/data';
import type { VoiceProfile } from './targets';

type Formants = { f1: number; f2: number };
type Timed = Formants & { timestampMs: number };

/** Every path, model or learner, is compared as this many points spread evenly over the word's own duration. */
export const PATH_POINTS = 12;
/** Three close attempts in a row count as matching the model voice. */
export const MATCH_STREAK = 3;

/** One model voice saying "head", measured offline by this tracker. Paths are natural-log Hz. */
export interface HeadModel {
  id: string;
  version: number;
  word: string;
  path: readonly (readonly [number, number])[];
  /** The model speaker's own voice multiplier, from the same "uh" + voice group rule as learners. */
  factor: number;
  /** Mean path distance, in /ɛ/ reference radii, still counted as close to the model. */
  threshold: number;
  takes: number;
  /** The best take's tracked word, and where it starts in the shipped audio, for the "watch the model" dot. */
  durationMs?: number;
  audioLeadMs?: number;
}

/** The longest unbroken stretch of tracked sound. The tracker starts a new segment after a gap or a jump. */
export function wordPath<T extends VowelPoint>(points: readonly T[]): T[] {
  const runs = new Map<number, T[]>();
  for (const point of points) { const run = runs.get(point.segment); if (run) run.push(point); else runs.set(point.segment, [point]); }
  return [...runs.values()].reduce<T[]>((best, run) => run.length > best.length ? run : best, []);
}

/** Linear in log Hz over normalised time. Null below the 12 tracked points a held vowel needs. */
export function resamplePath(points: readonly Timed[], count = PATH_POINTS): Formants[] | null {
  if (points.length < MIN_POINTS) return null;
  const t0 = points[0].timestampMs, span = points.at(-1)!.timestampMs - t0;
  let j = 0;
  return Array.from({ length: count }, (_, i) => {
    const t = t0 + span * i / (count - 1);
    while (j < points.length - 2 && points[j + 1].timestampMs < t) j++;
    const a = points[j], b = points[j + 1];
    const w = b.timestampMs > a.timestampMs ? Math.min(1, Math.max(0, (t - a.timestampMs) / (b.timestampMs - a.timestampMs))) : 0;
    return { f1: Math.exp(Math.log(a.f1) + w * Math.log(b.f1 / a.f1)), f2: Math.exp(Math.log(a.f2) + w * Math.log(b.f2 / a.f2)) };
  });
}

/** Mean per-point distance in /ɛ/ reference radii: 1 = one radius away on average. */
export function pathDistance(a: readonly Formants[], b: readonly Formants[], radius: readonly [number, number] = EH_RADIUS_V1) {
  const each = a.map((p, i) => Math.hypot(Math.log(p.f1 / b[i].f1) / radius[0], Math.log(p.f2 / b[i].f2) / radius[1]));
  return each.reduce((sum, d) => sum + d, 0) / each.length;
}

/** The model path drawn for a learner: one log shift by the difference between the two voice multipliers. */
export function targetPath(model: Pick<HeadModel, 'path' | 'factor'>, learnerFactor: number): Formants[] {
  const shift = learnerFactor - model.factor;
  return model.path.map(([f1, f2]) => ({ f1: Math.exp(f1 + shift), f2: Math.exp(f2 + shift) }));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (sorted: number[], p: number) => {
  const at = p * (sorted.length - 1), low = Math.floor(at);
  return low + 1 < sorted.length ? sorted[low] + (at - low) * (sorted[low + 1] - sorted[low]) : sorted[low];
};

/** Per-point log-median of the model's takes. "Close" = within 1.5 × the model's own 90th-percentile repeat-to-repeat spread. */
export function modelFromTakes(takes: readonly Formants[][]) {
  const path = takes[0].map((_, i) => [median(takes.map((take) => Math.log(take[i].f1))), median(takes.map((take) => Math.log(take[i].f2)))] as const);
  const hz = path.map(([f1, f2]) => ({ f1: Math.exp(f1), f2: Math.exp(f2) }));
  const spread = takes.map((take) => pathDistance(take, hz)).sort((a, b) => a - b);
  return { path, spread, threshold: 1.5 * percentile(spread, 0.9) };
}

export interface HeadAttempt {
  index: number;
  /** "unheard": too little tracked sound to compare. Never counted for or against the learner. */
  outcome: 'measured' | 'unheard';
  points: Formants[];
  path?: Formants[];
  distance?: number;
  matched?: boolean;
}

export interface HeadSnapshot {
  phase: 'listening' | 'hearing' | 'resting' | 'matched';
  /** The attempt being said right now, as tracked. */
  live: Formants[];
  attempts: HeadAttempt[];
  streak: number;
  target: Formants[];
}

export interface HeadPracticeOptions {
  /** An attempt ends once nothing has been tracked for this long. */
  endGapMs: number;
  maxMs: number;
  restMs: number;
  /** Fewer tracked points than this is a blip, not a word, and is dropped without a result. */
  minPoints: number;
}

const DEFAULTS: HeadPracticeOptions = { endGapMs: 250, maxMs: 4000, restMs: 800, minPoints: 4 };

/** Say "head", see the path against the model's, repeat until three in a row are close. Pure: no clock of its own. */
export class HeadPractice {
  readonly options: HeadPracticeOptions;
  readonly target: Formants[];
  private phase: HeadSnapshot['phase'] = 'listening';
  private live: VowelPoint[] = [];
  private startedAtMs = 0;
  private restUntilMs = 0;
  private streak = 0;
  private readonly attempts: HeadAttempt[] = [];

  constructor(readonly model: HeadModel, readonly profile: VoiceProfile, options: Partial<HeadPracticeOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.target = targetPath(model, profile.factor);
  }

  snapshot(): HeadSnapshot {
    return {
      phase: this.phase,
      live: this.live.map(({ f1, f2 }) => ({ f1, f2 })),
      attempts: this.attempts.map((attempt) => ({ ...attempt })),
      streak: this.streak,
      target: this.target,
    };
  }

  push(frame: TrackedFrame): HeadSnapshot {
    const t = frame.timestampMs, point = frame.status === 'tracking' ? frame.point : null;
    if (this.phase === 'resting' && t >= this.restUntilMs) this.phase = 'listening';
    if (this.phase === 'listening' && point) { this.phase = 'hearing'; this.startedAtMs = t; }
    if (this.phase === 'hearing') {
      if (point) this.live.push(point);
      const last = this.live.at(-1)?.timestampMs ?? t;
      if (t - last >= this.options.endGapMs || t - this.startedAtMs >= this.options.maxMs) this.resolve(t);
    }
    return this.snapshot();
  }

  private resolve(t: number) {
    const points = this.live;
    this.live = [];
    if (points.length < this.options.minPoints) { this.phase = 'listening'; return; }
    const path = resamplePath(wordPath(points));
    const attempt: HeadAttempt = { index: this.attempts.length, outcome: path ? 'measured' : 'unheard', points: points.map(({ f1, f2 }) => ({ f1, f2 })) };
    if (path) {
      attempt.path = path;
      attempt.distance = pathDistance(path, this.target);
      attempt.matched = attempt.distance <= this.model.threshold;
      this.streak = attempt.matched ? this.streak + 1 : 0;
    }
    this.attempts.push(attempt);
    this.phase = this.streak >= MATCH_STREAK ? 'matched' : 'resting';
    this.restUntilMs = t + this.options.restMs;
  }
}
