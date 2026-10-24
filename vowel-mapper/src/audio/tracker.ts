import type { FormantEstimate, RejectionReason } from './estimator';

export interface VowelPoint {
  f1: number;
  f2: number;
  timestampMs: number;
  segment: number;
}

export interface TrackedFrame {
  estimate: FormantEstimate;
  point: VowelPoint | null;
  status: 'tracking' | 'acquiring' | RejectionReason;
  timestampMs: number;
}

type Formants = { f1: number; f2: number };

/** Longest stretch without an accepted point that a trail bridges, and the longest gap between two agreeing frames. */
const MAX_GAP_MS = 180;

const near = (a: Formants, b: Formants) =>
  Math.abs(Math.log(a.f1 / b.f1)) <= 0.5 && Math.abs(Math.log(a.f2 / b.f2)) <= 0.4;

/** Smoothing and acquisition operate on measurements, independently of the UI. */
export class VowelTracker {
  private previous: VowelPoint | null = null;
  private segment = 0;
  private candidate: { f1: number; f2: number; count: number } | null = null;
  /** The latest valid estimate, accepted or not; only an `uncertain` frame (voiced but unreadable) keeps it. */
  private heard: (Formants & { timestampMs: number }) | null = null;

  push(estimate: FormantEstimate, timestampMs: number): TrackedFrame {
    const base = { estimate, timestampMs };
    // The trail must not bridge a stretch without accepted points.
    if (this.previous && (timestampMs - this.previous.timestampMs > MAX_GAP_MS || timestampMs <= this.previous.timestampMs)) {
      this.previous = null;
      this.candidate = null;
      this.segment++;
    }
    if (!estimate.valid) {
      this.candidate = null;
      if (estimate.reason !== 'uncertain') this.heard = null;
      return { ...base, point: null, status: estimate.reason };
    }
    const heard = this.heard;
    this.heard = { f1: estimate.f1, f2: estimate.f2, timestampMs };
    // A new sound, or one resuming after silence, starts only once two valid frames close together in time agree.
    const agrees = heard && timestampMs > heard.timestampMs && timestampMs - heard.timestampMs <= MAX_GAP_MS && near(estimate, heard);
    if (!heard || (!this.previous && !agrees)) return { ...base, point: null, status: 'acquiring' };
    let previous = this.previous;
    if (previous && !near(estimate, previous)) {
      const candidate = this.candidate;
      const consistent = candidate && Math.abs(Math.log(estimate.f1 / candidate.f1)) < 0.2 && Math.abs(Math.log(estimate.f2 / candidate.f2)) < 0.2;
      this.candidate = { f1: estimate.f1, f2: estimate.f2, count: consistent ? candidate.count + 1 : 1 };
      if (this.candidate.count < 3) return { ...base, point: null, status: 'acquiring' };
      previous = null;
      this.segment++;
    }
    this.candidate = null;
    const alpha = previous ? 1 - Math.exp(-(timestampMs - previous.timestampMs) / 80) : 1;
    const point = {
      f1: previous ? Math.exp(Math.log(previous.f1) + alpha * Math.log(estimate.f1 / previous.f1)) : estimate.f1,
      f2: previous ? Math.exp(Math.log(previous.f2) + alpha * Math.log(estimate.f2 / previous.f2)) : estimate.f2,
      timestampMs,
      segment: this.segment,
    };
    this.previous = point;
    return { ...base, point, status: 'tracking' };
  }
}
