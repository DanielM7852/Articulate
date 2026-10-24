import { useEffect, useRef, useState } from 'react';
import type { Look } from '../components/MouthReference';

/**
 * Where is the learner? Two sources for the guide's gaze:
 *
 * `useFaceTracking` opens the camera and runs MediaPipe's short-range face
 * detector on-device at a modest rate. Frames never leave the browser and are
 * never stored. `usePointerLook` follows the mouse or finger instead, used when
 * the camera is denied or unavailable, so the guide always has someone to look at.
 *
 * Both return a `Look` in the guide's convention: x from -1 (viewer's left) to
 * +1 (viewer's right), y from -1 (down) to +1 (up).
 */
export type FaceStatus = 'idle' | 'requesting' | 'loading' | 'tracking' | 'searching' | 'denied' | 'unavailable';

const MEDIAPIPE_VERSION = '1.1.1';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const DETECT_INTERVAL_MS = 66; // about 15 Hz is plenty for a gaze
const LOST_AFTER_MS = 900;
const SMOOTH = 0.35;

export function useFaceTracking(enabled: boolean) {
  const [status, setStatus] = useState<FaceStatus>('idle');
  const [look, setLook] = useState<Look | null>(null);
  const smooth = useRef<Look | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setLook(null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    let detector: Detector | null = null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;

    (async () => {
      setStatus('requesting');
      let acquired: MediaStream;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } });
      } catch {
        if (!cancelled) setStatus('denied');
        return;
      }
      if (cancelled) {
        // Cleanup ran while the permission prompt was open: release what we just got.
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setStatus('loading');
      let created: Detector;
      try {
        const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        created = await FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        });
      } catch {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      if (cancelled) {
        created.close();
        return;
      }
      detector = created;
      setStatus('searching');
      let lastSeen = 0;
      let lastTs = -1;
      const tick = () => {
        if (cancelled || !detector) return;
        timer = window.setTimeout(tick, DETECT_INTERVAL_MS);
        if (video.readyState < 2 || !video.videoWidth) return;
        const ts = performance.now();
        if (ts <= lastTs) return;
        lastTs = ts;
        const face = detector.detectForVideo(video, ts).detections[0];
        if (face?.boundingBox) {
          const b = face.boundingBox;
          const cx = (b.originX + b.width / 2) / video.videoWidth;
          const cy = (b.originY + b.height / 2) / video.videoHeight;
          // The camera faces the learner, so a learner on their own right appears on the
          // left of the unmirrored frame. Flip x so +x is the viewer's right, like the pointer.
          const target = { x: (0.5 - cx) * 2.4, y: (0.5 - cy) * 2.4 };
          const prev = smooth.current ?? target;
          const next = { x: prev.x + (target.x - prev.x) * SMOOTH, y: prev.y + (target.y - prev.y) * SMOOTH };
          smooth.current = next;
          lastSeen = ts;
          setLook({ x: clamp(next.x), y: clamp(next.y) });
          setStatus('tracking');
        } else if (ts - lastSeen > LOST_AFTER_MS) {
          smooth.current = null;
          setLook(null);
          setStatus('searching');
        }
      };
      tick();
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      detector?.close();
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [enabled]);

  return { status, look };
}

interface Detection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
}
/** The slice of MediaPipe's FaceDetector this hook uses. */
interface Detector {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { detections: Detection[] };
  close(): void;
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** Follows the pointer across the whole window. */
export function usePointerLook(enabled: boolean) {
  const [look, setLook] = useState<Look | null>(null);
  useEffect(() => {
    if (!enabled) {
      setLook(null);
      return;
    }
    const onMove = (e: PointerEvent) => {
      setLook({ x: clamp((e.clientX / window.innerWidth - 0.5) * 2), y: clamp((0.5 - e.clientY / window.innerHeight) * 2) });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [enabled]);
  return look;
}
