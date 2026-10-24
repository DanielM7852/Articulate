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
