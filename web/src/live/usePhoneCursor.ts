import { useEffect, useRef, useState } from 'react';
import { connectPhoneStream, type Phone, type PhoneFrame, type PhoneStreamHandle, type StreamReason, type StreamState } from './phoneStream';
import { RESET_GUARD_MS, mergeHeard } from './phoneCursor';

/** A recognizer frame with a client-side sequence number (monotonic for the hook's lifetime, never reset). */
export interface SeqFrame extends PhoneFrame {
  n: number;
}
/** Newest frames kept (a cursor only reads the newest). */
const MAX_FRAMES = 60;

/** What the ghost board needs to drive its cursor from the phone recognizer. */
export interface PhoneCursorInput {
  state: StreamState;
  /** Why the stream is not usable (set with 'closed'/'error' on connection problems); undefined otherwise. */
  reason?: StreamReason;
  /** Committed + provisional phones in order, in stream time since the last reset. */
  phones: Phone[];
  /** The newest recognizer frames since the last reset, oldest first; empty when the server sends none. */
  frames: SeqFrame[];
  /** performance.now() of the last stream reset (0 = never). The board clears its cursor when this changes. */
  resetAt: number;
}

const OFFLINE: PhoneCursorInput = { state: 'closed', phones: [], frames: [], resetAt: 0 };

/**
 * Connects the phone stream while `enabled` (a phone-judged word, mic ready) and exposes the latest phones.
 * `resetKey` is the live attempt id (null when not live): a new non-null key resets the stream so only that attempt's
 * sounds count. Updates in the first RESET_GUARD_MS after a reset are dropped (could be in flight from before it).
 */
export function usePhoneCursor(stream: MediaStream | null, enabled: boolean, resetKey: string | null): PhoneCursorInput {
  const [out, setOut] = useState<PhoneCursorInput>(OFFLINE);
  const handle = useRef<PhoneStreamHandle | null>(null);
  const resetAt = useRef(0);
  const lastKey = useRef<string | null>(null);
  const frameN = useRef(0);

  useEffect(() => {
    if (!stream || !enabled) {
      setOut(OFFLINE);
      return;
    }
    setOut({ state: 'connecting', phones: [], frames: [], resetAt: resetAt.current });
    let h: PhoneStreamHandle | null = null;
    try {
      h = connectPhoneStream(stream, {
        onState: (s, info) => setOut((o) => ({ ...o, state: s, reason: s === 'closed' || s === 'error' ? info?.reason : undefined, phones: s === 'ready' ? o.phones : [], frames: s === 'ready' ? o.frames : [] })),
        onPhones: (u) => {
          if (performance.now() - resetAt.current < RESET_GUARD_MS) return;
          const fresh: SeqFrame[] = u.frames.map((f) => ({ ...f, n: ++frameN.current }));
          setOut((o) => ({
            ...o,
            phones: mergeHeard(u.committed, u.provisional),
            frames: fresh.length ? [...o.frames, ...fresh].slice(-MAX_FRAMES) : o.frames,
          }));
        },
      });
    } catch {
      setOut({ state: 'error', reason: 'unreachable', phones: [], frames: [], resetAt: 0 });
    }
    handle.current = h;
    return () => {
      h?.close();
      if (handle.current === h) handle.current = null;
    };
  }, [stream, enabled]);

  useEffect(() => {
    if (resetKey === null || resetKey === lastKey.current) return;
    lastKey.current = resetKey;
    resetAt.current = performance.now();
    handle.current?.reset();
    setOut((o) => ({ ...o, phones: [], frames: [], resetAt: resetAt.current }));
  }, [resetKey, enabled]);

  return out;
}
