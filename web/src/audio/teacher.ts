// Teacher speech: Cartesia streaming TTS over WebSocket (token from our backend), played through Web Audio,
// with word and phoneme timestamps and a playback clock. Falls back to speechSynthesis.

import { emit } from '../telemetry/client';

export interface TimedWord { text: string; start: number; end: number }
export interface TimedPhoneme { p: string; start: number; end: number }
export type TeacherEvent = 'start' | 'word' | 'timeline' | 'end' | 'error';

export interface TeacherSpeech {
  readonly source: 'cartesia' | 'browser';
  readonly text: string;
  readonly words: TimedWord[];
  readonly phonemes: TimedPhoneme[];
  clock(): number;
  on(ev: 'start', fn: () => void): () => void;
  on(ev: 'word', fn: (index: number) => void): () => void;
  on(ev: 'timeline', fn: (added: { words: TimedWord[]; phonemes: TimedPhoneme[] }) => void): () => void;
  on(ev: 'end', fn: (reason: 'finished' | 'cancelled') => void): () => void;
  on(ev: 'error', fn: (message: string) => void): () => void;
  readonly done: Promise<void>;
  cancel(): void;
}

interface TokenResponse {
  token: string;
  ws_url: string;
  cartesia_version: string;
  model_id: string;
  voice_id: string;
  sample_rate: number;
  encoding: string;
}

const TOKEN_TIMEOUT_MS = 10_000;
const LEAD_S = 0.05;
const TICK_MS = 30;

const TOKEN_TTL_MS = 120_000; // backend token lifetime
const TOKEN_MIN_REMAINING_MS = 30_000;
const REUSED_SOCKET_WATCHDOG_MS = 3000;

let sharedCtx: AudioContext | null = null;
let current: Impl | null = null;

// Prewarmed transport. The token is only ever held in memory and never logged.
let tokenCache: { info: TokenResponse; expiresAt: number } | null = null;
let tokenInflight: Promise<TokenResponse> | null = null;
let idle: { ws: WebSocket; info: TokenResponse } | null = null;

function cachedToken(): TokenResponse | null {
  if (tokenCache && tokenCache.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) return tokenCache.info;
  return null;
}

/** Shared by prepareTeacher and speakTeacher so concurrent callers use one request. */
function getToken(): Promise<TokenResponse> {
  const hit = cachedToken();
  if (hit) return Promise.resolve(hit);
  if (tokenInflight) return tokenInflight;
  const fetchedAt = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TOKEN_TIMEOUT_MS);
  const p = (async () => {
    const res = await fetch('/v1/speech/token', { method: 'POST', signal: ctl.signal });
    if (!res.ok) throw new Error(`Token request failed (${res.status}).`);
    const info = (await res.json()) as TokenResponse;
    if (!info || typeof info.token !== 'string' || !info.token) throw new Error('Token response was empty.');
    tokenCache = { info, expiresAt: fetchedAt + TOKEN_TTL_MS };
    return info;
  })().finally(() => {
    clearTimeout(timer);
    if (tokenInflight === p) tokenInflight = null;
  });
  tokenInflight = p;
  return p;
}

function socketUrl(info: TokenResponse): string {
  return `${info.ws_url}?cartesia_version=${encodeURIComponent(info.cartesia_version)}&access_token=${encodeURIComponent(info.token)}`;
}

/** Park a socket as the idle one; any failure or close discards it. */
function parkIdle(ws: WebSocket, info: TokenResponse): void {
  if (idle && idle.ws !== ws) { try { idle.ws.close(); } catch { /* ignore */ } }
  idle = { ws, info };
  const drop = () => { if (idle?.ws === ws) idle = null; };
  ws.onmessage = null;
  ws.onerror = drop;
  ws.onclose = drop;
}

/** Hand the idle socket (open or still connecting) to a speaker; it must replace the handlers. */
function takeIdle(): { ws: WebSocket; info: TokenResponse } | null {
  const it = idle;
  idle = null;
  if (!it) return null;
  if (it.ws.readyState === WebSocket.OPEN || it.ws.readyState === WebSocket.CONNECTING) return it;
  return null;
}

/**
 * Fire-and-forget warm-up: cache a speech token and open an idle Cartesia socket so the next
 * speakTeacher starts without a connect delay. Silently does nothing if the token endpoint fails.
 */
export function prepareTeacher(): void {
  try {
    if (typeof WebSocket === 'undefined') return;
    if (idle && (idle.ws.readyState === WebSocket.OPEN || idle.ws.readyState === WebSocket.CONNECTING)) {
      if (cachedToken()) return;
    }
    void getToken()
      .then((info) => {
        if (idle && (idle.ws.readyState === WebSocket.OPEN || idle.ws.readyState === WebSocket.CONNECTING)) return;
        parkIdle(new WebSocket(socketUrl(info)), info);
      })
      .catch(() => undefined);
  } catch {
    /* warm-up is best effort */
  }
}

function getCtx(sampleRate: number): AudioContext | null {
  try {
    if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      sharedCtx = new Ctor({ sampleRate });
    } catch {
      sharedCtx = new Ctor();
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

export function unlockTeacherAudio(): Promise<void> {
  const ctx = getCtx(24000);
  if (!ctx) return Promise.resolve();
  return ctx.resume().catch(() => undefined);
}

/** Decode base64 little-endian float32 PCM. Returns the samples plus any trailing partial-sample bytes. */
export function decodeF32(base64: string, carry: Uint8Array = new Uint8Array(0)): { samples: Float32Array; rest: Uint8Array } {
  const bin = atob(base64);
  const bytes = new Uint8Array(carry.length + bin.length);
  bytes.set(carry, 0);
  for (let i = 0; i < bin.length; i++) bytes[carry.length + i] = bin.charCodeAt(i);
  const whole = bytes.length - (bytes.length % 4);
  const view = new DataView(bytes.buffer, 0, whole);
  const samples = new Float32Array(whole / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
  return { samples, rest: bytes.slice(whole) };
}

function newContextId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

type Listener = (...args: never[]) => void;

class Impl implements TeacherSpeech {
  source: 'cartesia' | 'browser' = 'cartesia';
  readonly words: TimedWord[] = [];
  readonly phonemes: TimedPhoneme[] = [];
  readonly done: Promise<void>;

  private listeners: Record<TeacherEvent, Set<Listener>> = {
    start: new Set(), word: new Set(), timeline: new Set(), end: new Set(), error: new Set(),
  };
  private resolveDone!: () => void;
  private ended = false;
  private started = false;
  private lastWord = -1;
  private ticker: ReturnType<typeof setInterval> | null = null;

  // cartesia
  private ws: WebSocket | null = null;
  private contextId = newContextId();
  private ctx: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private startAt = 0;
  private nextAt = 0;
  // Silences inserted when a chunk arrived after the queue ran dry, in AudioContext time; the audio
  // stream position skips them, so Cartesia's timestamps stay aligned with what is heard.
  private gaps: { from: number; to: number }[] = [];
  private gap = 0; // total of gaps, in seconds
  private lastClock = -Infinity; // clock() never goes backwards once started
  private streamDone = false;
  private carry: Uint8Array = new Uint8Array(0);
  private samplesTotal = 0;
  private sampleRate = 24000;
  private info: TokenResponse | null = null;
  private gotMessage = false;

  // browser fallback
  private utterance: SpeechSynthesisUtterance | null = null;
  private browserStart = 0;
  private boundarySeen = false;

  private frozen: number | null = null;

  constructor(readonly text: string, private readonly speed: number | undefined) {
    this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  }

  on(ev: TeacherEvent, fn: Listener): () => void {
    this.listeners[ev].add(fn);
    return () => { this.listeners[ev].delete(fn); };
  }

  private emit(ev: TeacherEvent, ...args: unknown[]): void {
    for (const fn of [...this.listeners[ev]]) {
      try { (fn as (...a: unknown[]) => void)(...args); } catch { /* listener errors never break playback */ }
    }
  }

  clock(): number {
    if (this.frozen !== null) return this.frozen;
    return this.rawClock();
  }

  private rawClock(): number {
    if (!this.started) return -1;
    if (this.source === 'browser') return (performance.now() - this.browserStart) / 1000;
    if (!this.ctx) return -1;
    // Negative only during the pre-roll before the first sample is heard (lip sync reads that as "not
    // started"); after that it never drops below 0 or goes backwards, even if the output latency changes.
    const t = this.streamPosition(this.heardTime(this.ctx));
    if (t > this.lastClock) this.lastClock = t;
    return this.lastClock;
  }

  /** AudioContext time of the sample reaching the listener now (the scheduling clock minus output latency). */
  private heardTime(ctx: AudioContext): number {
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /**
   * Seconds of Cartesia audio played by context time `at`: wall time since the first chunk, minus the
   * silences where the queue ran dry, and frozen at the end of the queued audio while it waits.
   */
  private streamPosition(at: number): number {
    const t = Math.min(at, this.nextAt);
    if (this.gap === 0) return t - this.startAt;
    let skipped = 0;
    for (const g of this.gaps) {
      if (t <= g.from) break;
      skipped += Math.min(t, g.to) - g.from;
    }
    return t - this.startAt - skipped;
  }

  // ---- lifecycle

  begin(): void {
    void this.runCartesia();
  }

  cancel(): void {
    if (this.ended) return;
    this.teardownTransport(true);
    this.finish('cancelled');
  }

  private finish(reason: 'finished' | 'cancelled'): void {
    if (this.ended) return;
    this.frozen = this.rawClock();
    this.ended = true;
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (current === this) current = null;
    this.emit('end', reason);
    this.resolveDone();
  }

  private teardownTransport(sendCancel: boolean): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (sendCancel && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    }
    for (const s of this.sources) {
      try { s.onended = null; s.stop(); } catch { /* already stopped */ }
      try { s.disconnect(); } catch { /* ignore */ }
    }
    this.sources = [];
    if (this.utterance && typeof speechSynthesis !== 'undefined') {
      this.utterance.onend = null;
      this.utterance.onerror = null;
      this.utterance.onboundary = null;
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    if (this.ended) return;
    const t = this.rawClock();
    // Finish once the last queued sample has been heard, so the frozen clock lands on the full stream length.
    if (this.source === 'cartesia' && this.streamDone && this.ctx && this.heardTime(this.ctx) >= this.nextAt) {
      this.finish('finished');
      return;
    }
    if (this.source === 'browser' && this.boundarySeen) return;
    this.advanceWord(t);
  }

  private advanceWord(t: number): void {
    let idx = -1;
    for (let i = 0; i < this.words.length; i++) {
      if (this.words[i].start <= t) idx = i;
      else break;
    }
    if (idx !== this.lastWord && idx >= 0) {
      this.lastWord = idx;
      this.emit('word', idx);
    }
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.emit('start');
    this.startTicker();
  }

  // ---- cartesia

  private async runCartesia(): Promise<void> {
    try {
      const ctx = getCtx(24000);
      if (!ctx || typeof WebSocket === 'undefined') throw new Error('Web Audio or WebSocket unavailable.');
      this.ctx = ctx;
      void ctx.resume().catch(() => undefined);
      let parked = takeIdle();
      if (!parked) {
        const info = await getToken();
        if (this.ended) return;
        parked = takeIdle(); // a warm-up may have finished while the token was in flight
        if (!parked) {
          this.sampleRate = info.sample_rate || 24000;
          this.openSocket(info, new WebSocket(socketUrl(info)), false);
          return;
        }
      }
      if (this.ended) {
        parkIdle(parked.ws, parked.info);
        return;
      }
      this.sampleRate = parked.info.sample_rate || 24000;
      this.openSocket(parked.info, parked.ws, true);
    } catch (err) {
      if (this.ended) return;
      this.failTransport(err instanceof Error ? err.message : 'Cartesia was unavailable.');
    }
  }

  private openSocket(info: TokenResponse, ws: WebSocket, reused: boolean): void {
    this.ws = ws;
    this.info = info;
    this.gotMessage = false;
    const send = () => {
      const body: Record<string, unknown> = {
        model_id: info.model_id,
        transcript: this.text,
        voice: { mode: 'id', id: info.voice_id },
        output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: this.sampleRate },
        context_id: this.contextId,
        language: 'en',
        add_timestamps: true,
        add_phoneme_timestamps: true,
        continue: false,
      };
      if (this.speed !== undefined && Math.abs(this.speed - 1) > 0.01) body.generation_config = { speed: this.speed };
      emit('ui', 'tts', 'tts.speak', 'speak line', { chars: this.text.length, voice: info.voice_id });
      ws.send(JSON.stringify(body));
    };
    ws.onopen = send;
    ws.onmessage = (event) => { this.gotMessage = true; this.onMessage(event.data); };
    ws.onerror = () => this.failTransport('Cartesia connection error.');
    ws.onclose = () => {
      if (this.ended || this.streamDone) return;
      this.failTransport('Cartesia connection closed early.');
    };
    if (ws.readyState === WebSocket.OPEN) {
      try { send(); } catch { this.failTransport('Cartesia connection error.'); return; }
    }
    if (reused) {
      // An idle socket can be dead without a close event; if it stays silent, retry once on a fresh socket.
      setTimeout(() => {
        if (this.ended || this.gotMessage || this.ws !== ws) return;
        this.ws = null;
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch { /* ignore */ }
        try {
          this.openSocket(info, new WebSocket(socketUrl(info)), false);
        } catch {
          this.failTransport('Cartesia connection error.');
        }
      }, REUSED_SOCKET_WATCHDOG_MS);
    }
  }

  /** Exposed for tests through the module-level helper; merges one server message. */
  handleMessage(raw: unknown): void {
    this.onMessage(raw);
  }

  private onMessage(raw: unknown): void {
    if (this.ended || typeof raw !== 'string') return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.context_id === 'string' && msg.context_id !== this.contextId) return;
    switch (msg.type) {
      case 'chunk':
        if (typeof msg.data === 'string') this.onChunk(msg.data);
        if (msg.done === true) this.markStreamDone();
        break;
      case 'timestamps':
        this.mergeWords(msg.word_timestamps);
        break;
      case 'phoneme_timestamps':
        this.mergePhonemes(msg.phoneme_timestamps);
        break;
      case 'done':
        this.markStreamDone();
        break;
      case 'error': {
        const m = typeof msg.message === 'string' ? msg.message : typeof msg.title === 'string' ? msg.title : 'Cartesia error.';
        this.failTransport(m);
        break;
      }
      default:
        break;
    }
  }

  private onChunk(b64: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let decoded: { samples: Float32Array; rest: Uint8Array };
    try { decoded = decodeF32(b64, this.carry); } catch { return; }
    this.carry = decoded.rest;
    if (decoded.samples.length === 0) return;
    this.samplesTotal += decoded.samples.length;
    const buffer = ctx.createBuffer(1, decoded.samples.length, this.sampleRate);
    buffer.copyToChannel(decoded.samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(this.nextAt, ctx.currentTime + LEAD_S);
    if (this.started && at > this.nextAt) {
      // Late chunk (network jitter): the speaker falls silent until `at`; the stream clock skips it.
      this.gaps.push({ from: this.nextAt, to: at });
      this.gap += at - this.nextAt;
    }
    if (!this.started) {
      this.startAt = at;
      this.markStarted();
    }
    source.start(at);
    this.nextAt = at + buffer.duration;
    this.sources.push(source);
    source.onended = () => { this.sources = this.sources.filter((s) => s !== source); };
  }

  private markStreamDone(): void {
    this.streamDone = true;
    emit('tts', 'ui', 'tts.audio', 'speech audio received', { ms: Math.round((this.samplesTotal / this.sampleRate) * 1000) });
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Clean end of this context: return the socket to the idle slot for the next utterance.
      if (ws.readyState === WebSocket.OPEN && this.info) parkIdle(ws, this.info);
      else { try { ws.close(); } catch { /* ignore */ } }
    }
    if (!this.started) this.finish('finished');
  }

  private mergeWords(block: unknown): void {
    const b = block as { words?: unknown; start?: unknown; end?: unknown } | undefined;
    if (!b || !Array.isArray(b.words)) return;
    const starts = Array.isArray(b.start) ? b.start : [];
    const ends = Array.isArray(b.end) ? b.end : [];
    const added: TimedWord[] = [];
    b.words.forEach((w, i) => {
      const item = { text: String(w), start: num(starts[i]), end: num(ends[i]) };
      this.words.push(item);
      added.push(item);
    });
    if (added.length) this.emit('timeline', { words: added, phonemes: [] });
  }

  private mergePhonemes(block: unknown): void {
    const b = block as { phonemes?: unknown; start?: unknown; end?: unknown } | undefined;
    if (!b || !Array.isArray(b.phonemes)) return;
    const starts = Array.isArray(b.start) ? b.start : [];
    const ends = Array.isArray(b.end) ? b.end : [];
    const added: TimedPhoneme[] = [];
    b.phonemes.forEach((p, i) => {
      const item = { p: String(p), start: num(starts[i]), end: num(ends[i]) };
      this.phonemes.push(item);
      added.push(item);
    });
    if (added.length) this.emit('timeline', { words: [], phonemes: added });
  }

  private failTransport(message: string): void {
    if (this.ended) return;
    if (!this.started && this.source === 'cartesia') {
      this.teardownTransport(false);
      this.words.length = 0;
      this.phonemes.length = 0;
      this.startBrowser(message);
      return;
    }
    // Mid-stream: keep what already plays, report, and end when queued audio finishes.
    this.emit('error', message);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.streamDone = true;
    if (!this.started) this.finish('finished');
  }

  // ---- browser fallback

  private startBrowser(reason: string): void {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      this.emit('error', `${reason} Speech is unavailable in this browser.`);
      this.finish('finished');
      return;
    }
    this.source = 'browser';
    const rate = this.speed ?? 1;
    const parts = [...this.text.matchAll(/\S+/g)];
    const weights = parts.map((m) => m[0].length + 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const duration = Math.max(0.5, this.text.length / (14 * rate));
    const starts: number[] = [];
    let t = 0;
    parts.forEach((m, i) => {
      const len = (weights[i] / total) * duration;
      starts.push(m.index ?? 0);
      this.words.push({ text: m[0], start: t, end: t + len });
      t += len;
    });
    if (this.words.length) this.emit('timeline', { words: [...this.words], phonemes: [] });

    const u = new SpeechSynthesisUtterance(this.text);
    u.rate = rate;
    this.utterance = u;
    u.onstart = () => {
      this.browserStart = performance.now();
      this.markStarted();
    };
    u.onboundary = (e: SpeechSynthesisEvent) => {
      if (this.ended || e.name === 'sentence') return;
      let idx = -1;
      for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= e.charIndex) idx = i;
        else break;
      }
      if (idx < 0) return;
      this.boundarySeen = true;
      const now = this.rawClock();
      this.words[idx].start = Math.max(0, now);
      if (idx > 0 && this.words[idx - 1].end > now) this.words[idx - 1].end = now;
      if (idx !== this.lastWord) {
        this.lastWord = idx;
        this.emit('word', idx);
      }
    };
    u.onend = () => {
      if (this.words.length) this.words[this.words.length - 1].end = Math.max(this.words[this.words.length - 1].start, this.rawClock());
      this.finish('finished');
    };
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (this.ended) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      this.emit('error', 'Browser speech failed.');
      this.finish('finished');
    };
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      this.emit('error', `${reason} Browser speech failed.`);
      this.finish('finished');
    }
  }
}

export function speakTeacher(text: string, opts?: { speed?: number }): TeacherSpeech {
  current?.cancel();
  const speed = opts?.speed === undefined ? undefined : Math.min(1.5, Math.max(0.6, opts.speed));
  const speech = new Impl(text, speed);
  current = speech;
  speech.begin();
  return speech;
}
