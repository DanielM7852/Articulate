/**
 * The Audio card's waveform: the microphone's time-domain block (audio.spectrum `wave`, docs/telemetry.md) drawn as a
 * horizontal stippled band, a small sibling of the MediaPipe card's dot face (dotFace.ts).
 *
 * Sampling happens once: WAVE_DOTS dots, each with a fixed x fraction (stratified, jittered) and a fixed vertical
 * weight in -1..1 (triangular, so the core is denser than the edges). Every redraw places each dot at the eased
 * waveform's height at its x, offset vertically by its weight times the band's half-height there:
 *
 *   half(x) = H_MIN + H_AMP * tanh(GAIN * env(x)) + H_RMS * level
 *
 * where env is the local amplitude (the largest |sample| within ENV_R samples) and level is rms / rmsFull. Loud
 * stretches read thick, quiet ones as a thin line of dots. Shading follows dotFace's LIGHT rule: the band is a tube lit
 * from the upper left, so dots toward its upper edge (and on rising stretches) are smaller and lighter, dots toward the
 * lower edge larger and darker, in the face's four tones (or the same four read from the colour tokens, tonesFrom).
 *
 * Frames arrive at 10 Hz; the wave eases from where it is toward each new frame over EASE_MS. While the stream is gone
 * (the caller's `live` flag, PERCEPT_MS without a frame) it relaxes to a flat resting line at REST_ALPHA. With
 * `reduce` (prefers-reduced-motion) nothing eases: each frame is drawn as it arrives.
 *
 * No DOM at module load: decodeWave and tonesFrom run under plain node (waveCloud.test.ts).
 */

/** Samples per frame, uint8 on the wire (128 = the zero line). */
export const WAVE_SAMPLES = 128;
/** Dots in the band. */
export const WAVE_DOTS = 640;

const EASE_MS = 80;
/** stream gone: the wave relaxes to the flat line and the alpha to REST_ALPHA on this time constant */
const REST_TAU_MS = 140;
const REST_ALPHA = 0.25;
/** level meter easing (the old bars' 110 ms transition) */
const METER_TAU_MS = 60;
/** display gain before a tanh soft clip: speech rarely comes near full scale */
const GAIN = 2.5;
/** local amplitude window, samples either side */
const ENV_R = 3;
/** band half-height, design px */
const H_MIN = 0.45;
const H_AMP = 6;
const H_RMS = 1.5;
/** design px: inset from the canvas edge, and the level meter at the right */
const PAD = 1.5;
const METER_W = 3;
const METER_GAP = 4;
const DOT_R = 0.62;

// Shading (dotFace.ts / pointcloud.js LIGHT): shadowed dots larger and darker, lit dots smaller and lighter.
const LIGHT_SIZE = { shadow: 1.22, lit: 0.82 };
/** toward the light: upper left and toward the viewer (x right, y down, z away from the camera) */
const LIGHT = (() => {
  const v = [-0.45, -0.6, -0.75];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();
/** tone = f(TONE_BASE + TONE_LIT x lit + jitter + TONE_RIM x upper edge), cut at TONE_STEPS (dotFace's steps) */
const TONE_BASE = -0.2;
const TONE_LIT = 0.62;
const TONE_RIM = 0.25;
const TONE_STEPS = [0.34, 0.56, 0.78];
/** dotFace's four tones, darkest first; the fallback when the tokens cannot be read */
export const WAVE_TONES = ['#203e68', '#3b5884', '#8fa5c3', '#c2cedd'];
const TONE_ALPHA = [0.94, 0.9, 1, 1];
/** where dotFace's four tones sit between --color-navy and --color-navy-mist */
const TONE_MIX = [0, 0.16, 0.65, 0.95];

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Decodes a `wave` string (128 uint8 samples, base64) to -1..1. Null unless it is a string of exactly 128 bytes. */
export function decodeWave(b64: unknown): Float32Array | null {
  if (typeof b64 !== 'string') return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length !== WAVE_SAMPLES) return null;
  const out = new Float32Array(WAVE_SAMPLES);
  for (let i = 0; i < WAVE_SAMPLES; i++) out[i] = (bin.charCodeAt(i) - 128) / 128;
  return out;
}

function parseColor(s: string): [number, number, number] | null {
  const v = s.trim();
  const long = /^#([0-9a-f]{6})$/i.exec(v);
  if (long) {
    const n = parseInt(long[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** The four dot tones between a dark and a light token (computed values); null when either does not parse. */
export function tonesFrom(dark: string, light: string): string[] | null {
  const a = parseColor(dark);
  const b = parseColor(light);
  if (!a || !b) return null;
  return TONE_MIX.map((t) => {
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  });
}

export interface WaveCloud {
  /** A new frame: `wave` in -1..1 (null: a frame without a waveform, drawn flat), rms 0..1, `at` its arrival time. */
  push(wave: Float32Array | null, rms: number, at: number): void;
  /** The level meter's target, 0..1. */
  meter(level: number): void;
  /** Advances the easing; true when the next draw would differ from the last. */
  step(now: number, dtMs: number, live: boolean): boolean;
  /** Draws a `w` x `h` design-px band; `k` is device px per design px (stage scale x devicePixelRatio). */
  draw(c: CanvasRenderingContext2D, w: number, h: number, k: number): void;
}

export function createWaveCloud(opts: { reduce: boolean; rmsFull: number; tones?: string[] | null }): WaveCloud {
  const { reduce, rmsFull } = opts;
  const tones = opts.tones && opts.tones.length === 4 ? opts.tones : WAVE_TONES;
  const N = WAVE_SAMPLES;

  // Dots: fixed x fraction, vertical weight, size and tone jitter.
  const rand = mulberry(9127);
  const ux = new Float32Array(WAVE_DOTS);
  const vw = new Float32Array(WAVE_DOTS);
  const size = new Float32Array(WAVE_DOTS);
  const jit = new Float32Array(WAVE_DOTS);
  for (let d = 0; d < WAVE_DOTS; d++) {
    ux[d] = (d + rand()) / WAVE_DOTS;
    vw[d] = rand() + rand() - 1;
    size[d] = 0.84 + rand() * 0.32;
    jit[d] = (rand() - 0.5) * 0.16;
  }

  const from = new Float32Array(N);
  const to = new Float32Array(N);
  const cur = new Float32Array(N);
  const env = new Float32Array(N);
  const wy = new Float32Array(N);
  const hh = new Float32Array(N);
  let lvlFrom = 0;
  let lvlTo = 0;
  let lvl = 0;
  let meterTo = 0;
  let meterAt = 0;
  let t0 = -1e9;
  let easing = false;
  let alpha = REST_ALPHA;
  let dirty = true;

  const envelope = () => {
    for (let i = 0; i < N; i++) {
      let m = 0;
      const lo = Math.max(0, i - ENV_R);
      const hi = Math.min(N - 1, i + ENV_R);
      for (let j = lo; j <= hi; j++) {
        const a = Math.abs(cur[j]);
        if (a > m) m = a;
      }
      env[i] = m;
    }
  };

  return {
    push(wave, rms, at) {
      from.set(cur);
      if (wave && wave.length === N) to.set(wave);
      else to.fill(0);
      lvlFrom = lvl;
      lvlTo = clamp01(rms / rmsFull);
      t0 = at;
      easing = true;
      dirty = true;
    },

    meter(level) {
      meterTo = clamp01(level);
    },

    step(now, dtMs, live) {
      let changed = dirty;
      dirty = false;
      if (live) {
        if (easing) {
          const k = reduce ? 1 : clamp01((now - t0) / EASE_MS);
          const e = 1 - (1 - k) * (1 - k);
          for (let i = 0; i < N; i++) cur[i] = from[i] + (to[i] - from[i]) * e;
          lvl = lvlFrom + (lvlTo - lvlFrom) * e;
          if (k >= 1) easing = false;
          changed = true;
        }
      } else {
        // Gone: relax toward the resting line. A later frame eases on from wherever this leaves it.
        easing = false;
        const a = reduce ? 1 : 1 - Math.exp(-dtMs / REST_TAU_MS);
        let moved = false;
        for (let i = 0; i < N; i++) {
          if (cur[i] === 0) continue;
          let v = cur[i] - cur[i] * a;
          if (Math.abs(v) < 1e-3) v = 0;
          cur[i] = v;
          moved = true;
        }
        if (lvl !== 0) {
          lvl -= lvl * a;
          if (lvl < 1e-3) lvl = 0;
          moved = true;
        }
        if (moved) changed = true;
      }
      const aim = live ? 1 : REST_ALPHA;
      if (alpha !== aim) {
        if (reduce) alpha = aim;
        else {
          alpha += (aim - alpha) * (1 - Math.exp(-dtMs / REST_TAU_MS));
          if (Math.abs(aim - alpha) < 0.004) alpha = aim;
        }
        changed = true;
      }
      if (meterAt !== meterTo) {
        if (reduce) meterAt = meterTo;
        else {
          meterAt += (meterTo - meterAt) * (1 - Math.exp(-dtMs / METER_TAU_MS));
          if (Math.abs(meterTo - meterAt) < 0.002) meterAt = meterTo;
        }
        changed = true;
      }
      if (changed) envelope();
      return changed;
    },

    draw(c, w, h, k) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, c.canvas.width, c.canvas.height);
      c.setTransform(k, 0, 0, k, 0, 0);
      const x0 = PAD;
      const span = Math.max(1, w - METER_W - METER_GAP - PAD);
      const mid = h / 2;
      const amp = Math.max(0, mid - PAD - (H_MIN + H_AMP + H_RMS));
      const dx = span / (N - 1);
      for (let i = 0; i < N; i++) {
        wy[i] = Math.tanh(GAIN * cur[i]);
        hh[i] = H_MIN + H_AMP * Math.tanh(GAIN * env[i]) + H_RMS * lvl;
      }

      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      for (let d = 0; d < WAVE_DOTS; d++) {
        const u = ux[d];
        const f = u * (N - 1);
        const i0 = Math.min(N - 2, Math.floor(f));
        const t = f - i0;
        const yc = mid - (wy[i0] + (wy[i0 + 1] - wy[i0]) * t) * amp;
        const half = hh[i0] + (hh[i0 + 1] - hh[i0]) * t;
        const v = vw[d];
        const x = x0 + u * span;
        const y = yc + v * half;
        // The band as a tube along the centre line: its in-plane normal (y down), then the surface normal at weight v.
        const s = (-(wy[i0 + 1] - wy[i0]) * amp) / dx;
        const inv = 1 / Math.sqrt(1 + s * s);
        const nx = -s * inv * v;
        const ny = inv * v;
        const nz = -Math.sqrt(Math.max(0, 1 - v * v));
        const lit = smooth(-0.15, 0.85, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const r = DOT_R * size[d] * (LIGHT_SIZE.shadow + (LIGHT_SIZE.lit - LIGHT_SIZE.shadow) * lit);
        const lum = TONE_BASE + TONE_LIT * lit + jit[d] + TONE_RIM * smooth(0.55, 0.95, -v);
        const tone = lum < TONE_STEPS[0] ? 0 : lum < TONE_STEPS[1] ? 1 : lum < TONE_STEPS[2] ? 2 : 3;
        const path = paths[tone];
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, Math.PI * 2);
      }
      for (let t = 0; t < 4; t++) {
        c.globalAlpha = alpha * TONE_ALPHA[t];
        c.fillStyle = tones[t];
        c.fill(paths[t]);
      }

      // Level meter: a slim track at the right edge, filled from the bottom.
      const mx = w - METER_W;
      const mh = h - 2 * PAD;
      c.globalAlpha = 0.55;
      c.fillStyle = tones[3];
      c.fillRect(mx, PAD, METER_W, mh);
      const fill = meterAt * mh;
      if (fill > 0.05) {
        c.globalAlpha = 1;
        c.fillStyle = tones[0];
        c.fillRect(mx, PAD + mh - fill, METER_W, fill);
      }
      c.globalAlpha = 1;
    },
  };
}
