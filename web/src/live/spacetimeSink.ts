import { DbConnection } from '../module_bindings';
import type { SoundId } from '../state/types';
import type { MetricSink } from './metricSink';

/**
 * MetricSink backed by the SpacetimeDB TypeScript client SDK (module `articulate-live`).
 * Tables are private, so this only calls reducers; each call returns a Promise<void> that
 * rejects when the reducer errors or the connection drops, which is how outcomes are awaited.
 * Anonymous identity only: the token the server issues is kept in localStorage.
 */
export type SinkStatus = 'connecting' | 'ready' | 'offline' | 'error';

export interface SpacetimeSink extends MetricSink {
  readonly status: SinkStatus;
  close(): void;
}

export interface SpacetimeSinkOptions {
  profileId: string;
  displayName: string;
  uri?: string;
  database?: string;
  /** Called whenever status changes (for UI indicators). */
  onStatus?: (status: SinkStatus) => void;
}

const TOKEN_KEY = 'articulate.stdb.token';
const DEFAULT_URI = 'wss://maincloud.spacetimedb.com';
const DEFAULT_DB = 'articulate-live';
const TIMEOUT_MS = 3000;
const MAX_FRAMES = 200;
const MAX_BYTES = 32768;
const RECONNECT_DELAY_MS = 2000;

function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable; identity is just not remembered */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createSpacetimeSink(opts: SpacetimeSinkOptions): SpacetimeSink {
  const env = import.meta.env;
  const uri = opts.uri ?? env.VITE_SPACETIME_URI ?? DEFAULT_URI;
  const database = opts.database ?? env.VITE_SPACETIME_DATABASE ?? DEFAULT_DB;

  let status: SinkStatus = 'connecting';
  let conn: DbConnection | null = null;
  let closed = false;
  let retriesLeft = 1;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let warnedSize = false;

  let current: { id: string; failed: boolean; inflight: Set<Promise<void>> } | null = null;

  const setStatus = (s: SinkStatus) => {
    if (status === s) return;
    status = s;
    opts.onStatus?.(s);
  };

  const dropped = (s: 'offline' | 'error') => {
    if (closed) return;
    conn = null;
    setStatus(s);
    if (current) current.failed = true;
    if (retriesLeft > 0) {
      retriesLeft--;
      retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  };

  function connect(): void {
    if (closed) return;
    retryTimer = null;
    setStatus('connecting');
    let mine: DbConnection | null = null;
    try {
      mine = DbConnection.builder()
        .withUri(uri)
        .withDatabaseName(database)
        .withToken(readToken())
        .onConnect((c, _identity, token) => {
          if (closed || mine !== c) return;
          saveToken(token);
          c.reducers
            .registerLearner({ profileId: opts.profileId, displayName: opts.displayName })
            .then(() => {
              if (closed || mine !== c) return;
              conn = c;
              retriesLeft = 1;
              setStatus('ready');
            })
            .catch(() => {
              if (mine === c) dropped('error');
            });
        })
        .onConnectError(() => {
          if (mine) dropped('error');
        })
        .onDisconnect(() => {
          if (mine) dropped('offline');
        })
        .build();
    } catch {
      dropped('error');
    }
  }

  connect();

  const track = (p: Promise<void>): void => {
    const a = current;
    if (!a) return;
    const tracked: Promise<void> = p
      .catch(() => {
        a.failed = true;
      })
      .finally(() => {
        a.inflight.delete(tracked);
      });
    a.inflight.add(tracked);
  };

  return {
    get connected() {
      return status === 'ready' && conn !== null;
    },
    get status() {
      return status;
    },

    async beginAttempt(attemptId: string, sound: SoundId): Promise<void> {
      if (!conn || status !== 'ready') throw new Error('SpacetimeDB not connected');
      current = { id: attemptId, failed: false, inflight: new Set() };
      try {
        await withTimeout(conn.reducers.beginAttempt({ attemptId, sound }), TIMEOUT_MS, 'begin_attempt');
      } catch (e) {
        if (current?.id === attemptId) current.failed = true;
        throw e;
      }
    },

    push(kind, seq, frames) {
      const a = current;
      if (!a || !conn || status !== 'ready') {
        if (a) a.failed = true;
        return;
      }
      let json = '';
      try {
        json = JSON.stringify(frames);
      } catch {
        a.failed = true;
        return;
      }
      if (frames.length < 1 || frames.length > MAX_FRAMES || new TextEncoder().encode(json).length > MAX_BYTES) {
        a.failed = true;
        if (!warnedSize) {
          warnedSize = true;
          console.warn('[spacetimeSink] batch exceeds push_metrics limits; sending this attempt inline');
        }
        return;
      }
      track(conn.reducers.pushMetrics({ attemptId: a.id, kind, seq, framesJson: json }));
    },

    async endAttempt(attemptId: string): Promise<boolean> {
      const a = current;
      if (!a || a.id !== attemptId) return false;
      try {
        await withTimeout(Promise.all([...a.inflight]), TIMEOUT_MS, 'pending pushes');
        if (a.failed || !conn || status !== 'ready') return false;
        await withTimeout(conn.reducers.endAttempt({ attemptId }), TIMEOUT_MS, 'end_attempt');
        return !a.failed && status === 'ready';
      } catch {
        return false;
      } finally {
        if (current === a) current = null;
      }
    },

    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const c = conn;
      conn = null;
      try {
        c?.disconnect();
      } catch {
        /* already closed */
      }
      setStatus('offline');
    },
  };
}
