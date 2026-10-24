import { useEffect, useRef, useState } from 'react';
import { Camera, Check } from 'lucide-react';

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

/* ---------- Lesson step tracker ---------- */
export const LESSON_STEPS = ['Choose', 'Try', 'Understand', 'Practice', 'Try independently'] as const;

export function LessonSteps({ current }: { current: number }) {
  return (
    <ol className="lesson-steps" aria-label="Lesson progress">
      {LESSON_STEPS.map((label, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <li key={label} className="lesson-step" aria-current={isCurrent ? 'step' : undefined}>
            <span className="lesson-step-dot">{done ? <Check size={11} strokeWidth={3} aria-label="done" /> : i + 1}</span>
            <span>{label}</span>
            {i < LESSON_STEPS.length - 1 && (
              <span className="lesson-step-arrow" aria-hidden="true">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Optional lip camera ---------- */
export function CameraTile({ enabled }: { enabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
        <video ref={videoRef} autoPlay muted playsInline />
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
    </div>
  );
}

/* ---------- Decorative sound contours (replaces a raster illustration) ---------- */
export function SoundContours({ width = 240, height = 110 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 240 110" fill="none" aria-hidden="true">
      <path d="M2 55 C 40 55, 60 8, 120 8 S 200 55, 238 55" stroke="#cbd7e6" strokeWidth="1.4" />
      <path d="M2 55 C 40 55, 60 102, 120 102 S 200 55, 238 55" stroke="#cbd7e6" strokeWidth="1.4" />
      <path d="M2 55 C 50 40, 80 30, 120 55 S 190 70, 238 55" stroke="#cbd7e6" strokeWidth="1.4" opacity="0.8" />
      <path d="M2 55 C 50 70, 80 80, 120 55 S 190 40, 238 55" stroke="#cbd7e6" strokeWidth="1.4" opacity="0.8" />
    </svg>
  );
}
