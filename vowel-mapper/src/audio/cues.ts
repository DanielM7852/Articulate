import type { FormantEstimate } from './estimator';

/**
 * Experimental band-energy cues for telling a voiced nasal murmur (n, m) from a vowel.
 * Diagnostic only: shown in Tracking details, never used to accept or reject frames.
 */
export interface SpectralCues {
  /** Energy 80–400 Hz relative to 400–1200 Hz. */
  lowVsMidDb: number;
  /** Energy 80–400 Hz relative to 1200–3000 Hz. */
  lowVsHighDb: number;
}

export interface CueReadout extends SpectralCues {
  /** Level relative to the loudest voiced frame in the last 3 s. */
  loudnessDb: number;
}

const STEP_HZ = 20;

/** Goertzel power at one frequency of an already-windowed frame. */
function powerAt(samples: Float64Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let before = 0;
  for (const sample of samples) {
    const next = sample + coefficient * previous - before;
    before = previous;
    previous = next;
  }
  return previous * previous + before * before - coefficient * previous * before;
}

function bandEnergy(samples: Float64Array, sampleRate: number, low: number, high: number): number {
  let energy = 0;
  for (let frequency = low; frequency < high; frequency += STEP_HZ) energy += powerAt(samples, frequency, sampleRate);
  return energy;
}

export function spectralCues(frame: Float32Array, sampleRate: number): SpectralCues | null {
  const mean = frame.reduce((sum, value) => sum + value, 0) / frame.length;
  const windowed = Float64Array.from(frame, (value, i) => (value - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frame.length - 1))));
  const low = bandEnergy(windowed, sampleRate, 80, 400);
  const mid = bandEnergy(windowed, sampleRate, 400, 1200);
  const high = bandEnergy(windowed, sampleRate, 1200, 3000);
  if (low + mid + high < 1e-9) return null;
  const db = (a: number, b: number) => 10 * Math.log10((a + 1e-12) / (b + 1e-12));
  return { lowVsMidDb: db(low, mid), lowVsHighDb: db(low, high) };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Half-second medians over voiced frames (accepted or `uncertain`), so values can be read while holding a sound. */
export class CueSummary {
  private levels: { timestampMs: number; rms: number }[] = [];
  private samples: (CueReadout & { timestampMs: number })[] = [];

  push(estimate: FormantEstimate, cues: SpectralCues | null | undefined, timestampMs: number): CueReadout | null {
    if (cues && (estimate.valid || estimate.reason === 'uncertain')) {
      this.levels = this.levels.filter((level) => level.timestampMs > timestampMs - 3000);
      this.levels.push({ timestampMs, rms: estimate.rms });
      const loudest = Math.max(...this.levels.map((level) => level.rms));
      this.samples = this.samples.filter((sample) => sample.timestampMs > timestampMs - 500);
      this.samples.push({ ...cues, loudnessDb: 20 * Math.log10(estimate.rms / loudest), timestampMs });
    }
    if (!this.samples.length) return null;
    return {
      lowVsMidDb: median(this.samples.map((sample) => sample.lowVsMidDb)),
      lowVsHighDb: median(this.samples.map((sample) => sample.lowVsHighDb)),
      loudnessDb: median(this.samples.map((sample) => sample.loudnessDb)),
    };
  }
}
