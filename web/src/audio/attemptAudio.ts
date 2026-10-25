import { useEffect, useRef } from 'react';

/**
 * Rolling capture of the learner's mic so a finished word attempt can be sent to the coach as a short WAV.
 *
 * A private AudioContext + AudioWorklet taps the shared MediaStream (read only: no constraint or track changes) into a
 * ~10 s ring buffer. `clip()` is synchronous and returns null on any problem; audio never leaves this module except as
 * the value the caller puts in the coach request. Nothing is stored.
 */

export interface AttemptAudio {
  format: 'wav';
  data: string;
  durationMs: number;
}

export interface AttemptAudioTap {
  /** The last `durationMs` of audio ending at `endAt` (Date.now() clock). Null when unavailable; never throws. */
  clip(endAt: number, durationMs: number): AttemptAudio | null;
  close(): void;
}

export const CLIP_RATE = 16000;
export const MAX_CLIP_MS = 7000;
const MIN_CLIP_MS = 300;
const RING_SECONDS = 10;
const MAX_BASE64 = 480000;

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const n = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(n);
  const ratio = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

export function encodeWav16(samples: Float32Array, rate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

/** Ring of mono samples at `rate`, with a wall-clock anchor (the time the newest sample was received). */
export class ClipRing {
  private buf: Float32Array;
  private total = 0;
  private lastAt = 0;
  constructor(private rate: number) {
    this.buf = new Float32Array(Math.round(rate * RING_SECONDS));
  }
  push(chunk: Float32Array, receivedAt: number) {
    const cap = this.buf.length;
    for (let i = 0; i < chunk.length; i++) this.buf[(this.total + i) % cap] = chunk[i];
    this.total += chunk.length;
    this.lastAt = receivedAt;
  }
  /** Samples for [endAt - durationMs, endAt], or null when that span is not fully buffered. */
  take(endAt: number, durationMs: number): Float32Array | null {
    if (this.total === 0) return null;
    const ms = Math.min(durationMs, MAX_CLIP_MS);
    const n = Math.round((ms / 1000) * this.rate);
    // The newest sample was received at lastAt; an endAt after that is clamped to it.
    const lag = Math.max(0, Math.round(((this.lastAt - endAt) / 1000) * this.rate));
    const end = this.total - lag;
    const start = end - n;
    if (n < (MIN_CLIP_MS / 1000) * this.rate || start < 0 || this.total - start > this.buf.length) return null;
    const out = new Float32Array(n);
    const cap = this.buf.length;
    for (let i = 0; i < n; i++) out[i] = this.buf[(start + i) % cap];
    return out;
  }
}

const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.b[this.n++] = ch[i];
        if (this.n === this.b.length) { const c = this.b; this.b = new Float32Array(2048); this.n = 0; this.port.postMessage(c, [c.buffer]); }
      }
    }
    return true;
  }
}
registerProcessor('attempt-audio-tap', Tap);
`;

export async function createAttemptAudioTap(stream: MediaStream): Promise<AttemptAudioTap | null> {
  let ctx: AudioContext | null = null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor || stream.getAudioTracks().length === 0) return null;
    ctx = new Ctor();
    if (!ctx.audioWorklet) {
      void ctx.close();
      return null;
    }
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const c = ctx;
    const ring = new ClipRing(c.sampleRate);
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, 'attempt-audio-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      try {
        ring.push(e.data, Date.now());
      } catch {
        /* drop the chunk */
      }
    };
    const mute = c.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(c.destination);
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    let closed = false;
    return {
      clip(endAt, durationMs) {
        if (closed) return null;
        try {
          const raw = ring.take(endAt, durationMs);
          if (!raw) return null;
          const pcm = resampleLinear(raw, c.sampleRate, CLIP_RATE);
          const data = toBase64(encodeWav16(pcm, CLIP_RATE));
          if (data.length > MAX_BASE64) return null;
          return { format: 'wav', data, durationMs: Math.round((pcm.length / CLIP_RATE) * 1000) };
        } catch {
          return null;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          node.port.onmessage = null;
          source.disconnect();
          node.disconnect();
          mute.disconnect();
          void c.close().catch(() => undefined);
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
    try {
      void ctx?.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Keeps a tap open for the stream's lifetime. `ref.current` is null until ready (or if unsupported). */
export function useAttemptAudio(stream: MediaStream | null) {
  const ref = useRef<AttemptAudioTap | null>(null);
  useEffect(() => {
    if (!stream) return;
    let cancelled = false;
    let tap: AttemptAudioTap | null = null;
    void createAttemptAudioTap(stream).then(
      (t) => {
        if (cancelled) t?.close();
        else {
          tap = t;
          ref.current = t;
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      tap?.close();
      if (ref.current === tap) ref.current = null;
    };
  }, [stream]);
  return ref;
}
