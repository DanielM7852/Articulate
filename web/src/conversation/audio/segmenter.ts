import type { LevelFrame, SegmentKind } from './types';

/**
 * Attempt/reply segmentation. Pure state machine, driven by ~40 fps level frames.
 *
 * Constants (tuned for laptop mics; heuristics, not validated values):
 *  - ONSET_FRAMES 3        consecutive frames above threshold AND periodic
 *  - ONSET_DB 10           threshold = adaptive noise floor + 10 dB
 *  - ABS_MIN_RMS 0.008     never trigger below this rms
 *  - PERIODICITY_MIN 0.5   for onset only (fricative-initial words still continue the segment)
 *  - END_SILENCE_MS 700    below threshold this long ends the segment
 *  - MIN_SEGMENT_MS 350    onset to last loud frame; shorter is discarded
 *  - MAX_SEGMENT_MS 8000   forced end (a new segment can begin straight after)
 *  - TEACHER_TAIL_MS 300   hold-off after teacher stops (echo/reverb tail)
 *  - attempt iff voicedFraction >= 0.6 && formantStability >= 0.5
 */
export const SEG = {
  ONSET_FRAMES: 3,
  ONSET_DB: 10,
  ABS_MIN_RMS: 0.008,
  PERIODICITY_MIN: 0.5,
  END_SILENCE_MS: 700,
  MIN_SEGMENT_MS: 350,
  MAX_SEGMENT_MS: 8000,
  TEACHER_TAIL_MS: 300,
  ATTEMPT_VOICED: 0.6,
  ATTEMPT_STABILITY: 0.5,
  MIN_VALID_FRAMES: 5,
  /** sd of ln(F) that maps to stability 0 (steady vowels are ~0.02-0.05). */
  SD_F1_ZERO: 0.12,
  SD_F2_ZERO: 0.1,
} as const;

export type SegmenterEvent =
  | { type: 'start'; t: number }
  | { type: 'discard'; t: number }
  | {
      type: 'segment';
      kind: SegmentKind;
      startedAt: number;
      endedAt: number;
      durationMs: number;
      voicedFraction: number;
      formantStability: number;
    };

export function formantStability(frames: LevelFrame[]): number {
  const v = frames.filter((f) => f.valid && f.f1 > 0 && f.f2 > 0);
  if (v.length < SEG.MIN_VALID_FRAMES) return 0;
  const sd = (sel: (f: LevelFrame) => number) => {
    const xs = v.map((f) => Math.log(sel(f)));
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const worst = Math.max(sd((f) => f.f1) / SEG.SD_F1_ZERO, sd((f) => f.f2) / SEG.SD_F2_ZERO);
  return Math.max(0, Math.min(1, 1 - worst));
}

export function classifySegment(voicedFraction: number, stability: number): SegmentKind {
  return voicedFraction >= SEG.ATTEMPT_VOICED && stability >= SEG.ATTEMPT_STABILITY ? 'attempt' : 'reply';
}

export class Segmenter {
  private floor = 0.004;
  private active = false;
  private run: LevelFrame[] = [];
  private frames: LevelFrame[] = [];
  private startedAt = 0;
  private lastLoudT = 0;
  private muted = false;
  private holdUntil = -Infinity;

  get speaking(): boolean {
    return this.active;
  }
  get threshold(): number {
    return Math.max(SEG.ABS_MIN_RMS, this.floor * 10 ** (SEG.ONSET_DB / 20));
  }

  /** Teacher speech: no segmentation. Returns a discard event if a segment was in progress. */
  setMuted(muted: boolean, now: number): SegmenterEvent[] {
    const out: SegmenterEvent[] = [];
    if (muted && !this.muted) out.push(...this.reset(now));
    if (!muted && this.muted) this.holdUntil = now + SEG.TEACHER_TAIL_MS;
    this.muted = muted;
    return out;
  }

  reset(now = 0): SegmenterEvent[] {
    const was = this.active;
    this.active = false;
    this.run = [];
    this.frames = [];
    return was ? [{ type: 'discard', t: now }] : [];
  }

  push(f: LevelFrame): SegmenterEvent[] {
    if (this.muted || f.t < this.holdUntil) return [];
    const thr = this.threshold;
    const loud = f.rms > thr;
    if (!this.active) {
      if (!loud) {
        this.floor = Math.max(
          0.0015,
          f.rms < this.floor ? this.floor * 0.7 + f.rms * 0.3 : this.floor + 0.02 * (f.rms - this.floor),
        );
      }
      if (loud && f.periodicity >= SEG.PERIODICITY_MIN) this.run.push(f);
      else this.run = [];
      if (this.run.length >= SEG.ONSET_FRAMES) {
        this.active = true;
        this.frames = this.run;
        this.run = [];
        this.startedAt = this.frames[0].t;
        this.lastLoudT = f.t;
        return [{ type: 'start', t: this.startedAt }];
      }
      return [];
    }
    this.frames.push(f);
    if (loud) this.lastLoudT = f.t;
    const silent = f.t - this.lastLoudT >= SEG.END_SILENCE_MS;
    const tooLong = f.t - this.startedAt >= SEG.MAX_SEGMENT_MS;
    if (!silent && !tooLong) return [];
    return [this.finish(silent ? this.lastLoudT : f.t)];
  }

  private finish(endedAt: number): SegmenterEvent {
    const frames = this.frames.filter((x) => x.t <= endedAt);
    const startedAt = this.startedAt;
    this.active = false;
    this.frames = [];
    this.run = [];
    const durationMs = endedAt - startedAt;
    if (durationMs < SEG.MIN_SEGMENT_MS || frames.length === 0) return { type: 'discard', t: endedAt };
    const voicedFraction = frames.filter((x) => x.valid).length / frames.length;
    const stability = formantStability(frames);
    return {
      type: 'segment',
      kind: classifySegment(voicedFraction, stability),
      startedAt,
      endedAt,
      durationMs,
      voicedFraction,
      formantStability: stability,
    };
  }
}
