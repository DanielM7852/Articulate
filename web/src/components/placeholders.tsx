/**
 * Visual placeholders for the two pieces still to be built:
 *
 *   1. VowelGraphPlaceholder     - the live F1/F2 cursor graph
 *   2. ReferenceModelPlaceholder - the rotatable 3D mouth reference
 *
 * They show the intended layout with static marks only. Replace each with the
 * real component; the props are the contract the practice screen already passes.
 */
import { Box } from 'lucide-react';
import type { SoundId } from '../state/types';
import { SOUNDS, SOUND_ORDER } from '../state/types';

export type RefView = 'front' | 'side' | 'cutaway';

/** Rough target positions (percent of plot). F2 decreases left to right, F1 increases top to bottom. */
const TARGETS: Record<SoundId, { x: number; y: number }> = {
  i: { x: 18, y: 22 },
  u: { x: 82, y: 22 },
  a: { x: 55, y: 80 },
};

export function VowelGraphPlaceholder({
  sound,
  hidden,
  height = 270,
}: {
  sound: SoundId;
  hidden?: boolean;
  height?: number | string;
}) {
  if (hidden) {
    return (
      <div className="slot" style={{ height }}>
        <p className="small">Cursor, target, and hold ring are hidden for this attempt.</p>
      </div>
    );
  }
  const t = TARGETS[sound];
  // Static demo cursor and trail drifting toward the target.
  const trail = [
    { x: t.x + 16, y: t.y + 20 },
    { x: t.x + 11, y: t.y + 13 },
    { x: t.x + 7, y: t.y + 8 },
    { x: t.x + 4, y: t.y + 4 },
  ].map((p) => ({ x: Math.min(95, Math.max(5, p.x)), y: Math.min(95, Math.max(5, p.y)) }));
  const cursor = trail[trail.length - 1];

  return (
    <div className="slot slot--graph" style={{ height }} data-slot="vowel-graph">
      <div className="slot-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[25, 50, 75].map((g) => (
          <g key={g}>
            <line x1={g} y1={0} x2={g} y2={100} className="plot-grid" />
            <line x1={0} y1={g} x2={100} y2={g} className="plot-grid" />
          </g>
        ))}
        <polygon
          points={SOUND_ORDER.map((id) => `${TARGETS[id].x},${TARGETS[id].y}`).join(' ')}
          className="plot-space"
        />
        <ellipse cx={t.x} cy={t.y} rx={11} ry={13} className="plot-target" />
        <polyline points={trail.map((p) => `${p.x},${p.y}`).join(' ')} className="plot-trail" />
      </svg>
      {SOUND_ORDER.map((id) => (
        <span
          key={id}
          className={`plot-label ${id === sound ? 'plot-label--active' : ''}`}
          style={{ left: `${TARGETS[id].x}%`, top: `${TARGETS[id].y}%` }}
        >
          {SOUNDS[id].ipa}
        </span>
      ))}
      <span className="plot-cursor" style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }} aria-hidden="true" />
      </div>
      <span className="plot-axis plot-axis--x">← higher F2 · lower F2 →</span>
      <span className="plot-axis plot-axis--y">F1 ↓</span>
      <span className="badge badge--neutral plot-badge">Placeholder · live graph coming soon</span>
    </div>
  );
}

export function ReferenceModelPlaceholder({ sound, view }: { sound: SoundId; view: RefView }) {
  return (
    <div className="slot" style={{ height: '100%', borderRadius: 6 }} data-slot="reference-model">
      <Box size={22} aria-hidden="true" color="var(--color-navy)" />
      <p className="small ink strong">3D mouth reference</p>
      <p className="fine" style={{ maxWidth: 320 }}>
        Placeholder · the rotatable model for {SOUNDS[sound].ipa} ({view} view) is coming soon.
      </p>
    </div>
  );
}
