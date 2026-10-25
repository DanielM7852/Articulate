import { emit } from './client';

/**
 * Streams a 32-band log-spaced spectrum of an audio source to the dashboard (docs/telemetry.md,
 * "Perception streams"). Uses a timer instead of rAF so it keeps running in background tabs.
 * Only one emitter runs at a time; later callers get a no-op stop function.
 */
const BANDS = 32;
const F_LO = 80;
const F_HI = 8000;
const INTERVAL_MS = 100;
const KEEPALIVE_MS = 1000;

let active = 0;

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
    emit('audio', 'db', 'audio.spectrum', 'spectrum', { bins, rms });
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
