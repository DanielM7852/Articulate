import type { LipFrame } from '../vision/lipTelemetry';
import type { TunerZoneTarget, VoiceFrame, VowelZoneTarget, WordAttemptResult, ZoneVerdict } from './types';

/**
 * Pure scoring helpers for the word board. Verdicts are acoustic orientation only
 * (did the measured feature reach the drawn target), never a pronunciation judgement.
 * All times are in the VoiceFrame clock (ms).
 */
export const SCORING = {
  /** A frame never contributes more than this much dwell, so a stalled stream never fakes a hold. */
  maxFrameDtMs: 40,
  /** Vowel: a median this close (in normalised ellipse radii) still earns `partial`. */
  vowelNearRadii: 1.3,
  /** Tuner: the scoring window after the first usable f3 frame. */
  tunerWindowMs: 900,
  /** Tuner: after entering the band, leaving it for this long ends the zone (the sound has moved on). */
  tunerExitMs: 120,
  /** Needle (and its scoring value) smoothing time constant. */
  needleTauMs: 80,
  /** Tuner -> vowel hand-off: this long inside the next vowel target with the needle out of band ends the tuner. */
  lookaheadMs: 60,
  /** Stop: once voicing begins without a burst, a burst inside this grace still counts. */
  stopGraceMs: 120,
  /** Vowel/tuner: an unvoiced gap this long after the zone had voice ends the zone. */
  voiceGapMs: 150,
  /** Bursts only end a vowel/tuner zone once it has been active this long (debounces double bursts). */
  burstMinZoneMs: 80,
  /** Attempt: silence after the last voiced frame that ends it, once enough zones resolved. */
  endSilenceMs: 700,
  endSilenceMinResolved: 2,
  /** Attempt: hard cap as a multiple of spec.paceMs from the start. */
  maxDurationFactor: 2.5,
  /** Attempt: no voiced or burst frame this long after the first frame -> everything skipped. */
  startTimeoutMs: 6000,
  /** Quality. */
  minVoicedFrames: 8,
  maxClippedFraction: 0.2,
  minDurationMs: 300,
  /** Lip means are reported when the camera was usable for more than this fraction of a zone's frames. */
  lipUsableFraction: 0.5,
} as const;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Frame-rate independent exponential approach. Starts at the target when there is no previous value. */
export function smoothToward(previous: number | null, target: number, dtMs: number, tauMs: number) {
  if (previous === null || tauMs <= 0) return target;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}

/** Soft log loudness: -60 dBFS (and below) is 0, -12 dBFS (and above) is 1. */
export function loudnessFromRms(rms: number) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const t = clamp((db + 60) / 48, 0, 1);
  // Ease-out so normal speech sits in the upper half and whispers still register.
  return 1 - (1 - t) * (1 - t);
}

/** Distance from a vowel target centre in normalised ellipse radii (1 = on the outline). */
export function vowelDistance(p: { f1: number; f2: number }, t: VowelZoneTarget) {
  return Math.hypot((p.f2 - t.f2) / t.rx, (p.f1 - t.f1) / t.ry);
}

export const insideVowel = (p: { f1: number; f2: number }, t: VowelZoneTarget) => vowelDistance(p, t) <= 1;

/** The tuner quantity for a frame: f3gap = F3 - F2 in Hz, or null when not measurable. */
export function f3gap(frame: Pick<VoiceFrame, 'voiced' | 'f2' | 'f3'>): number | null {
  if (!frame.voiced || frame.f2 === undefined || frame.f3 === undefined) return null;
  return frame.f3 - frame.f2;
}

export const inBand = (value: number, t: TunerZoneTarget) => value >= t.lowHz && value <= t.highHz;

/** 0..1 position of a tuner value on its strip (minHz at 0, maxHz at 1). */
export const needlePosition = (value: number, t: TunerZoneTarget) => clamp((value - t.minHz) / (t.maxHz - t.minHz), 0, 1);

export function vowelVerdict(input: {
  dwellMs: number;
  holdMs: number;
  f1Median: number | null;
  f2Median: number | null;
  target: VowelZoneTarget;
}): ZoneVerdict {
  if (input.dwellMs >= input.holdMs) return 'hit';
  if (input.dwellMs > 0) return 'partial';
  if (input.f1Median !== null && input.f2Median !== null
    && vowelDistance({ f1: input.f1Median, f2: input.f2Median }, input.target) <= SCORING.vowelNearRadii) return 'partial';
  return 'miss';
}

export function tunerVerdict(input: { dwellMs: number; holdMs: number; enteredBand: boolean }): ZoneVerdict {
  if (input.dwellMs >= input.holdMs) return 'hit';
  return input.enteredBand ? 'partial' : 'miss';
}

export function assessQuality(input: {
  started: boolean;
  totalFrames: number;
  voicedFrames: number;
  clippedFrames: number;
  durationMs: number;
}): Pick<WordAttemptResult, 'quality' | 'qualityReason'> {
  if (!input.started) return { quality: 'unclear', qualityReason: 'silence' };
  if (input.voicedFrames < SCORING.minVoicedFrames) return { quality: 'unclear', qualityReason: 'no-voice' };
  if (input.totalFrames > 0 && input.clippedFrames / input.totalFrames > SCORING.maxClippedFraction) {
    return { quality: 'unclear', qualityReason: 'clipped' };
  }
  if (input.durationMs < SCORING.minDurationMs) return { quality: 'unclear', qualityReason: 'too-short' };
  return { quality: 'usable' };
}

export const lipOk = (lip: LipFrame | null | undefined): lip is LipFrame => Boolean(lip && lip.ok);

/** Lip ring shape: -1 spread, 0 neutral, +1 rounded; null when the camera is off or unusable. */
export function lipShape(lip: LipFrame | null | undefined): number | null {
  if (!lipOk(lip)) return null;
  return clamp(lip.rounding - lip.spread, -1, 1);
}

/** Running lip means for one zone or one attempt. */
export class LipAccumulator {
  frames = 0;
  okFrames = 0;
  private spread = 0;
  private rounding = 0;
  private opening = 0;

  add(lip: LipFrame | null | undefined) {
    this.frames++;
    if (!lipOk(lip)) return;
    this.okFrames++;
    this.spread += lip.spread;
    this.rounding += lip.rounding;
    this.opening += lip.lipOpening;
  }

  get usable() {
    return this.frames > 0 && this.okFrames / this.frames > SCORING.lipUsableFraction;
  }

  /** Evidence keys, only when the camera was usable for most frames. */
  evidence(): Record<string, number> {
    if (!this.usable) return {};
    const n = this.okFrames;
    return { spreadMean: round4(this.spread / n), roundingMean: round4(this.rounding / n), lipOpeningMean: round4(this.opening / n) };
  }
}

export const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
