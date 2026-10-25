/** Independent source/filter fixture: a pulse train through known resonators. */
export function vowelSignal({
  formants = [300, 2300, 3000],
  sampleRate = 48000,
  pitch = 120,
  seconds = 0.2,
}: {
  formants?: number[];
  sampleRate?: number;
  pitch?: number;
  seconds?: number;
} = {}): Float32Array {
  const warmup = Math.round(sampleRate * 0.15);
  const data = new Float64Array(Math.round(sampleRate * seconds) + warmup);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    phase += pitch / sampleRate;
    if (phase >= 1) { data[i] = 1; phase -= 1; }
  }
  formants.forEach((frequency, index) => {
    const radius = Math.exp(-Math.PI * (70 + 30 * index) / sampleRate);
    const a = 2 * radius * Math.cos(2 * Math.PI * frequency / sampleRate);
    const b = radius * radius;
    let previous = 0;
    let before = 0;
    for (let i = 0; i < data.length; i++) {
      const next = data[i] + a * previous - b * before;
      before = previous;
      previous = next;
      data[i] = next;
    }
  });
  const result = data.slice(warmup);
  const peak = result.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  return Float32Array.from(result, (value) => value / peak * 0.55);
}

/** Adds seeded white noise at a given signal-to-noise ratio, as from a noisy room. */
export function withNoise(signal: Float32Array, snrDb: number, seed = 7): Float32Array {
  let state = seed;
  const noise = Float64Array.from(signal, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff * 2 - 1;
  });
  const power = (values: Iterable<number>) => {
    let sum = 0;
    for (const value of values) sum += value * value;
    return sum;
  };
  const gain = Math.sqrt(power(signal) / power(noise)) / 10 ** (snrDb / 20);
  return Float32Array.from(signal, (value, i) => value + gain * noise[i]);
}

export function noiseSignal(length: number): Float32Array {
  let state = 1234567;
  return Float32Array.from({ length }, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff * 2 - 1) * 0.12;
  });
}

/** Like vowelSignal, but the resonators move: `formants(u)` gives Hz at normalised time u, as in a word's glide. */
export function glideSignal({ formants, sampleRate = 48000, pitch = 120, seconds = 1.2 }: {
  formants: (u: number) => number[];
  sampleRate?: number;
  pitch?: number;
  seconds?: number;
}): Float32Array {
  const data = new Float64Array(Math.round(sampleRate * seconds));
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    phase += pitch / sampleRate;
    if (phase >= 1) { data[i] = 1; phase -= 1; }
  }
  formants(0).forEach((_, index) => {
    const radius = Math.exp(-Math.PI * (70 + 30 * index) / sampleRate);
    let previous = 0;
    let before = 0;
    for (let i = 0; i < data.length; i++) {
      const a = 2 * radius * Math.cos(2 * Math.PI * formants(i / (data.length - 1))[index] / sampleRate);
      const next = data[i] + a * previous - radius * radius * before;
      before = previous;
      previous = next;
      data[i] = next;
    }
  });
  const peak = data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  // 20 ms fades so the onset and offset are not clicks.
  const fade = sampleRate * 0.02;
  return Float32Array.from(data, (value, i) => value / peak * 0.55 * Math.min(1, i / fade, (data.length - i) / fade));
}
