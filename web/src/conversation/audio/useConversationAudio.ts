import { useEffect, useMemo, useRef, useState } from 'react';
import { BargeInDetector, frameLevel } from './bargeIn';
import { InkStt, Resampler, type InkSession } from './inkStt';
import { openAecMic, type AecMic } from './micAec';
import { Segmenter, type SegmenterEvent } from './segmenter';
import type { BargeInMode, ConversationAudio, ListenMode, SegmentResult, TrackedFrame } from './types';

const STORAGE_KEY = 'articulate.bargein';
const MODES: BargeInMode[] = ['aec', 'gated', 'headphones', 'off'];
const PREROLL_SAMPLES = 4800; // 300 ms at 16 kHz
const WORKLET_BLOCK = 2048;
const INK_FLUSH_MS = 1500;
const ATTEMPT_PCM_MAX = Math.round(16000 * 8.5); // bounded attempt buffer (~272 KB)

interface PcmCapture {
  chunks: Int16Array[];
  samples: number;
  /** performance.now() time of the first buffered sample (estimated from the pre-roll sample count). */
  startMs: number;
}

function loadMode(): BargeInMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && (MODES as string[]).includes(v)) return v as BargeInMode;
  } catch { /* storage unavailable */ }
  return 'gated';
}

const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${WORKLET_BLOCK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('articulate-tap', Tap);
`;

interface State {
  listening: ListenMode;
  speaking: boolean;
  sttReady: boolean;
  bargeInMode: BargeInMode;
}

class Engine {
  state: State = { listening: 'off', speaking: false, sttReady: false, bargeInMode: loadMode() };
  readonly seg = new Segmenter();
  readonly barge = new BargeInDetector(this.state.bargeInMode);
  readonly ink = new InkStt();
  private startFns = new Set<() => void>();
  private segFns = new Set<(r: SegmentResult) => void>();
  private ring: Int16Array[] = [];
  private ringSamples = 0;
  private active: PcmCapture | null = null;
  private attemptPcm: { pcm: Int16Array; startMs: number } | null = null;
  private session: InkSession | null = null;
  private teacher = false;
  private gen = 0;
  private stopFn: (() => void) | null = null;

  constructor(private notify: () => void) {
    this.barge.mode = this.state.bargeInMode;
  }

  private set(p: Partial<State>): void {
    this.state = { ...this.state, ...p };
    this.notify();
  }

  // ---- public API pieces ----
  listen(mode: ListenMode): void {
    if (mode === this.state.listening) return;
    this.set({ listening: mode });
    if (mode === 'off') this.handle(this.seg.reset(performance.now()));
    else if (mode !== 'attempt') this.ink.prewarm();
  }

  setTeacherSpeaking(active: boolean): void {
    if (active === this.teacher) return;
    this.teacher = active;
    const now = performance.now();
    this.barge.setTeacherSpeaking(active, now);
    this.handle(this.seg.setMuted(active, now));
    if (!active && this.state.listening !== 'off' && this.state.listening !== 'attempt') this.ink.prewarm();
  }

  setBargeInMode(m: BargeInMode): void {
    this.barge.setMode(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
    this.set({ bargeInMode: m });
  }

  onSegmentStart(fn: () => void): () => void {
    this.startFns.add(fn);
    return () => this.startFns.delete(fn);
  }
  onSegment(fn: (r: SegmentResult) => void): () => void {
    this.segFns.add(fn);
    return () => this.segFns.delete(fn);
  }

  /** PCM (16 kHz mono Int16) of the most recent attempt segment, once; null for replies/discards. */
  takeAttemptPcm(): { pcm: Int16Array; startMs: number } | null {
    const a = this.attemptPcm;
    this.attemptPcm = null;
    return a;
  }

  private appendActive(pcm: Int16Array): void {
    const a = this.active;
    if (!a || a.samples >= ATTEMPT_PCM_MAX) return;
    const room = ATTEMPT_PCM_MAX - a.samples;
    const part = pcm.length > room ? pcm.subarray(0, room) : pcm;
    a.chunks.push(part);
    a.samples += part.length;
  }

  // ---- lifecycle ----
  start(deviceId: string | undefined, subscribe: (fn: (f: TrackedFrame) => void) => () => void): void {
    this.stop();
    const gen = ++this.gen;
    let aec: AecMic | null = null;
    let ctx: AudioContext | null = null;
    let unsub: (() => void) | null = null;
    let url: string | null = null;
    const cleanup = () => {
      unsub?.();
      aec?.close();
      void ctx?.close().catch(() => {});
      if (url) URL.revokeObjectURL(url);
    };
    this.stopFn = cleanup;

    unsub = subscribe((fr) => {
      const t = performance.now();
      const e = fr.estimate;
      const frame = {
        t,
        rms: e.rms,
        periodicity: e.periodicity,
        valid: e.valid,
        f1: e.valid ? e.f1 : 0,
        f2: e.valid ? e.f2 : 0,
      };
      this.barge.pushRaw({ t, rms: e.rms, periodicity: e.periodicity });
      this.handle(this.seg.push(frame));
    });

    void (async () => {
      try {
        aec = await openAecMic(deviceId);
        if (gen !== this.gen) { cleanup(); return; }
        ctx = new AudioContext();
        url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        if (gen !== this.gen) { cleanup(); return; }
        const src = ctx.createMediaStreamSource(aec.stream);
        const node = new AudioWorkletNode(ctx, 'articulate-tap');
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(node);
        node.connect(mute).connect(ctx.destination);
        const rs = new Resampler(ctx.sampleRate, 16000);
        node.port.onmessage = (m: MessageEvent<Float32Array>) => {
          if (gen === this.gen) this.onAudio(rs.process(m.data));
        };
        void ctx.resume().catch(() => {});
        await this.ink.getToken();
        if (gen === this.gen) this.set({ sttReady: true });
      } catch {
        if (gen === this.gen) this.set({ sttReady: false });
      }
    })();
  }

  stop(): void {
    this.gen++;
    this.stopFn?.();
    this.stopFn = null;
    this.session?.abort();
    this.session = null;
    this.ring = [];
    this.ringSamples = 0;
    this.active = null;
    this.attemptPcm = null;
    if (this.state.sttReady || this.state.speaking) this.set({ sttReady: false, speaking: false });
  }

  dispose(): void {
    this.stop();
    this.startFns.clear();
    this.segFns.clear();
  }

  // ---- audio path ----
  private onAudio(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const now = performance.now();
    const lvl = frameLevel(pcm);
    this.barge.pushAec({ t: now, rms: lvl.rms / 32768, periodicity: lvl.periodicity });
    this.appendActive(pcm);
    if (this.session) {
      this.session.push(pcm);
      return;
    }
    this.ring.push(pcm);
    this.ringSamples += pcm.length;
    while (this.ring.length > 1 && this.ringSamples - this.ring[0].length >= PREROLL_SAMPLES) {
      this.ringSamples -= this.ring.shift()!.length;
    }
  }

  private handle(events: SegmenterEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'start') {
        this.set({ speaking: true });
        this.attemptPcm = null;
        this.active = { chunks: [], samples: 0, startMs: performance.now() - this.ringSamples / 16 };
        for (const c of this.ring) this.appendActive(c);
        if (this.state.listening !== 'attempt') {
          const s = this.ink.open();
          for (const c of this.ring) s.push(c);
          this.ring = [];
          this.ringSamples = 0;
          this.session = s;
        }
        for (const fn of [...this.startFns]) fn();
      } else {
        this.set({ speaking: false });
        const s = this.session;
        this.session = null;
        const cap = this.active;
        this.active = null;
        if (cap && ev.type === 'segment' && ev.kind === 'attempt' && this.state.listening !== 'off') {
          const pcm = new Int16Array(cap.samples);
          let o = 0;
          for (const c of cap.chunks) {
            pcm.set(c, o);
            o += c.length;
          }
          this.attemptPcm = { pcm, startMs: cap.startMs };
        }
        if (ev.type === 'discard' || this.state.listening === 'off') {
          s?.abort();
        } else {
          void this.deliver(ev, s);
        }
      }
    }
  }

  private async deliver(ev: Extract<SegmenterEvent, { type: 'segment' }>, s: InkSession | null): Promise<void> {
    let transcript: string | null = null;
    let sttError: string | null = null;
    if (ev.kind === 'attempt') {
      s?.abort();
    } else if (s) {
      const r = await s.finish(INK_FLUSH_MS);
      transcript = r.error ? null : r.transcript;
      sttError = r.error;
    }
    const result: SegmentResult = {
      kind: ev.kind,
      startedAt: ev.startedAt,
      endedAt: ev.endedAt,
      durationMs: ev.durationMs,
      voicedFraction: ev.voicedFraction,
      formantStability: ev.formantStability,
      transcript,
      sttError,
    };
    for (const fn of [...this.segFns]) fn(result);
  }
}

export function useConversationAudio(opts: {
  vowel: { subscribe(fn: (f: TrackedFrame) => void): () => void };
  enabled: boolean;
  deviceId?: string;
}): ConversationAudio {
  const { vowel, enabled, deviceId } = opts;
  const [, force] = useState(0);
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) engineRef.current = new Engine(() => force((n) => n + 1));
  const eng = engineRef.current;
  const subscribe = vowel.subscribe;

  useEffect(() => {
    if (!enabled) return;
    eng.start(deviceId, subscribe);
    return () => eng.stop();
  }, [eng, enabled, deviceId, subscribe]);

  useEffect(() => () => eng.dispose(), [eng]);

  // Bridge barge-in fire to subscribers.
  const bargeFns = useRef(new Set<() => void>());
  useEffect(() => {
    const off = eng.barge.onFire(() => {
      for (const fn of [...bargeFns.current]) fn();
    });
    return off;
  }, [eng]);

  const s = eng.state;
  return useMemo<ConversationAudio>(
    () => ({
      listening: s.listening,
      speaking: s.speaking,
      sttReady: s.sttReady,
      bargeInMode: s.bargeInMode,
      listen: (m) => eng.listen(m),
      onSegmentStart: (fn) => eng.onSegmentStart(fn),
      onSegment: (fn) => eng.onSegment(fn),
      setTeacherSpeaking: (a) => eng.setTeacherSpeaking(a),
      takeAttemptPcm: () => eng.takeAttemptPcm(),
      onBargeIn: (fn) => {
        bargeFns.current.add(fn);
        return () => bargeFns.current.delete(fn);
      },
      setBargeInMode: (m) => eng.setBargeInMode(m),
      setTeacherLevel: (rms) => eng.barge.setOutputLevel(rms),
      dispose: () => eng.dispose(),
    }),
    [eng, s],
  );
}
