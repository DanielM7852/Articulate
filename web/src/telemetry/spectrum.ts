import { emit } from './client';

/**
 * Streams a 32-band log-spaced spectrum of an audio source to the dashboard (docs/telemetry.md,
 * "Perception streams"), with the same block's waveform decimated to 128 uint8 samples. Uses a
 * timer instead of rAF so it keeps running in background tabs. Only one emitter runs at a time;
 * later callers get a no-op stop function.
 */
const BANDS = 32;
const F_LO = 80;
const F_HI = 8000;
const INTERVAL_MS = 100;
const KEEPALIVE_MS = 1000;
/** Waveform samples per frame: 128 bytes -> 172 base64 chars, so the payload stays near 400 bytes. */
const WAVE_SAMPLES = 128;

let active = 0;

/** Base64 of raw bytes (the lipTelemetry.ts helper). */
function base64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x2000)));
  }
  return btoa(bin);
}

/**
 * Decimates a byte time-domain block (128 = zero) into `out`: each output sample is the sample of
 * largest magnitude within its window of the block, sign kept, so clicks and plosive bursts survive.
 */
function decimateWave(time: Uint8Array, out: Uint8Array): void {
  const n = out.length;
  const step = time.length / n;
  for (let w = 0; w < n; w++) {
    const lo = Math.min(time.length - 1, Math.floor(w * step));
    const hi = Math.min(time.length, Math.max(lo + 1, Math.floor((w + 1) * step)));
    let best = 128;
    let mag = -1;
    for (let i = lo; i < hi; i++) {
      const d = Math.abs(time[i] - 128);
      if (d > mag) {
        mag = d;
        best = time[i];
      }
    }
    out[w] = best;
  }
}

export function startSpectrumEmitter(ctx: AudioContext, source: AudioNode): () => void {
  if (active > 0) return () => {};
  let analyser: AnalyserNode;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
  } catch {
    return () => {};
  }
  active++;

  const freq = new Uint8Array(analyser.frequencyBinCount);
  const time = new Uint8Array(analyser.fftSize);
  const wave = new Uint8Array(WAVE_SAMPLES);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const ratio = F_HI / F_LO;
  // Inclusive [lo, hi] FFT bin range per band.
  const ranges: Array<[number, number]> = [];
  for (let b = 0; b < BANDS; b++) {
    const f0 = F_LO * Math.pow(ratio, b / BANDS);
    const f1 = F_LO * Math.pow(ratio, (b + 1) / BANDS);
    const lo = Math.min(freq.length - 1, Math.max(1, Math.floor(f0 / binHz)));
    const hi = Math.min(freq.length - 1, Math.max(lo, Math.ceil(f1 / binHz) - 1));
    ranges.push([lo, hi]);
  }

  let silentTicks = 0;
  let lastSent = 0;
  const timer = window.setInterval(() => {
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(time);
    const bins: number[] = new Array(BANDS);
    let any = false;
    for (let b = 0; b < BANDS; b++) {
      const [lo, hi] = ranges[b];
      let m = 0;
      for (let i = lo; i <= hi; i++) if (freq[i] > m) m = freq[i];
      bins[b] = m;
      if (m > 0) any = true;
    }
    let sum = 0;
    for (let i = 0; i < time.length; i++) {
      const v = (time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.round(Math.sqrt(sum / time.length) * 1000) / 1000;

    const silent = !any && rms < 0.005;
    silentTicks = silent ? silentTicks + 1 : 0;
    const now = performance.now();
    if (silentTicks >= 2 && now - lastSent < KEEPALIVE_MS) return;
    lastSent = now;
    decimateWave(time, wave);
    emit('audio', 'db', 'audio.spectrum', 'spectrum', { bins, rms, wave: base64Bytes(wave) });
  }, INTERVAL_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    active = Math.max(0, active - 1);
    window.clearInterval(timer);
    try {
      source.disconnect(analyser);
    } catch {
      /* already disconnected */
    }
    try {
      analyser.disconnect();
    } catch {
      /* ignore */
    }
  };
}
