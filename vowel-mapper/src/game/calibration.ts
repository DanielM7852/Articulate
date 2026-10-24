import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { VOWELS, zoneDistance, type VowelId, type Zone, type ZoneSet } from './zones';

export type CalibrationProblem =
  | { kind: 'too-few-points'; vowel: VowelId; count: number; needed: number }
  | { kind: 'too-close'; vowels: [VowelId, VowelId] };

export type ZoneResult = { ok: true; zone: Zone; count: number } | { ok: false; problem: CalibrationProblem };
export type CalibrationResult = { ok: true; zones: ZoneSet } | { ok: false; problems: CalibrationProblem[] };

export const CALIBRATION = {
  /** About 300 ms of tracked sound at the 25 ms hop. */
  minPoints: 12,
  minRadius: 0.2,
  maxRadius: 0.35,
  /** Zone radius as a multiple of the 80th-percentile spread of the player's points. */
  spreadScale: 1.5,
  /** Each radius is capped at this share of the distance to the nearest other zone. */
  overlapShare: 0.45,
  /** Below this radius after capping, two zones are effectively the same sound. */
  tooCloseRadius: 0.12,
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Never a textbook value: the centre is the median of this player's own tracked points. */
export function zoneFromPoints(vowel: VowelId, points: VowelPoint[]): ZoneResult {
  if (points.length < CALIBRATION.minPoints) {
    return { ok: false, problem: { kind: 'too-few-points', vowel, count: points.length, needed: CALIBRATION.minPoints } };
  }
  const centre = {
    f1: Math.exp(median(points.map((p) => Math.log(p.f1)))),
    f2: Math.exp(median(points.map((p) => Math.log(p.f2)))),
  };
  const distances = points.map((p) => zoneDistance(p, centre)).sort((a, b) => a - b);
  const spread = distances[Math.floor(distances.length * 0.8)];
  const radius = Math.min(CALIBRATION.maxRadius, Math.max(CALIBRATION.minRadius, spread * CALIBRATION.spreadScale));
  return { ok: true, zone: { vowel, ...centre, radius }, count: points.length };
}

export function buildZones(pointsByVowel: Record<VowelId, VowelPoint[]>): CalibrationResult {
  const problems: CalibrationProblem[] = [];
  const zones: Partial<ZoneSet> = {};
  for (const vowel of VOWELS) {
    const result = zoneFromPoints(vowel, pointsByVowel[vowel]);
    if (result.ok) zones[vowel] = result.zone;
    else problems.push(result.problem);
  }
  const built = VOWELS.flatMap((vowel) => zones[vowel] ?? []);
  for (const zone of built) {
    const others = built.filter((other) => other !== zone);
    if (!others.length) continue;
    const nearest = Math.min(...others.map((other) => zoneDistance(zone, other)));
    zone.radius = Math.min(zone.radius, nearest * CALIBRATION.overlapShare);
  }
  for (let i = 0; i < built.length; i++) for (let j = i + 1; j < built.length; j++) {
    const a = built[i], b = built[j];
    if (zoneDistance(a, b) * CALIBRATION.overlapShare < CALIBRATION.tooCloseRadius) problems.push({ kind: 'too-close', vowels: [a.vowel, b.vowel] });
  }
  return problems.length ? { ok: false, problems } : { ok: true, zones: zones as ZoneSet };
}

export type WarmUpState =
  | { kind: 'rest'; next: VowelId; untilMs: number }
  | { kind: 'collecting'; vowel: VowelId; startedAtMs: number; timeoutAtMs: number; collected: number; target: number }
  | { kind: 'done'; result: CalibrationResult; counts: Record<VowelId, number> };

export interface WarmUpOptions {
  /** Pause before each phase, so the player can read the next prompt and stop the previous sound. */
  restMs: number;
  /** Points at the start of a phase are ignored; they are often the tail of the previous sound. */
  settleMs: number;
  /** A phase ends once this many points are collected (about 1 s of tracked sound)... */
  targetPoints: number;
  /** ...or after this long, whichever comes first. */
  timeoutMs: number;
}

export const WARM_UP_DEFAULTS: WarmUpOptions = { restMs: 1200, settleMs: 300, targetPoints: 40, timeoutMs: 6000 };

/** Hold eee, ah, oo in turn. Driven only by the frame stream, so it is deterministic to test. */
export class WarmUp {
  readonly options: WarmUpOptions;
  private index = 0;
  private state: WarmUpState | null = null;
  private readonly points: Record<VowelId, VowelPoint[]> = { ee: [], ah: [], oo: [] };

  constructor(options: Partial<WarmUpOptions> = {}) {
    this.options = { ...WARM_UP_DEFAULTS, ...options };
  }

  current(): WarmUpState | null {
    return this.state;
  }

  push(frame: TrackedFrame): WarmUpState {
    const t = frame.timestampMs;
    const { restMs, settleMs, targetPoints, timeoutMs } = this.options;
    if (!this.state) this.state = { kind: 'rest', next: VOWELS[0], untilMs: t + restMs };
    const state = this.state;
    if (state.kind === 'rest' && t >= state.untilMs) {
      this.state = { kind: 'collecting', vowel: state.next, startedAtMs: t, timeoutAtMs: t + timeoutMs, collected: 0, target: targetPoints };
    } else if (state.kind === 'collecting') {
      const bucket = this.points[state.vowel];
      if (frame.status === 'tracking' && frame.point && t - state.startedAtMs >= settleMs) bucket.push(frame.point);
      if (bucket.length >= targetPoints || t >= state.timeoutAtMs) {
        this.index++;
        this.state = this.index < VOWELS.length
          ? { kind: 'rest', next: VOWELS[this.index], untilMs: t + restMs }
          : { kind: 'done', result: buildZones(this.points), counts: { ee: this.points.ee.length, ah: this.points.ah.length, oo: this.points.oo.length } };
      } else {
        this.state = { ...state, collected: bucket.length };
      }
    }
    return this.state;
  }
}
