import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, Check, VideoOff } from 'lucide-react';
import type { SoundId } from '../state/types';
import { SOUNDS } from '../state/types';
import { Badge, Caption } from './ui';

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

/* ---------- Sound panel ---------- */
export function SoundPanel({ title, badge, footer }: { title: string; badge: ReactNode; footer: ReactNode }) {
  return (
    <section className="card" aria-label="Your sound">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {badge}
      </div>
      {footer}
    </section>
  );
}

/* ---------- Reference panel ---------- */
export function ReferencePanel({ sound, status }: { sound: SoundId; status: string }) {
  const s = SOUNDS[sound];
  return (
    <section className="card" aria-label="Target reference">
      <div className="card-head">
        <h2 className="card-title">Target reference</h2>
        <Badge tone="neutral">{status}</Badge>
      </div>
      <VowelGlyph sound={sound} size="lg" />
      <div className="stack gap-4">
        <p className="navy strong" style={{ fontSize: 12 }}>
          {s.tongue}
        </p>
        <p className="fine" style={{ fontSize: 12 }}>
          {s.lips}
        </p>
      </div>
      <Caption>
        “{s.spelled}” · {s.cue}
      </Caption>
    </section>
  );
}

/* ---------- Optional lip camera ---------- */
export function CameraTile({ enabled, compact }: { enabled: boolean; compact?: boolean }) {
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

  if (compact) {
    return (
      <div className="inset-tile stack gap-4" style={{ padding: 10, width: 160, flexShrink: 0 }}>
        {enabled && !error ? (
          <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', borderRadius: 4, transform: 'scaleX(-1)' }} />
        ) : (
          <span className="row fine" style={{ gap: 6 }}>
            <VideoOff size={15} aria-hidden="true" /> Lip camera off
          </span>
        )}
        <span className="navy" style={{ fontSize: 12 }}>
          {enabled ? 'Visible lips only' : 'Enable with consent'}
        </span>
      </div>
    );
  }

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

/* ---------- Small vowel glyph tile (replaces mouth photos in compact spots) ---------- */
export function VowelGlyph({ sound, size = 'md' }: { sound: SoundId; size?: 'md' | 'lg' }) {
  const s = SOUNDS[sound];
  return (
    <div
      className="stack gap-8"
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        background: 'var(--color-cream)',
        borderRadius: 6,
        padding: size === 'lg' ? 26 : 22,
      }}
    >
      <p className="serif navy" style={{ fontSize: size === 'lg' ? 56 : 48, lineHeight: 1 }}>
        {s.ipa}
      </p>
      <p className="ink" style={{ fontSize: 20 }}>
        {s.spelled} · as in {s.example}
      </p>
    </div>
  );
}
