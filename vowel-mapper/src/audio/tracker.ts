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

const near = (a: Formants, b: Formants) =>
  Math.abs(Math.log(a.f1 / b.f1)) <= 0.5 && Math.abs(Math.log(a.f2 / b.f2)) <= 0.4;

/** Smoothing and acquisition operate on measurements, independently of the UI. */
export class VowelTracker {
  private previous: VowelPoint | null = null;
  private consecutive = 0;
  private segment = 0;
  private candidate: { f1: number; f2: number; count: number } | null = null;
  /** The latest valid estimate, accepted or not; unconfirmed jumps are not a gap. */
  private heard: (Formants & { timestampMs: number }) | null = null;

  push(estimate: FormantEstimate, timestampMs: number): TrackedFrame {
    const base = { estimate, timestampMs };
    const lastHeardMs = Math.max(this.previous?.timestampMs ?? -Infinity, this.heard?.timestampMs ?? -Infinity);
    if (this.previous && (timestampMs - lastHeardMs > 180 || timestampMs <= this.previous.timestampMs)) {
      this.previous = null;
      this.candidate = null;
      this.consecutive = 0;
      this.segment++;
    }
    if (!estimate.valid) {
      this.consecutive = 0;
      this.candidate = null;
      return { ...base, point: null, status: estimate.reason };
    }
    const heard = this.heard;
    this.heard = { f1: estimate.f1, f2: estimate.f2, timestampMs };
    this.consecutive++;
    // A new sound starts only once two consecutive frames agree.
    if (this.consecutive < 2 || (!this.previous && !near(estimate, heard!))) return { ...base, point: null, status: 'acquiring' };
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
    // The old point still guards against jumps, but the trail must not bridge a long unaccepted stretch.
    if (previous && timestampMs - previous.timestampMs > 180) {
      previous = null;
      this.segment++;
    }
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
