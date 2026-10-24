import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LipFrame } from './lipTelemetry';

export type { LipFrame } from './lipTelemetry';
export type LipTrackingStatus = 'off' | 'loading' | 'tracking' | 'no-face' | 'error';

export interface LipTracking {
  status: LipTrackingStatus;
  error: string | null;
  latest: LipFrame | null;
  subscribe(fn: (f: LipFrame) => void): () => void;
  beginWindow(): void;
  endWindow(): LipFrame[];
}

const POLL_MS = 70; // ~14 Hz
const STATE_MS = 200; // React state updates <= 5 Hz
const WINDOW_CAP = 600;
const BASE = import.meta.env.BASE_URL;

export function useLipTracking(video: HTMLVideoElement | null, enabled: boolean): LipTracking {
  const [status, setStatus] = useState<LipTrackingStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<LipFrame | null>(null);
  const subs = useRef(new Set<(f: LipFrame) => void>());
  const windowRef = useRef<LipFrame[] | null>(null);

  useEffect(() => {
    if (!enabled || !video) {
      setStatus('off');
      setError(null);
      setLatest(null);
      return;
    }
    let stopped = false;
    let ready = false;
    let inFlight = false;
    let lastState = 0;
    let lastStatus: LipTrackingStatus = 'loading';
    setStatus('loading');
    setError(null);

    const worker = new Worker(new URL('./lip.worker.ts', import.meta.url), { type: 'module' });
    const fail = (msg: string) => {
      if (stopped) return;
      ready = false;
      lastStatus = 'error';
      setStatus('error');
      setError(msg);
    };
    worker.onerror = (e) => fail(e.message || 'Lip tracking worker failed');
    worker.onmessage = (ev: MessageEvent) => {
      if (stopped) return;
      const d = ev.data;
      if (d.type === 'ready') {
        ready = true;
        lastStatus = 'no-face';
        setStatus('no-face');
      } else if (d.type === 'error') {
        inFlight = false;
        if (!ready) fail(d.detail || 'Lip tracking failed to load');
      } else if (d.type === 'frame') {
        inFlight = false;
        const f: LipFrame = d.frame;
        const w = windowRef.current;
        if (w) {
          w.push(f);
          if (w.length > WINDOW_CAP) w.shift();
        }
        subs.current.forEach((fn) => fn(f));
        const next: LipTrackingStatus = f.flags.includes('missing_face') ? 'no-face' : 'tracking';
        if (next !== lastStatus) {
          lastStatus = next;
          setStatus(next);
        }
        const now = performance.now();
        if (now - lastState >= STATE_MS) {
          lastState = now;
          setLatest(f);
        }
      }
    };

    const origin = new URL(BASE, window.location.href).href;
    worker.postMessage({
      type: 'init',
      wasmBase: new URL('mediapipe/wasm', origin).href,
      modelPath: new URL('mediapipe/face_landmarker.task', origin).href,
    });

    const timer = window.setInterval(async () => {
      if (stopped || !ready || inFlight) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      inFlight = true;
      const t = performance.now();
      try {
        const bitmap = await createImageBitmap(video);
        if (stopped) {
          bitmap.close();
          return;
        }
        worker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
      } catch {
        inFlight = false;
      }
    }, POLL_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      worker.terminate();
      setStatus('off');
      setLatest(null);
    };
  }, [video, enabled]);

  const subscribe = useCallback((fn: (f: LipFrame) => void) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);
  const beginWindow = useCallback(() => {
    windowRef.current = [];
  }, []);
  const endWindow = useCallback(() => {
    const w = windowRef.current ?? [];
    windowRef.current = null;
    return w;
  }, []);

  return useMemo(
    () => ({ status, error, latest, subscribe, beginWindow, endWindow }),
    [status, error, latest, subscribe, beginWindow, endWindow],
  );
}
