import { useEffect, useMemo, useRef, useState } from 'react';
import { connectPhoneStream, type Phone, type PhoneStreamHandle, type PhoneUpdate, type StreamInfo, type StreamState } from '../live/phoneStream';
import '../styles/phone-strip.css';

const DEFAULT_TARGETS = ['t', 'ɹ', 'æ', 'k'];
const VISIBLE = 14;

/** r and ɹ are the same target; everything else compares as-is. */
function norm(p: string): string {
  return p === 'r' ? 'ɹ' : p;
}

export interface PhoneStripProps {
  stream: MediaStream | null;
  active?: boolean;
  targets?: string[];
  /** Changing this value sends a reset to the service and clears the strip and checklist. */
  resetKey?: unknown;
  onPhones?(committed: Phone[]): void;
  /** Override the service URL (defaults to VITE_PHONES_WS, then ws://127.0.0.1:8020/ws/phones). */
  url?: string;
}

export function PhoneStrip({ stream, active = true, targets = DEFAULT_TARGETS, resetKey, onPhones, url }: PhoneStripProps) {
  const [state, setState] = useState<StreamState>('connecting');
  const [info, setInfo] = useState<StreamInfo>({});
  const [committed, setCommitted] = useState<Phone[]>([]);
  const [provisional, setProvisional] = useState<Phone[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [inferMs, setInferMs] = useState<number | undefined>();
  const handle = useRef<PhoneStreamHandle | null>(null);
  const onPhonesRef = useRef(onPhones);
  onPhonesRef.current = onPhones;
  const debug = useMemo(() => {
    try {
      return new URLSearchParams(location.search).has('debug');
    } catch {
      return false;
    }
  }, []);
  const targetSet = useMemo(() => new Set(targets.map(norm)), [targets]);
  const targetRef = useRef(targetSet);
  targetRef.current = targetSet;

  useEffect(() => {
    if (!stream || !active) {
      setState('closed');
      return;
    }
    let h: PhoneStreamHandle | null = null;
    try {
      h = connectPhoneStream(stream, {
        url,
        onState: (s, i) => {
          setState(s);
          if (i) setInfo((prev) => ({ ...prev, ...i }));
        },
        onPhones: (u: PhoneUpdate) => {
          setCommitted(u.committed);
          setProvisional(u.provisional);
          setInferMs(u.inferMs);
          const hits = u.committed.map((c) => norm(c.p)).filter((p) => targetRef.current.has(p));
          if (hits.length) {
            setSeen((prev) => {
              if (hits.every((p) => prev.has(p))) return prev;
              return new Set([...prev, ...hits]);
            });
          }
          onPhonesRef.current?.(u.committed);
        },
      });
    } catch {
      setState('error');
    }
    handle.current = h;
    return () => {
      h?.close();
      if (handle.current === h) handle.current = null;
    };
  }, [stream, active, url]);

  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    handle.current?.reset();
    setCommitted([]);
    setProvisional([]);
    setSeen(new Set());
  }, [resetKey]);

  const offline = state === 'closed' || state === 'error';
  const statusText = !stream || !active ? 'Live sounds paused' : state === 'ready' ? `Live${info.engine ? ` · ${info.engine}` : ''}` : offline ? 'Live sounds offline' : 'Connecting…';
  const statusClass = state === 'ready' && stream && active ? 'is-live' : offline || !stream || !active ? 'is-off' : 'is-wait';

  const items = [
    ...committed.map((p, i) => ({ p, prov: false, key: `c${p.startMs}${p.p}${i}` })),
    ...provisional.map((p, i) => ({ p, prov: true, key: `p${i}${p.p}` })),
  ].slice(-VISIBLE);

  return (
    <section className="ps" aria-label="Live sounds heard">
      <div className="ps-head">
        <span className={`ps-status ${statusClass}`} role="status">
          <span className="ps-dot" aria-hidden="true" />
          {statusText}
        </span>
        <ul className="ps-checks" aria-label="Target sounds">
          {targets.map((t) => {
            const done = seen.has(norm(t));
            return (
              <li key={t} className={done ? 'is-done' : ''}>
                <span className="ps-check-sym">{t}</span>
                <span className="ps-check-mark" aria-hidden="true">
                  {done ? '✓' : '○'}
                </span>
                <span className="ps-sr">{done ? 'heard' : 'not yet heard'}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {offline || !stream || !active ? null : (
        <div className="ps-strip" aria-live="off">
          {items.length === 0 ? (
            <span className="ps-empty">{state === 'ready' ? 'Say a word to see its sounds' : ''}</span>
          ) : (
            items.map(({ p, prov, key }) => {
              const hit = targetSet.has(norm(p.p));
              return (
                <span key={key} className={`ps-chip${prov ? ' is-prov' : ''}${hit ? ' is-target' : ''}`} title={`${p.p} ${Math.round(p.conf * 100)}%`}>
                  {hit ? <span className="ps-marker" aria-hidden="true">◆</span> : null}
                  {p.p}
                </span>
              );
            })
          )}
        </div>
      )}
      {debug && state === 'ready' ? (
        <p className="ps-debug">
          engine {info.engine ?? '?'} · model {info.model ?? '?'} · inferMs {inferMs ?? '–'}
        </p>
      ) : null}
    </section>
  );
}
