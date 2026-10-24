export type RejectionReason = 'quiet' | 'unvoiced' | 'clipped' | 'uncertain' | 'invalid';

export type FormantEstimate = {
  valid: true;
  f1: number;
  f2: number;
  confidence: number;
  rms: number;
  periodicity: number;
} | {
  valid: false;
  reason: RejectionReason;
  rms: number;
  periodicity: number;
};

export interface EstimatorSettings {
  /** The analysis rate is twice this ceiling, as in standard LPC analysis. */
  ceilingHz: number;
  minimumRms: number;
}

export const DEFAULT_SETTINGS: EstimatorSettings = { ceilingHz: 5500, minimumRms: 0.008 };

function periodicityOf(samples: Float64Array, rate: number): number {
  let best = 0;
  for (let lag = Math.floor(rate / 450); lag <= Math.min(Math.ceil(rate / 65), samples.length / 2); lag++) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = lag; i < samples.length; i++) {
      correlation += samples[i] * samples[i - lag];
      leftEnergy += samples[i] ** 2;
      rightEnergy += samples[i - lag] ** 2;
    }
    best = Math.max(best, correlation / Math.sqrt(leftEnergy * rightEnergy + 1e-20));
  }
  return best;
}

/** Windowed-sinc antialiasing; each independent frame includes its own margins. */
function resample(frame: Float32Array, sourceRate: number, rate: number): Float64Array {
  const ratio = sourceRate / rate;
  const cutoff = Math.min(1, 1 / ratio) * 0.9;
  const radius = Math.ceil(12 / cutoff);
  const output = new Float64Array(Math.floor(frame.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    let sum = 0;
    let weight = 0;
    for (let j = Math.max(0, Math.ceil(position - radius)); j <= Math.min(frame.length - 1, position + radius); j++) {
      const distance = position - j;
      const angle = Math.PI * distance * cutoff;
      const sinc = Math.abs(angle) < 1e-10 ? 1 : Math.sin(angle) / angle;
      const kernel = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      sum += frame[j] * kernel;
      weight += kernel;
    }
    output[i] = sum / weight;
  }
  return output;
}

function burg(samples: Float64Array, order: number): Float64Array {
  let forward = samples.slice(1);
  let backward = samples.slice(0, -1);
  let coefficients = new Float64Array(order + 1);
  coefficients[0] = 1;
  for (let degree = 1; degree <= order; degree++) {
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < forward.length; i++) {
      numerator += forward[i] * backward[i];
      denominator += forward[i] ** 2 + backward[i] ** 2;
    }
    if (denominator < 1e-18) break;
    const reflection = Math.max(-0.9999, Math.min(0.9999, -2 * numerator / denominator));
    const next = coefficients.slice();
    for (let i = 1; i < degree; i++) next[i] += reflection * coefficients[degree - i];
    next[degree] = reflection;
    coefficients = next;
    const nextForward = new Float64Array(forward.length - 1);
    const nextBackward = new Float64Array(forward.length - 1);
    for (let i = 0; i < nextForward.length; i++) {
      nextForward[i] = forward[i + 1] + reflection * backward[i + 1];
      nextBackward[i] = backward[i] + reflection * forward[i];
    }
    forward = nextForward;
    backward = nextBackward;
  }
  return coefficients;
}

/** Durand–Kerner roots of the monic LPC polynomial, with a convergence check. */
function resonances(coefficients: Float64Array, rate: number): { frequency: number; bandwidth: number }[] {
  const order = coefficients.length - 1;
  const real = Float64Array.from({ length: order }, (_, i) => 0.85 * Math.cos(2 * Math.PI * (i + 0.25) / order));
  const imag = Float64Array.from({ length: order }, (_, i) => 0.85 * Math.sin(2 * Math.PI * (i + 0.25) / order));
  let converged = false;
  for (let iteration = 0; iteration < 150; iteration++) {
    let largest = 0;
    for (let i = 0; i < order; i++) {
      let pr = 1;
      let pi = 0;
      for (let j = 1; j <= order; j++) {
        const next = pr * real[i] - pi * imag[i] + coefficients[j];
        pi = pr * imag[i] + pi * real[i];
        pr = next;
      }
      let dr = 1;
      let di = 0;
      for (let j = 0; j < order; j++) {
        if (i === j) continue;
        const r = real[i] - real[j];
        const im = imag[i] - imag[j];
        const next = dr * r - di * im;
        di = dr * im + di * r;
        dr = next;
      }
      const divisor = dr * dr + di * di;
      if (divisor < 1e-24 || !Number.isFinite(divisor)) return [];
      const deltaReal = (pr * dr + pi * di) / divisor;
      const deltaImag = (pi * dr - pr * di) / divisor;
      real[i] -= deltaReal;
      imag[i] -= deltaImag;
      largest = Math.max(largest, Math.hypot(deltaReal, deltaImag));
    }
    if (largest < 1e-8) { converged = true; break; }
  }
  if (!converged) return [];
  return Array.from(real, (r, i) => ({
    frequency: Math.atan2(imag[i], r) * rate / (2 * Math.PI),
    bandwidth: -Math.log(Math.hypot(r, imag[i])) * rate / Math.PI,
  })).filter(({ frequency }) => frequency > 0).sort((a, b) => a.frequency - b.frequency);
}

export function estimateFormants(
  frame: Float32Array,
  sampleRate: number,
  settings: EstimatorSettings = DEFAULT_SETTINGS,
): FormantEstimate {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000 || sampleRate > 192000 ||
    frame.length < sampleRate * 0.03 || frame.length > sampleRate * 0.1 ||
    !Number.isFinite(settings.ceilingHz) || settings.ceilingHz < 4000 || settings.ceilingHz > 8000 ||
    settings.ceilingHz * 2 > sampleRate || !Number.isFinite(settings.minimumRms) || settings.minimumRms <= 0) {
    return { valid: false, reason: 'invalid', rms: 0, periodicity: 0 };
  }
  let clipped = 0;
  for (const value of frame) {
    if (!Number.isFinite(value)) return { valid: false, reason: 'invalid', rms: 0, periodicity: 0 };
    if (Math.abs(value) >= 0.995) clipped++;
  }
  if (clipped / frame.length > 0.03) return { valid: false, reason: 'clipped', rms: 0, periodicity: 0 };
  const samples = resample(frame, sampleRate, settings.ceilingHz * 2);
  const rate = settings.ceilingHz * 2;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  for (let i = 0; i < samples.length; i++) samples[i] -= mean;
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  if (rms < settings.minimumRms) return { valid: false, reason: 'quiet', rms, periodicity: 0 };
  const periodicity = periodicityOf(samples, rate);
  if (periodicity < 0.65) return { valid: false, reason: 'unvoiced', rms, periodicity };
  const emphasized = new Float64Array(samples.length);
  const emphasis = Math.exp(-2 * Math.PI * 50 / rate);
  for (let i = 1; i < samples.length; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1));
    emphasized[i] = (samples[i] - emphasis * samples[i - 1]) * window;
  }
  const poles = resonances(burg(emphasized, 10), rate);
  const [first, second] = poles.filter(({ frequency, bandwidth }) => frequency > 180 && frequency < 5000 && bandwidth > 15 && bandwidth < 600);
  // Noise can broaden the real F1 past the bandwidth limit; relabelling would then report F2 as F1 and F3 as F2.
  const maskedF1 = first && poles.some(({ frequency, bandwidth }) => frequency > 180 && frequency < first.frequency && bandwidth >= 600);
  if (!first || !second || maskedF1 || first.frequency > 1200 || second.frequency < 500 || second.frequency > 3500 || second.frequency - first.frequency < 150) {
    return { valid: false, reason: 'uncertain', rms, periodicity };
  }
  const confidence = Math.max(0, Math.min(1, periodicity * (1 - Math.max(first.bandwidth, second.bandwidth) / 1200)));
  return { valid: true, f1: first.frequency, f2: second.frequency, confidence, rms, periodicity };
}
