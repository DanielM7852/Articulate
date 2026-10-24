import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import type { LipTrackingStatus } from '../vision/useLipTracking';
import '../vision/lipStatus.css';

/* ---------- Amplitude meter (capture quality only) ---------- */
export function AmplitudeMeter({ levels, active }: { levels: number[]; active?: boolean }) {
  return (
    <div className={`meter ${active ? 'active' : ''}`} aria-hidden="true">
      {levels.map((l, i) => (
        <span key={i} style={{ height: Math.max(3, Math.min(36, l * 360)) }} />
      ))}
    </div>
  );
}

/* ---------- Lesson steps (the practice progress total) ---------- */
export const LESSON_STEPS = ['Choose', 'Try', 'Understand', 'Practice', 'Try independently'] as const;


/* ---------- Optional lip camera ---------- */
const LIP_STATUS_LABEL: Partial<Record<LipTrackingStatus, string>> = {
  loading: 'Loading lip tracking',
  tracking: 'Lip tracking on',
  'no-face': 'Face not found',
  error: 'Lip tracking unavailable',
};

export function CameraTile({
  enabled,
  onVideoElement,
  lipStatus,
}: {
  enabled: boolean;
  onVideoElement?: (el: HTMLVideoElement | null) => void;
  lipStatus?: LipTrackingStatus;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoRef = useRef(onVideoElement);
  onVideoRef.current = onVideoElement;
  const setVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    onVideoRef.current?.(el);
  }, []);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 440, height: 320, facingMode: 'user' } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setError(false);
      })
      .catch(() => setError(true));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled]);

  return (
    <div className="camera-tile" aria-label={enabled ? 'Lip camera preview' : 'Camera off'}>
      {enabled && !error ? (
        <video ref={setVideo} autoPlay muted playsInline />
      ) : (
        <div className="stack gap-8" style={{ alignItems: 'center' }}>
          <span
            style={{
              width: 78,
              height: 56,
              border: '2px solid var(--color-navy)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Camera size={24} aria-hidden="true" />
          </span>
          {error && <span className="fine">Camera unavailable</span>}
        </div>
      )}
      {enabled && !error && lipStatus && LIP_STATUS_LABEL[lipStatus] && (
        <span className="lip-status" data-state={lipStatus} role="status">
          {LIP_STATUS_LABEL[lipStatus]}
        </span>
      )}
    </div>
  );
}

