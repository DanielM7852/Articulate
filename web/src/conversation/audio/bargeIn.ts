import type { BargeInMode } from './types';

/**
 * Barge-in detection: learner voice while the teacher is speaking. Fires once per teacher utterance.
 *
 * Strategies (which track feeds each):
 *  - gated (default)  AEC track (pushAec). Echo residual calibrated over the first CAL_MS (300 ms) after echo
 *                     appears in each utterance (peak level; if setOutputLevel is fed, mic/output coupling so
 *                     the residual follows the TTS level). Threshold = max(floor + 10 dB,
 *                     sqrt(echo^2 + floor^2) * 8 dB). Needs voicing. Cannot fire during calibration.
 *                     Measured basis: AEC track floor -48 dBFS, TTS residual -38, loud speech -15.
 *  - aec              AEC track, plain VAD (floor + 10 dB + voicing), no echo gate.
 *  - headphones       RAW track (pushRaw), plain VAD (no echo expected).
 *  - off              never fires.
 * Fires after HOLD_MS (150 ms, ~3 frames of 50 ms) of qualifying frames (gaps up to GAP_MS tolerated).
 */
export const BARGE = {
  HOLD_MS: 150,
  GAP_MS: 60,
  CAL_MS: 300,
  CAL_GIVEUP_MS: 1500,
  ECHO_MARGIN_DB: 8,
  FLOOR_DB: 10,
  ABS_MIN_RMS: 0.004,
  PERIODICITY_MIN: 0.5,
  OUT_EPS: 0.002,
} as const;

export interface BargeFrame {
  t: number;
  rms: number;
  periodicity: number;
}

/** RMS and normalized-autocorrelation periodicity (70-400 Hz) of a PCM chunk. Scale-invariant periodicity. */
export function frameLevel(pcm: ArrayLike<number>, rate = 16000): { rms: number; periodicity: number } {
  const n = pcm.length;
  if (n === 0) return { rms: 0, periodicity: 0 };
  let e = 0;
  for (let i = 0; i < n; i++) e += pcm[i] * pcm[i];
  const rms = Math.sqrt(e / n);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(Math.floor(rate / 70), Math.floor(n / 2) - 1);
  if (maxLag <= minLag || e === 0) return { rms, periodicity: 0 };
  const w = n - maxLag;
  let e0 = 0;
  for (let i = 0; i < w; i++) e0 += pcm[i] * pcm[i];
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    let el = 0;
    for (let i = 0; i < w; i++) {
      c += pcm[i] * pcm[i + lag];
      el += pcm[i + lag] * pcm[i + lag];
    }
    const d = Math.sqrt(e0 * el);
    if (d > 0 && c / d > best) best = c / d;
  }
  return { rms, periodicity: best };
}

export class BargeInDetector {
  mode: BargeInMode;
  private speaking = false;
  private armed = false;
  private startT = 0;
  private floors = { raw: 0.004, aec: 0.004 };
  private outLevel = 0;
  private calStart: number | null = null;
  private calDone = false;
  private calMicPeak = 0;
  private calOutPeak = 0;
  private runStart: number | null = null;
  private lastQual = 0;
  private fns = new Set<() => void>();

  constructor(mode: BargeInMode = 'gated') {
    this.mode = mode;
  }

  onFire(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  setMode(m: BargeInMode): void {
    this.mode = m;
    this.runStart = null;
  }

  setTeacherSpeaking(active: boolean, now: number): void {
    if (active === this.speaking) return;
    this.speaking = active;
    this.armed = active;
    this.startT = now;
    this.runStart = null;
    this.calStart = null;
    this.calDone = false;
    this.calMicPeak = 0;
    this.calOutPeak = 0;
    this.outLevel = 0;
  }

  setOutputLevel(rms: number): void {
    this.outLevel = rms;
  }

  pushRaw(f: BargeFrame): void {
    this.push('raw', f);
  }
  pushAec(f: BargeFrame): void {
    this.push('aec', f);
  }

  private push(which: 'raw' | 'aec', f: BargeFrame): void {
    const wanted = this.mode === 'headphones' ? 'raw' : 'aec';
    if (this.mode === 'off' || which !== wanted) return;
    const floor = this.floors[which];
    const thr = Math.max(BARGE.ABS_MIN_RMS, floor * 10 ** (BARGE.FLOOR_DB / 20));
    if (!this.speaking) {
      this.floors[which] = Math.max(0.0005, f.rms < floor ? floor * 0.7 + f.rms * 0.3 : f.rms > thr ? floor : floor + 0.02 * (f.rms - floor));
      return;
    }
    if (!this.armed) return;
    let need = thr;
    if (this.mode === 'gated') {
      const echo = this.echoEstimate(f, thr);
      if (echo === null) return; // still calibrating
      need = Math.max(thr, Math.sqrt(echo * echo + floor * floor) * 10 ** (BARGE.ECHO_MARGIN_DB / 20));
    }
    const qual = f.rms > need && f.periodicity >= BARGE.PERIODICITY_MIN;
    if (qual) {
      if (this.runStart === null) this.runStart = f.t;
      this.lastQual = f.t;
      if (f.t - this.runStart >= BARGE.HOLD_MS) {
        this.armed = false;
        this.runStart = null;
        for (const fn of [...this.fns]) fn();
      }
    } else if (this.runStart !== null && f.t - this.lastQual > BARGE.GAP_MS) {
      this.runStart = null;
    }
  }

  /** Echo residual rms estimate, or null while calibrating. */
  private echoEstimate(f: BargeFrame, thr: number): number | null {
    if (!this.calDone) {
      if (this.calStart === null) {
        // Echo onset: mic noticeably above floor, or the output hook shows playback.
        if (f.rms > thr * 0.5 || this.outLevel > BARGE.OUT_EPS) this.calStart = f.t;
        else if (f.t - this.startT >= BARGE.CAL_GIVEUP_MS) this.calDone = true; // no echo at all
      }
      if (this.calStart !== null) {
        this.calMicPeak = Math.max(this.calMicPeak, f.rms);
        this.calOutPeak = Math.max(this.calOutPeak, this.outLevel);
        if (f.t - this.calStart >= BARGE.CAL_MS) this.calDone = true;
      }
      if (!this.calDone) return null;
    }
    if (this.calOutPeak > BARGE.OUT_EPS) return (this.calMicPeak / this.calOutPeak) * this.outLevel;
    return this.calMicPeak;
  }
}
