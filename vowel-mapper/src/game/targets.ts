import type { TrackedFrame, VowelPoint } from '../audio/tracker';
import { distance, factorFrom, holdValue, type CalibrationVowel, type TargetVowel } from '../reference/check';
import { VOICE_SIZE_V1 } from '../reference/data';

type Formants = { f1: number; f2: number };

/** The two vowels with a voice-sized reference target. "oo" has none: the tracker's /u/ scatters too widely. */
export type TargetSound = 'ee' | 'ah';
/** The player says where they are; noise is not detected automatically. */
export type Place = 'quiet' | 'noisy';

const REF: Record<TargetSound, TargetVowel> = { ee: 'iy', ah: 'ah' };

/** Ring edges in reference radii, closest first. Graded distance only: no ring is a pass mark. */
export const RINGS = [0.5, 1, 1.5] as const;
export type Ring = 1 | 2 | 3;

export function ringFor(d: number): Ring | null {
  const index = RINGS.findIndex((edge) => d <= edge);
  return index < 0 ? null : (index + 1) as Ring;
}

export function targetDistance(value: Formants, sound: TargetSound, factor: number) {
  return distance(value, REF[sound], factor);
}

/** Matches the coach's `distance_change_threshold`, so "closer" means the same thing in both places. */
export const TREND_THRESHOLD = 0.1;

export interface VoiceProfile {
  version: 1;
  /** Natural-log voice multiplier: every target is drawn at exp(factor) × the reference. */
  factor: number;
  place: Place;
  /** "words": from head / had / heard. "approximate": from one held "uh" and a chosen voice group. */
  sizing: 'words' | 'approximate';
  /** Where the player's ee and ah were before practice. Shown, never used as a target. */
  start: Partial<Record<TargetSound, Formants>>;
  measuredAt: number;
}

export interface CheckPrompt { word: string; ref: CalibrationVowel | TargetVowel | 'uh'; say: string; start?: TargetSound }

const STARTS: CheckPrompt[] = [
  { word: 'see', ref: 'iy', say: 'eeee', start: 'ee' },
  { word: 'spa', ref: 'ah', say: 'ahhh', start: 'ah' },
];
/** head / had / heard set the multiplier; see / spa record the starting ee and ah. */
export const CHECK_PROMPTS: readonly CheckPrompt[] = [
  { word: 'head', ref: 'eh', say: 'ehhh' },
  { word: 'had', ref: 'ae', say: 'aaah, as in cat' },
  { word: 'heard', ref: 'er', say: 'errr' },
  ...STARTS,
];
/** For learners who can't say the check words yet: the relaxed "uh" is the easiest vowel to hold. */
export const UH_PROMPTS: readonly CheckPrompt[] = [{ word: 'uh', ref: 'uh', say: 'uhhh, as in cup' }, ...STARTS];

export type VoiceGroup = keyof typeof VOICE_SIZE_V1.groupFactor;
export type Sizing = { kind: 'words' } | { kind: 'uh'; group: VoiceGroup };

/** Amendment 3: the mean of the held "uh" factor and the chosen group's mean factor. */
export function uhFactor(uh: Formants, group: VoiceGroup) {
  const fromUh = (Math.log(uh.f1) - VOICE_SIZE_V1.uh[0] + Math.log(uh.f2) - VOICE_SIZE_V1.uh[1]) / 2;
  return (fromUh + VOICE_SIZE_V1.groupFactor[group]) / 2;
}

export type VoiceCheckState =
  | { kind: 'rest'; index: number; untilMs: number }
  | { kind: 'collecting'; index: number; startedAtMs: number; timeoutAtMs: number; collected: number; target: number }
  | { kind: 'done'; ok: true; profile: VoiceProfile }
  | { kind: 'done'; ok: false; missed: string[] };

export interface VoiceCheckOptions {
  restMs: number;
  /** Points at the start of a prompt are ignored; they are often the tail of the previous sound. */
  settleMs: number;
  /** A prompt ends after this many points (about 1 s of tracked sound) or the timeout. */
  targetPoints: number;
  timeoutMs: number;
  /** Also record the starting ee and ah. A lesson that only needs the voice size can skip them. */
  starts: boolean;
  now: () => number;
}

const CHECK_DEFAULTS: VoiceCheckOptions = { restMs: 1200, settleMs: 300, targetPoints: 40, timeoutMs: 6000, starts: true, now: () => Date.now() };

/** The 10-second voice check. Frame-driven like the warm-up, so it is deterministic to test. */
export class VoiceCheck {
  readonly options: VoiceCheckOptions;
  private state: VoiceCheckState | null = null;
  readonly prompts: readonly CheckPrompt[];
  private readonly points: VowelPoint[][];

  constructor(readonly place: Place, readonly sizing: Sizing = { kind: 'words' }, options: Partial<VoiceCheckOptions> = {}) {
    this.options = { ...CHECK_DEFAULTS, ...options };
    this.prompts = (sizing.kind === 'words' ? CHECK_PROMPTS : UH_PROMPTS).filter((prompt) => this.options.starts || !prompt.start);
    this.points = this.prompts.map(() => []);
  }

  push(frame: TrackedFrame): VoiceCheckState {
    const t = frame.timestampMs;
    const { restMs, settleMs, targetPoints, timeoutMs } = this.options;
    if (!this.state) this.state = { kind: 'rest', index: 0, untilMs: t + restMs };
    const state = this.state;
    if (state.kind === 'rest' && t >= state.untilMs) {
      this.state = { kind: 'collecting', index: state.index, startedAtMs: t, timeoutAtMs: t + timeoutMs, collected: 0, target: targetPoints };
    } else if (state.kind === 'collecting') {
      const bucket = this.points[state.index];
      if (frame.status === 'tracking' && frame.point && t - state.startedAtMs >= settleMs) bucket.push(frame.point);
      if (bucket.length >= targetPoints || t >= state.timeoutAtMs) {
        const next = state.index + 1;
        this.state = next < this.prompts.length ? { kind: 'rest', index: next, untilMs: t + restMs } : this.finish();
      } else {
        this.state = { ...state, collected: bucket.length };
      }
    }
    return this.state;
  }

  private finish(): VoiceCheckState {
    const values = this.prompts.map((prompt, i) => ({ prompt, value: holdValue(this.points[i]) }));
    const calibration = values.filter(({ prompt }) => !prompt.start);
    const missed = calibration.filter(({ value }) => !value).map(({ prompt }) => prompt.word);
    if (missed.length) return { kind: 'done', ok: false, missed };
    let factor: number;
    if (this.sizing.kind === 'words') {
      factor = factorFrom(calibration.map(({ prompt, value }) => ({ vowel: prompt.ref as CalibrationVowel, value: value! })))!;
    } else factor = uhFactor(calibration[0].value!, this.sizing.group);
    const start: VoiceProfile['start'] = {};
    for (const { prompt, value } of values) if (prompt.start && value) start[prompt.start] = { f1: value.f1, f2: value.f2 };
    const sizing = this.sizing.kind === 'words' ? 'words' : 'approximate';
    return { kind: 'done', ok: true, profile: { version: 1, factor, place: this.place, sizing, start, measuredAt: this.options.now() } };
  }
}

export interface TargetStep { word: string; sound: TargetSound; letters: [string, string, string] }

/** Short words with no n or m: a nasal hum is tracked as a vowel and would land between targets. */
export const TARGET_STEPS: readonly TargetStep[] = [
  { word: 'ah', sound: 'ah', letters: ['', 'ah', ''] },
  { word: 'see', sound: 'ee', letters: ['s', 'ee', ''] },
  { word: 'spa', sound: 'ah', letters: ['sp', 'a', ''] },
  { word: 'key', sound: 'ee', letters: ['k', 'ey', ''] },
  { word: 'pa', sound: 'ah', letters: ['p', 'a', ''] },
  { word: 'tea', sound: 'ee', letters: ['t', 'ea', ''] },
];

/** "unscored": heard, but ee is not scored in a noisy room. "unheard" is never counted against the player. */
export type TargetOutcome = 'measured' | 'unscored' | 'unheard';
export type Trend = 'closer' | 'similar' | 'farther';

export interface TargetNote {
  index: number;
  status: 'upcoming' | 'resting' | 'waiting' | 'open' | 'resolved';
  outcome?: TargetOutcome;
  restUntilMs: number;
  windowEndMs: number;
  points: Formants[];
  /** Log-median of the attempt's tracked points. */
  value?: Formants;
  distance?: number;
  ring?: Ring | null;
  trend?: Trend;
}

export interface TargetSnapshot {
  phase: 'ready' | 'playing' | 'finished';
  timeMs: number;
  current: number | null;
  notes: TargetNote[];
}

export interface TargetRoundOptions {
  leadInMs: number;
  restMs: number;
  /** Time allowed once an attempt opens, plus capture and smoothing delay. */
  windowMs: number;
  /** An attempt resolves early once this many points are tracked (about 0.7 s). */
  targetPoints: number;
}

const ROUND_DEFAULTS: TargetRoundOptions = { leadInMs: 600, restMs: 900, windowMs: 2750, targetPoints: 28 };

/** Self-paced holds scored by distance to the voice-sized target. Pure: no clock of its own. */
export class TargetRound {
  readonly options: TargetRoundOptions;
  private started = false;
  private timeMs = 0;
  private readonly notes: TargetNote[];

  constructor(readonly steps: readonly TargetStep[], readonly profile: VoiceProfile, options: Partial<TargetRoundOptions> = {}) {
    this.options = { ...ROUND_DEFAULTS, ...options };
    this.notes = steps.map((_, index) => ({ index, status: 'upcoming', restUntilMs: NaN, windowEndMs: NaN, points: [] }));
  }

  snapshot(): TargetSnapshot {
    const current = this.notes.findIndex((note) => !note.outcome);
    return {
      phase: !this.started ? 'ready' : current < 0 ? 'finished' : 'playing',
      timeMs: this.timeMs,
      current: current < 0 ? null : current,
      notes: this.notes.map((note) => ({ ...note })),
    };
  }

  push(frame: TrackedFrame): TargetSnapshot {
    const t = frame.timestampMs;
    this.timeMs = t;
    if (!this.started) {
      this.started = true;
      if (this.notes.length) this.rest(this.notes[0], t + this.options.leadInMs);
    }
    const note = this.notes.find((candidate) => !candidate.outcome);
    if (note) this.advance(note, frame);
    return this.snapshot();
  }

  /** A visible button starts an attempt even when no vowel can be tracked. */
  beginAttempt(timestampMs = this.timeMs): TargetSnapshot {
    const note = this.notes.find((candidate) => !candidate.outcome);
    if (note?.status === 'waiting') this.open(note, timestampMs);
    return this.snapshot();
  }

  private rest(note: TargetNote, untilMs: number) {
    note.status = 'resting';
    note.restUntilMs = untilMs;
  }

  private open(note: TargetNote, t: number) {
    note.status = 'open';
    note.windowEndMs = t + this.options.windowMs;
  }

  private advance(note: TargetNote, frame: TrackedFrame) {
    const t = frame.timestampMs;
    if (note.status === 'resting' && t >= note.restUntilMs) note.status = 'waiting';
    // Rejected room noise must not start an attempt on the player's behalf.
    if (note.status === 'waiting' && frame.status === 'tracking' && frame.point) this.open(note, t);
    if (note.status !== 'open') return;
    if (frame.status === 'tracking' && frame.point) note.points.push({ f1: frame.point.f1, f2: frame.point.f2 });
    if (note.points.length >= this.options.targetPoints || t > note.windowEndMs) this.resolve(note, t);
  }

  private resolve(note: TargetNote, t: number) {
    const { sound } = this.steps[note.index];
    const value = holdValue(note.points);
    note.status = 'resolved';
    if (!value) note.outcome = 'unheard';
    else {
      note.value = { f1: value.f1, f2: value.f2 };
      if (sound === 'ee' && this.profile.place === 'noisy') note.outcome = 'unscored';
      else {
        note.outcome = 'measured';
        note.distance = targetDistance(value, sound, this.profile.factor);
        note.ring = ringFor(note.distance);
        const start = this.profile.start[sound];
        if (start) {
          const change = targetDistance(start, sound, this.profile.factor) - note.distance;
          note.trend = change > TREND_THRESHOLD ? 'closer' : change < -TREND_THRESHOLD ? 'farther' : 'similar';
        }
      }
    }
    const next = this.notes[note.index + 1];
    if (next) this.rest(next, t + this.options.restMs);
  }
}

/** The coach's AttemptSummary fields for one attempt. Version 2 = voice-sized reference targets. */
export function coachSummary(note: TargetNote, step: TargetStep) {
  const mean = (key: keyof Formants) => note.points.length && note.value ? note.points.reduce((sum, p) => sum + p[key], 0) / note.points.length : null;
  const f1_mean = mean('f1'), f2_mean = mean('f2');
  const target_distance = note.outcome === 'measured' ? note.distance ?? null : null;
  return {
    target_id: step.sound === 'ee' ? 'i' as const : 'aa' as const,
    target_version: 2 as const,
    f1_mean,
    f2_mean,
    target_distance,
    quality_flags: note.outcome === 'unheard' ? ['not-heard-clearly'] : note.outcome === 'unscored' ? ['noisy-room'] : [],
    evidence_fields: [...(target_distance !== null ? ['target_distance'] : []), ...(f1_mean !== null ? ['f1_mean', 'f2_mean'] : [])],
  };
}

