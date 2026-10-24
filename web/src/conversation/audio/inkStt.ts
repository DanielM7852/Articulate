/**
 * Cartesia Ink streaming speech-to-text client plus a streaming 16 kHz s16le resampler.
 * The access token is only held in memory and never logged (it appears only in the socket URL).
 */

export class Resampler {
  private acc = 0;
  private filled = 0;
  private readonly ratio: number;
  constructor(inRate: number, outRate = 16000) {
    this.ratio = inRate / outRate;
  }
  /** Streaming box-filter downsample of float samples (-1..1) to s16. */
  process(input: Float32Array): Int16Array {
    const ratio = this.ratio;
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, ratio - this.filled);
        this.acc += x * take;
        this.filled += take;
        remaining -= take;
        if (this.filled >= ratio - 1e-9) {
          out.push(this.acc / ratio);
          this.acc = 0;
          this.filled = 0;
        }
      }
    }
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return pcm;
  }
}

export interface InkConfig {
  /** 'ink-whisper' (default) or 'ink-2'. */
  model?: string;
  language?: string;
  /** Only sent for ink-2. */
  keyterms?: string[];
  version?: string;
  wsUrl?: string;
  tokenUrl?: string;
}

export interface InkResult {
  transcript: string;
  error: string | null;
}

export interface InkSession {
  push(pcm: Int16Array): void;
  /** Send finalize and wait up to timeoutMs (after it is sent) for flush_done. */
  finish(timeoutMs?: number): Promise<InkResult>;
  abort(): void;
}

const DEFAULT_KEYTERMS = ['again', 'ready', 'skip', 'show me', 'why'];
const TOKEN_MIN_REMAINING_MS = 30_000;
const TOKEN_FALLBACK_TTL_MS = 120_000;
const WARM_MAX_AGE_MS = 10_000;
const SEND_SAMPLES = 1600; // ~100 ms at 16 kHz
const CONNECT_CAP_MS = 6000;

function parseExpiry(v: unknown, fetchedAt: number): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fetchedAt + TOKEN_FALLBACK_TTL_MS;
}

export class InkStt {
  private cfg: Required<InkConfig>;
  private token: { value: string; expiresAt: number; wsUrl?: string; version?: string } | null = null;
  private inflight: Promise<string> | null = null;
  private warm: { ws: WebSocket; at: number } | null = null;

  constructor(cfg: InkConfig = {}) {
    this.cfg = {
      model: cfg.model ?? 'ink-whisper',
      language: cfg.language ?? 'en',
      keyterms: cfg.keyterms ?? DEFAULT_KEYTERMS,
      version: cfg.version ?? '2026-08-14',
      wsUrl: cfg.wsUrl ?? 'wss://api.cartesia.ai/stt/websocket',
      tokenUrl: cfg.tokenUrl ?? '/v1/speech/token',
    };
  }

  getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) return Promise.resolve(this.token.value);
    if (this.inflight) return this.inflight;
    const fetchedAt = Date.now();
    const p = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      try {
        const res = await fetch(this.cfg.tokenUrl, { method: 'POST', signal: ctl.signal });
        if (!res.ok) throw new Error(`Token request failed (${res.status}).`);
        const j = (await res.json()) as Record<string, unknown>;
        if (typeof j.token !== 'string' || !j.token) throw new Error('Token response was empty.');
        this.token = {
          value: j.token,
          expiresAt: parseExpiry(j.expires_at, fetchedAt),
          wsUrl: typeof j.stt_ws_url === 'string' ? j.stt_ws_url : undefined,
          version: typeof j.stt_cartesia_version === 'string' ? j.stt_cartesia_version : undefined,
        };
        return j.token;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private url(token: string): string {
    const c = this.cfg;
    const q = new URLSearchParams({
      model: c.model,
      language: c.language,
      encoding: 'pcm_s16le',
      sample_rate: '16000',
      cartesia_version: this.token?.version ?? c.version,
    });
    if (c.model === 'ink-2') for (const k of c.keyterms) q.append('keyterm', k);
    q.set('access_token', token);
    return `${this.token?.wsUrl ?? c.wsUrl}?${q.toString()}`;
  }

  private connect(): Promise<WebSocket> {
    return this.getToken().then(
      (token) =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(this.url(token));
          ws.binaryType = 'arraybuffer';
          const fail = () => reject(new Error('Ink connection failed.'));
          ws.addEventListener('open', () => {
            ws.removeEventListener('error', fail);
            resolve(ws);
          });
          ws.addEventListener('error', fail);
        }),
    );
  }

  /** Open a socket ahead of time; the next session adopts it if it is still fresh. */
  prewarm(): void {
    if (this.warm && Date.now() - this.warm.at < WARM_MAX_AGE_MS) return;
    this.warm = null;
    const at = Date.now();
    this.connect()
      .then((ws) => {
        const w = { ws, at };
        this.warm = w;
        ws.addEventListener('close', () => {
          if (this.warm === w) this.warm = null;
        });
        setTimeout(() => {
          if (this.warm === w) {
            this.warm = null;
            try { ws.close(); } catch { /* ignore */ }
          }
        }, WARM_MAX_AGE_MS);
      })
      .catch(() => {});
  }

  open(): InkSession {
    const w = this.warm;
    this.warm = null;
    const fresh = w && Date.now() - w.at < WARM_MAX_AGE_MS && w.ws.readyState === WebSocket.OPEN;
    return new InkSessionImpl(fresh ? Promise.resolve(w.ws) : this.connect());
  }
}

class InkSessionImpl implements InkSession {
  private ws: WebSocket | null = null;
  private queue: Int16Array[] = [];
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private text = '';
  private error: string | null = null;
  private finalizing = false;
  private aborted = false;
  private settle: (() => void) | null = null;

  constructor(conn: Promise<WebSocket>) {
    conn.then(
      (ws) => {
        if (this.aborted) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        this.ws = ws;
        ws.addEventListener('message', (e) => this.onMessage(e));
        ws.addEventListener('close', () => this.settle?.());
        for (const q of this.queue) ws.send(q);
        this.queue = [];
        if (this.finalizing) this.sendFinalize();
      },
      (err: unknown) => {
        this.error = err instanceof Error ? err.message : 'Ink unavailable.';
        this.settle?.();
      },
    );
  }

  private onMessage(e: MessageEvent): void {
    if (typeof e.data !== 'string') return;
    let m: { type?: string; is_final?: boolean; text?: string; title?: string; message?: string };
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'transcript') {
      if (m.is_final && typeof m.text === 'string') this.text += m.text;
    } else if (m.type === 'flush_done') {
      this.settle?.();
    } else if (m.type === 'error') {
      this.error = m.title || m.message || 'Ink error.';
      this.settle?.();
    }
  }

  private sendChunk(pcm: Int16Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else this.queue.push(pcm);
  }

  private flushPending(): void {
    if (!this.pendingSamples) return;
    const all = new Int16Array(this.pendingSamples);
    let o = 0;
    for (const p of this.pending) {
      all.set(p, o);
      o += p.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    this.sendChunk(all);
  }

  push(pcm: Int16Array): void {
    if (this.aborted || this.finalizing) return;
    this.pending.push(pcm);
    this.pendingSamples += pcm.length;
    if (this.pendingSamples >= SEND_SAMPLES) this.flushPending();
  }

  private sendFinalize(): void {
    try { this.ws?.send('finalize'); } catch { /* ignore */ }
  }

  finish(timeoutMs = 1500): Promise<InkResult> {
    this.flushPending();
    this.finalizing = true;
    return new Promise<InkResult>((resolve) => {
      let done = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const end = (err?: string) => {
        if (done) return;
        done = true;
        clearTimeout(flushTimer);
        clearTimeout(cap);
        clearInterval(poll);
        if (err && !this.error && !this.text) this.error = err;
        this.close();
        resolve({ transcript: this.text, error: this.text ? null : this.error });
      };
      this.settle = () => end();
      // Connection time is excluded from the flush timeout, but capped.
      const cap = setTimeout(() => end('Ink timed out.'), CONNECT_CAP_MS + timeoutMs);
      const armFlush = () => {
        this.sendFinalize();
        flushTimer = setTimeout(() => end('Ink timed out.'), timeoutMs);
      };
      if (this.error && !this.ws) end();
      else if (this.ws && this.ws.readyState === WebSocket.OPEN) armFlush();
      else {
        poll = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            clearInterval(poll);
            armFlush();
          }
        }, 20);
      }
    });
  }

  private close(): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('close');
      this.ws?.close();
    } catch { /* ignore */ }
    this.ws = null;
  }

  abort(): void {
    this.aborted = true;
    this.close();
  }
}
