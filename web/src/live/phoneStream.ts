/**
 * Client for the local phone-recognition service (ws://127.0.0.1:8020/ws/phones).
 * Taps a MediaStream with a private AudioContext + AudioWorklet (inline blob, same approach as attemptAudio.ts),
 * downsamples to 16 kHz mono Int16 and sends ~50 ms binary chunks. Fails soft: any problem reports state
 * 'error'/'closed' and never throws into the caller.
 */

export interface Phone {
  p: string;
  startMs: number;
  endMs: number;
  conf: number;
}
/** One recognizer frame: stream time, non-blank probability mass (1 - blank) and the top (symbol, probability) pairs. */
export interface PhoneFrame {
  t: number;
  mass: number;
  top: [string, number][];
}
export interface PhonesMessage {
  type: 'phones';
  seq?: number;
  windowEndMs?: number;
  committed?: Phone[];
  provisional?: Phone[];
  /** Newest frames only (~5 per message); absent on older servers. */
  frames?: unknown;
  inferMs?: number;
}
export interface PhoneState {
  committed: Phone[];
  provisional: Phone[];
}
export type StreamState = 'connecting' | 'ready' | 'closed' | 'error';
/** Why the stream is not usable: the service refused this page's origin (close 1008), could not be reached, or dropped after being ready. */
export type StreamReason = 'origin-rejected' | 'unreachable' | 'closed';
export interface StreamInfo {
  engine?: string;
  model?: string;
  message?: string;
  /** Set with 'closed'/'error' when the stream is not usable because of the connection. */
  reason?: StreamReason;
}

/** Close code 1008 before any 'ready' = origin refused; other close before ready = unreachable; close after ready = closed. */
export function classifyClose(code: number, wasReady: boolean): StreamReason {
  if (wasReady) return 'closed';
  return code === 1008 ? 'origin-rejected' : 'unreachable';
}

const warned = new Set<string>();
/** console.warn once per (url, reason) per page load. */
export function warnUnavailable(url: string, reason: StreamReason): void {
  const key = `${url}|${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  let msg = `[phones] live phone model unavailable (${reason}) at ${url}; the board is using the basic formant view.`;
  if (reason === 'origin-rejected') {
    const origin = typeof location !== 'undefined' ? location.origin : 'unknown';
    msg += ` The phone service refused this page's origin (${origin}); allow it with PHONES_ALLOWED_ORIGINS.`;
  }
  console.warn(msg);
}
export interface PhoneUpdate extends PhoneState {
  inferMs?: number;
  /** The frames carried by this message (not accumulated); [] when the server sends none. */
  frames: PhoneFrame[];
}

/** Validate the optional `frames` field of a phones message; malformed entries are dropped, absent -> []. */
export function parseFrames(raw: unknown): PhoneFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: PhoneFrame[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const o = f as { t?: unknown; mass?: unknown; top?: unknown };
    if (typeof o.t !== 'number' || !Number.isFinite(o.t) || typeof o.mass !== 'number' || !Number.isFinite(o.mass)) continue;
    const top: [string, number][] = [];
    if (Array.isArray(o.top)) {
      for (const e of o.top) {
        if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] > 0) top.push([e[0], e[1]]);
      }
    }
    out.push({ t: o.t, mass: o.mass, top });
  }
  return out;
}

export const MAX_COMMITTED = 60;
export const TARGET_RATE = 16000;
/**
 * 50 ms at 16 kHz. The service only runs inference when a chunk arrives and its hop has elapsed (stream.py), so the chunk
 * must be no longer than the hop: 50 ms chunks give an inference every 100 ms at PHONES_HOP_MS=100 (80 ms chunks would give 160 ms).
 */
export const CHUNK_SAMPLES = 800;
const MAX_BUFFERED = 256 * 1024;
const DEFAULT_URL = 'ws://127.0.0.1:8020/ws/phones';

/** r and ɹ are the same target, and an aspirated stop (KoelLabs emits kʰ, pʰ) counts as the plain one. */
export function normPhone(p: string): string {
  const q = p.endsWith('ʰ') ? p.slice(0, -1) : p;
  return q === 'r' ? 'ɹ' : q;
}

export const EMPTY_PHONES: PhoneState = { committed: [], provisional: [] };

/** Append new committed phones (dedupe by startMs+p), replace provisional, keep the last `max` committed. */
export function mergePhones(state: PhoneState, msg: Pick<PhonesMessage, 'committed' | 'provisional'>, max = MAX_COMMITTED): PhoneState {
  const seen = new Set(state.committed.map((c) => `${c.startMs}|${c.p}`));
  const added: Phone[] = [];
  for (const ph of msg.committed ?? []) {
    const key = `${ph.startMs}|${ph.p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(ph);
  }
  const committed = added.length ? [...state.committed, ...added].slice(-max) : state.committed;
  return { committed, provisional: msg.provisional ?? [] };
}

export function floatToInt16(x: number): number {
  const s = Math.max(-1, Math.min(1, x));
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

/** Streaming linear-interpolation downsampler that emits fixed-size Int16 chunks. */
export class PcmChunker {
  private buf = new Float32Array(0);
  private pos = 0;
  private out: number[] = [];
  constructor(
    private inRate: number,
    private outRate = TARGET_RATE,
    private chunk = CHUNK_SAMPLES,
  ) {}
  push(input: Float32Array): Int16Array[] {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    const ratio = this.inRate / this.outRate;
    let pos = this.pos;
    while (pos + 1 < merged.length) {
      const i0 = Math.floor(pos);
      const f = pos - i0;
      this.out.push(floatToInt16(merged[i0] * (1 - f) + merged[i0 + 1] * f));
      pos += ratio;
    }
    const drop = Math.min(Math.floor(pos), merged.length);
    this.buf = merged.slice(drop);
    this.pos = pos - drop;
    const chunks: Int16Array[] = [];
    while (this.out.length >= this.chunk) {
      chunks.push(Int16Array.from(this.out.splice(0, this.chunk)));
    }
    return chunks;
  }
}

const WORKLET_SRC = `
class Pcm extends AudioWorkletProcessor {
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
registerProcessor('phone-pcm16-tap', Pcm);
`;

export interface PhoneStreamOptions {
  url?: string;
  onState(s: StreamState, info?: StreamInfo): void;
  onPhones(update: PhoneUpdate): void;
}
export interface PhoneStreamHandle {
  reset(): void;
  close(): void;
}

export function connectPhoneStream(stream: MediaStream, opts: PhoneStreamOptions): PhoneStreamHandle {
  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_PHONES_WS;
  const url = opts.url ?? envUrl ?? DEFAULT_URL;
  let closed = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let ready = false;
  let state: PhoneState = EMPTY_PHONES;
  let teardownAudio: (() => void) | null = null;

  const emit = (s: StreamState, info?: StreamInfo) => {
    if (!closed) opts.onState(s, info);
  };

  const schedule = () => {
    if (closed || retry) return;
    const delay = Math.min(5000, 400 * 2 ** attempt++);
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
  };

  function open() {
    if (closed) return;
    emit('connecting');
    ready = false;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      warnUnavailable(url, 'unreachable');
      emit('error', { message: 'bad url', reason: 'unreachable' });
      schedule();
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'ready') {
          ready = true;
          attempt = 0;
          state = EMPTY_PHONES;
          emit('ready', { engine: m.engine, model: m.model });
        } else if (m.type === 'phones') {
          state = mergePhones(state, m);
          if (!closed) opts.onPhones({ ...state, inferMs: m.inferMs, frames: parseFrames(m.frames) });
        } else if (m.type === 'error') {
          emit('error', { message: String(m.message ?? 'error') });
        }
      } catch {
        /* ignore malformed message */
      }
    };
    sock.onerror = () => {
      /* onclose follows */
    };
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      const wasReady = ready;
      ready = false;
      if (closed) return;
      const reason = classifyClose(e?.code ?? 1006, wasReady);
      warnUnavailable(url, reason);
      emit('closed', { reason });
      schedule();
    };
  }

  const startAudio = async () => {
    let c: AudioContext | null = null;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor || stream.getAudioTracks().length === 0) {
        emit('error', { message: 'no audio' });
        return;
      }
      c = new Ctor();
      const blob = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await c.audioWorklet.addModule(blob);
      } finally {
        URL.revokeObjectURL(blob);
      }
      if (closed) {
        void c.close().catch(() => undefined);
        return;
      }
      const ctx = c;
      const chunker = new PcmChunker(ctx.sampleRate);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'phone-pcm16-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        try {
          const chunks = chunker.push(e.data);
          const sock = ws;
          if (!sock || !ready || sock.readyState !== WebSocket.OPEN) return;
          for (const ch of chunks) {
            if (sock.bufferedAmount > MAX_BUFFERED) return; // back-pressure: drop audio
            sock.send(ch.buffer);
          }
        } catch {
          /* drop chunk */
        }
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      teardownAudio = () => {
        try {
          node.port.onmessage = null;
          source.disconnect();
          node.disconnect();
          mute.disconnect();
          void ctx.close().catch(() => undefined);
        } catch {
          /* already gone */
        }
      };
    } catch {
      try {
        void c?.close().catch(() => undefined);
      } catch {
        /* ignore */
      }
      emit('error', { message: 'audio unavailable' });
    }
  };

  open();
  void startAudio();

  return {
    reset() {
      state = EMPTY_PHONES;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
      } catch {
        /* ignore */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (retry) clearTimeout(retry);
      teardownAudio?.();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
