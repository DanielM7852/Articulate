import { DbConnection } from '../module_bindings';
import { readToken, saveToken } from '../live/stdbToken';
import { loadSession } from '../classroom/session';

/**
 * Fire-and-forget telemetry for the backend dashboard (see docs/telemetry.md).
 * Owns its own SpacetimeDB connection, opened lazily on first emit/subscribe, reconnecting with
 * backoff. Nothing here ever throws to callers. Disabled when VITE_TELEMETRY=off.
 */
export type NodeId =
  | 'camera' | 'mediapipe' | 'mic' | 'audio' | 'stt' | 'tts'
  | 'backend' | 'pitch' | 'sparc' | 'db' | 'claude' | 'ui';

export interface TelemetryEvent {
  id: string;
  /** ms since epoch */
  at: number;
  source: NodeId;
  target: NodeId;
  kind: string;
  label: string;
  payload: Record<string, unknown>;
}

const DEFAULT_URI = 'wss://maincloud.spacetimedb.com';
const DEFAULT_DB = 'articulate-live';
const BACKOFF_MS = [1000, 2000, 5000, 10000];
const MAX_INFLIGHT = 20;
// Emits made while the connection is still opening (the first emit of a tab opens it) wait here
// briefly instead of being dropped; anything older than PENDING_MAX_AGE_MS at flush time is discarded.
const PENDING_MAX = 16;
const PENDING_MAX_AGE_MS = 10_000;
const pending: Array<{ at: number; source: NodeId; target: NodeId; kind: string; label: string; payload: Record<string, unknown> }> = [];
const MAX_LABEL = 120;

interface RawRow {
  id: bigint;
  at: { toMillis(): bigint };
  source: string;
  target: string;
  kind: string;
  label: string;
  payload: string;
}

interface Sub {
  cb: (e: TelemetryEvent) => void;
  live: boolean;
  maxId: bigint;
}

const disabled = import.meta.env.VITE_TELEMETRY === 'off';

let conn: DbConnection | null = null;
let ready = false;
let applied = false;
let started = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
const subs = new Set<Sub>();

/**
 * Per-kind delivery counters, exposed as `window.__telemetryStats` for debugging (docs/telemetry.md).
 * sent: reducer calls made; accepted / rejected: their outcome (the reducer promise resolves, or rejects with
 * the SDK's SenderError / InternalError); dropped: emits skipped because the connection was not ready or too
 * many calls were in flight. Throttled emits are not counted.
 */
export interface TelemetryKindStats {
  sent: number;
  accepted: number;
  rejected: number;
  dropped: number;
  lastError: string | null;
}
const stats: Record<string, TelemetryKindStats> = {};
const warnedKinds = new Set<string>();
let warnedSubscription = false;

declare global {
  interface Window {
    __telemetryStats?: Record<string, TelemetryKindStats>;
  }
}
try {
  if (typeof window !== 'undefined') window.__telemetryStats = stats;
} catch {
  /* ignore */
}

function statFor(kind: string): TelemetryKindStats {
  let s = stats[kind];
  if (!s) {
    s = { sent: 0, accepted: 0, rejected: 0, dropped: 0, lastError: null };
    stats[kind] = s;
  }
  return s;
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

const SID_KEY = 'articulate.telemetry.sid';
const PING_MS = 20000;
let sid: string | null = null;
let presenceStarted = false;

/** Anonymous per-tab session id: 8 random hex chars, no identity data. */
export function getSessionId(): string {
  if (sid) return sid;
  try {
    const saved = sessionStorage.getItem(SID_KEY);
    if (saved && /^[0-9a-f]{8}$/.test(saved)) {
      sid = saved;
      return sid;
    }
  } catch {
    /* fall through to a fresh id */
  }
  const bytes = new Uint8Array(4);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  sid = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(SID_KEY, sid);
  } catch {
    /* in-memory only */
  }
  return sid;
}

/** Coarse device class only; never the UA string. */
function deviceClass(): 'phone' | 'tablet' | 'desktop' {
  try {
    const ua = navigator.userAgent || '';
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'phone';
    if (coarse && Math.min(screen.width, screen.height) >= 600) return 'tablet';
    if (coarse) return 'phone';
  } catch {
    /* default below */
  }
  return 'desktop';
}

/**
 * The classroom profile id when this tab is a joined classroom learner, else null. Read fresh each time, so a
 * learner who joins after the page loaded is attributed from the next ping. The teacher's per-learner view maps
 * sid -> pid from this (display attribution only; see docs/telemetry.md).
 */
function learnerPid(): string | null {
  const s = loadSession();
  return s?.role === 'learner' && typeof s.profileId === 'string' && s.profileId.length <= 64 ? s.profileId : null;
}

function startPresence(): void {
  if (presenceStarted) return;
  // The dashboard viewer is not a learner.
  try {
    if (/^#\/?dashboard/.test(window.location.hash)) return;
    if (/teach\.html$/i.test(window.location.pathname)) return;
  } catch {
    /* ignore */
  }
  presenceStarted = true;
  const pid = learnerPid();
  emit('ui', 'db', 'ui.join', 'learner joined', pid ? { sid: getSessionId(), ua: deviceClass(), pid } : { sid: getSessionId(), ua: deviceClass() });
  try {
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const p = learnerPid();
      emit('ui', 'db', 'ui.ping', 'presence ping', p ? { pid: p } : {});
    }, PING_MS);
    window.addEventListener('pagehide', () => {
      emit('ui', 'db', 'ui.leave', 'learner left');
    });
  } catch {
    /* ignore */
  }
}

function convert(r: RawRow): TelemetryEvent {
  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(r.payload);
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  return {
    id: String(r.id),
    at: Number(r.at.toMillis()),
    source: r.source as NodeId,
    target: r.target as NodeId,
    kind: r.kind,
    label: r.label,
    payload,
  };
}

function deliver(s: Sub, r: RawRow): void {
  if (r.id <= s.maxId) return;
  s.maxId = r.id;
  try {
    s.cb(convert(r));
  } catch {
    /* subscriber errors never break the stream */
  }
}

function replay(s: Sub, c: DbConnection): void {
  try {
    const rows = [...c.db.telemetryEvent.iter()] as unknown as RawRow[];
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of rows) deliver(s, r);
  } catch {
    /* ignore */
  }
  s.live = true;
}

function scheduleRetry(): void {
  if (retryTimer || disabled) return;
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}


function lost(): void {
  conn = null;
  ready = false;
  applied = false;
  inflight = 0;
  subs.forEach((s) => {
    s.live = false;
  });
  scheduleRetry();
}

function connect(): void {
  if (disabled) return;
  const env = import.meta.env;
  const uri = env.VITE_SPACETIME_URI ?? DEFAULT_URI;
  const database = env.VITE_SPACETIME_DATABASE ?? DEFAULT_DB;
  try {
    let mine: DbConnection | null = null;
    mine = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withToken(readToken())
      .onConnect((c, _identity, token) => {
        if (mine !== c) return;
        saveToken(token);
        conn = c;
        ready = true;
        attempt = 0;
        startPresence();
        if (pending.length) {
          const now = Date.now();
          const queued = pending.splice(0);
          for (const q of queued) {
            if (now - q.at <= PENDING_MAX_AGE_MS) emit(q.source, q.target, q.kind, q.label, q.payload);
            else statFor(q.kind).dropped++;
          }
        }
        try {
          c.db.telemetryEvent.onInsert((_ctx, row) => {
            if (conn !== c) return;
            subs.forEach((s) => {
              if (s.live) deliver(s, row as unknown as RawRow);
            });
          });
          c.subscriptionBuilder()
            .onApplied(() => {
              if (conn !== c) return;
              applied = true;
              subs.forEach((s) => replay(s, c));
            })
            .onError((ctx) => {
              // leave connection up for emits; dashboard just gets no stream
              if (warnedSubscription) return;
              warnedSubscription = true;
              console.warn('telemetry subscription failed:', ctx?.event?.message ?? 'unknown error');
            })
            .subscribe('SELECT * FROM telemetry_event');
        } catch {
          /* ignore */
        }
      })
      .onConnectError(() => {
        if (mine && (conn === null || conn === mine)) lost();
      })
      .onDisconnect(() => {
        if (mine && (conn === null || conn === mine)) lost();
      })
      .build();
  } catch {
    lost();
  }
}

function ensureStarted(): void {
  if (disabled || started) return;
  started = true;
  connect();
}

/** Fire-and-forget; silently dropped when disconnected or when too many events are in flight. */
export function emit(
  source: NodeId,
  target: NodeId,
  kind: string,
  label: string,
  payload: Record<string, unknown> = {},
): void {
  if (disabled) return;
  try {
    ensureStarted();
    const st = statFor(kind);
    const c = conn;
    if (!c || !ready) {
      if (pending.length < PENDING_MAX) pending.push({ at: Date.now(), source, target, kind, label, payload: payload ?? {} });
      else st.dropped++;
      return;
    }
    if (inflight >= MAX_INFLIGHT) {
      st.dropped++;
      return;
    }
    const payloadJson = JSON.stringify({ ...(payload ?? {}), sid: (payload as Record<string, unknown> | undefined)?.sid ?? getSessionId() });
    inflight++;
    st.sent++;
    const done = () => {
      if (inflight > 0) inflight--;
    };
    c.reducers
      .emitTelemetry({ source, target, kind, label: label.slice(0, MAX_LABEL), payloadJson })
      .then(
        () => {
          done();
          st.accepted++;
        },
        (err: unknown) => {
          done();
          st.rejected++;
          st.lastError = err instanceof Error ? err.message : String(err);
          if (!warnedKinds.has(kind)) {
            warnedKinds.add(kind);
            console.warn(`telemetry ${kind} rejected (payload ${byteLength(payloadJson)} bytes): ${st.lastError}`);
          }
        },
      );
  } catch {
    /* never throws */
  }
}

const lastAt = new Map<string, number>();

/** Like emit, but at most once per `minMs` for the given key. */
export function throttledEmit(
  key: string,
  minMs: number,
  source: NodeId,
  target: NodeId,
  kind: string,
  label: string,
  payload: Record<string, unknown> = {},
): void {
  if (disabled) return;
  const now = performance.now();
  const prev = lastAt.get(key);
  if (prev !== undefined && now - prev < minMs) return;
  lastAt.set(key, now);
  emit(source, target, kind, label, payload);
}

/**
 * Replays existing rows (id ascending) once the subscription is applied, then forwards every
 * insert. Returns an unsubscribe function.
 */
export function subscribeTelemetry(cb: (e: TelemetryEvent) => void): () => void {
  const s: Sub = { cb, live: false, maxId: -1n };
  if (disabled) return () => {};
  try {
    subs.add(s);
    ensureStarted();
    if (conn && applied) replay(s, conn);
  } catch {
    /* ignore */
  }
  return () => {
    subs.delete(s);
  };
}
