import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LipFrame } from './lipTelemetry';
import { emit, throttledEmit } from '../telemetry/client';

export type { LipFrame } from './lipTelemetry';
/** 'warming': the worker is ready but MediaPipe has not returned its first result yet (can take 6 to 16 s). */
export type LipTrackingStatus = 'off' | 'loading' | 'warming' | 'tracking' | 'no-face' | 'error';

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
/** The deployed emit_telemetry reducer caps payload_json at 2048 bytes; keep a margin. */
const MAX_PAYLOAD_BYTES = 2000;
const SID_BYTES = 20;
let warnedMeshSize = false;

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
    emit('camera', 'mediapipe', 'camera.on', 'camera tracking started', {});
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
        lastStatus = 'warming';
        setStatus('warming');
      } else if (d.type === 'error') {
        inFlight = false;
        if (!ready) fail(d.detail || 'Lip tracking failed to load');
        else if (lastStatus === 'warming') {
          // a failed detect is still the first result: leave the warm-up state
          lastStatus = 'no-face';
          setStatus('no-face');
        }
      } else if (d.type === 'frame') {
        inFlight = false;
        const f: LipFrame = d.frame;
        const w = windowRef.current;
        if (w) {
          w.push(f);
          if (w.length > WINDOW_CAP) w.shift();
        }
        subs.current.forEach((fn) => fn(f));
        const mesh: number[] | undefined = d.mesh;
        const packed: { v: 3; n: number; pts: string } | undefined = d.meshPacked;
        const r1 = (n: number) => Math.round(n * 10) / 10;
        const meshPayload: Record<string, unknown> | null = packed
          ? { v: 3, n: packed.n, pts: packed.pts, yaw: r1(f.yawDeg), pitch: r1(f.pitchDeg), roll: r1(f.rollDeg) }
          : mesh
            ? { pts: mesh }
            : null;
        if (meshPayload) {
          // emit() appends the session id (`,"sid":"xxxxxxxx"`, 17 bytes). The payload is ASCII, so length = bytes.
          if (JSON.stringify(meshPayload).length + SID_BYTES > MAX_PAYLOAD_BYTES) {
            if (!warnedMeshSize) {
              warnedMeshSize = true;
              console.debug('lip.mesh payload exceeds the telemetry cap; dropping');
            }
          } else {
            throttledEmit('lip.mesh', 100, 'mediapipe', 'db', 'lip.mesh', 'face mesh', meshPayload);
          }
        }
        throttledEmit('lip.frame', 200, 'mediapipe', 'db', 'lip.frame', 'lip frame', {
          ok: f.ok,
          opening: f.lipOpening,
          width: f.lipWidth,
          rounding: f.rounding,
          spread: f.spread,
          jaw: f.jawDrop,
          yaw: f.yawDeg,
        });
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
      emit('camera', 'mediapipe', 'camera.off', 'camera tracking stopped', {});
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
