import { useCallback, useEffect, useRef, useState } from 'react';
import { createMicrophoneSession, type MicrophoneSession } from '@vowel-mapper/audio/capture';
import type { TrackedFrame, VowelPoint } from '@vowel-mapper/audio/tracker';
import { inTarget, type VowelTarget } from '../vowel/targets';

/**
 * Live F1/F2 tracking on a microphone stream the caller already owns.
 *
 * The engine is the vowel-mapper workstream (AudioWorklet capture, a Worker running
 * Burg LPC, and a tracker that gates silence, noise, clipping and implausible
 * estimates). This hook only subscribes to it: it keeps a short trace for the
 * graph, measures the current steady hold inside the target region for the hold
 * ring, and, between `beginWindow` and `endWindow`, totals time in target and the
 * longest hold for the attempt summary. Those are acoustic orientation measures,
 * not a pronunciation score.
 */
export type TrackingStatus = TrackedFrame['status'] | 'off' | 'starting' | 'paused' | 'error';

export interface TargetSummary {
  timeInTargetSec: number;
  longestHoldSec: number;
}

interface TrackingState {
  point: VowelPoint | null;
  trace: VowelPoint[];
  status: TrackingStatus;
  /** Seconds of the current uninterrupted hold inside the target region. */
  holdSec: number;
}

const TRACE_MS = 6000;
const TRACE_MAX = 240;
/** Frames can drop while the tracker re-acquires; a gap this short does not break a hold. */
const HOLD_GAP_MS = 180;
const STALE_MS = 400;
const OFF: TrackingState = { point: null, trace: [], status: 'off', holdSec: 0 };

export function useVowelTracking(stream: MediaStream | null, target: VowelTarget) {
  const [state, setState] = useState<TrackingState>(OFF);
  const targetRef = useRef(target);
  const hold = useRef({ sec: 0, lastInMs: -Infinity, lastMs: 0 });
  const window = useRef({ open: false, inTarget: 0, longest: 0, frames: 0 });
  const lastFrameAt = useRef(0);
  const subs = useRef(new Set<(f: TrackedFrame) => void>());

  // A new target resets the hold; a hold on /i/ says nothing about /u/.
  useEffect(() => {
    targetRef.current = target;
    hold.current = { sec: 0, lastInMs: -Infinity, lastMs: 0 };
    setState((s) => (s.holdSec ? { ...s, holdSec: 0 } : s));
  }, [target]);

  const onFrame = useCallback((frame: TrackedFrame) => {
    lastFrameAt.current = performance.now();
    subs.current.forEach((fn) => {
      try {
        fn(frame);
      } catch {
        /* subscriber errors never break tracking */
      }
    });
    const now = frame.timestampMs;
    const h = hold.current;
    const dt = h.lastMs ? Math.min(100, Math.max(0, now - h.lastMs)) / 1000 : 0;
    h.lastMs = now;
    const inside = frame.point !== null && inTarget(frame.point, targetRef.current);
    if (inside) {
      h.sec = now - h.lastInMs > HOLD_GAP_MS ? 0 : h.sec + dt;
      h.lastInMs = now;
    } else if (now - h.lastInMs > HOLD_GAP_MS) {
      h.sec = 0;
    }
    const w = window.current;
    if (w.open) {
      w.frames++;
      if (inside) {
        w.inTarget += dt;
        w.longest = Math.max(w.longest, h.sec);
      }
    }
    setState((prev) => {
      const last = prev.trace[prev.trace.length - 1];
      const append = frame.point && (!last || frame.point.timestampMs - last.timestampMs >= 50);
      const trace = append
        ? [...prev.trace.filter((p) => p.timestampMs >= now - TRACE_MS).slice(-(TRACE_MAX - 1)), frame.point!]
        : prev.trace;
      return { point: frame.point ?? prev.point, trace, status: frame.status, holdSec: h.sec };
    });
  }, []);

  useEffect(() => {
    if (!stream) {
      hold.current = { sec: 0, lastInMs: -Infinity, lastMs: 0 };
      setState(OFF);
      return;
    }
    let session: MicrophoneSession | null = null;
    let cancelled = false;
    const controller = new AbortController();
    setState((s) => ({ ...s, status: 'starting' }));
    createMicrophoneSession({
      stream,
      signal: controller.signal,
      onFrame,
      onError: () => setState((s) => ({ ...s, status: 'error' })),
    })
      .then((s) => {
        if (cancelled) s.stop();
        else session = s;
      })
      .catch((err: unknown) => {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setState((s) => ({ ...s, status: 'error' }));
        }
      });
    const stale = setInterval(() => {
      if (performance.now() - lastFrameAt.current <= STALE_MS) return;
      setState((s) => (s.status === 'starting' || s.status === 'error' || s.status === 'paused' ? s : { ...s, status: 'paused' }));
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      session?.stop();
      clearInterval(stale);
    };
  }, [stream, onFrame]);

  /** Per-frame subscription for recorders; frames arrive at the engine's rate, outside React state. */
  const subscribe = useCallback((fn: (f: TrackedFrame) => void) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);

  const beginWindow = useCallback(() => {
    window.current = { open: true, inTarget: 0, longest: 0, frames: 0 };
  }, []);

  /** Null when tracking never ran during the window, so the attempt keeps `null` rather than a false zero. */
  const endWindow = useCallback((): TargetSummary | null => {
    const w = window.current;
    window.current = { ...w, open: false };
    if (!w.frames) return null;
    return {
      timeInTargetSec: Math.round(w.inTarget * 10) / 10,
      longestHoldSec: Math.round(w.longest * 10) / 10,
    };
  }, []);

  return { ...state, tracking: state.status === 'tracking', subscribe, beginWindow, endWindow };
}

export type VowelTracking = ReturnType<typeof useVowelTracking>;
