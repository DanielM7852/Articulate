import { useLayoutEffect, useRef, useState } from 'react';
import type { VowelPoint } from '@vowel-mapper/audio/tracker';
import { SOUNDS, SOUND_ORDER, type SoundId } from '../state/types';
import { HOLD_GOAL_SEC, TARGETS, inTarget, project, targetEllipse } from '../vowel/targets';

/**
 * Live F1/F2 graph: the learner's vowel as a cursor on the vowel space, a short
 * trail behind it, the active sound's target region, and a hold ring that fills
 * while the cursor rests inside the region. Display only: tracking happens in
 * `useVowelTracking`. The cursor is an HTML element moved with `transform` so it
 * stays round and composites cheaply; everything static is one SVG.
 */
export function VowelGraph({
  sound,
  point,
  trace,
  tracking,
  statusLabel,
  holdSec,
  hidden,
  emptyHint,
}: {
  sound: SoundId;
  point: VowelPoint | null;
  trace: VowelPoint[];
  /** True while the tracker is confidently following a vowel. */
  tracking: boolean;
  statusLabel: string;
  holdSec: number;
  /** Independent attempts hide the cursor, target and hold ring. */
  hidden?: boolean;
  /** Second line of the empty state; defaults to the recording hint. */
  emptyHint?: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);

  if (hidden) {
    return (
      <div className="vg vg--hidden" role="img" aria-label="Vowel graph hidden for this attempt">
        <p className="ob-fine">Cursor, target and hold ring are hidden for this attempt.</p>
      </div>
    );
  }

  const target = TARGETS[sound];
  const ellipse = targetEllipse(target);
  const cursor = point ? project(point) : null;
  const inside = point !== null && tracking && inTarget(point, target);
  const holdProgress = inside ? Math.min(1, holdSec / HOLD_GOAL_SEC) : 0;

  const segments = new Map<number, VowelPoint[]>();
  for (const p of trace) {
    const seg = segments.get(p.segment) ?? [];
    seg.push(p);
    segments.set(p.segment, seg);
  }

  return (
    <div
      className="vg"
      data-tracking={tracking}
      data-inside={inside}
      role="img"
      aria-label={`Vowel graph for ${SOUNDS[sound].spelled}. ${statusLabel}.${inside ? ' Inside the target region.' : ''}`}
    >
      <div className="vg-plot" ref={plotRef}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[25, 50, 75].map((g) => (
            <g key={g}>
              <line x1={g} y1={0} x2={g} y2={100} className="vg-grid" />
              <line x1={0} y1={g} x2={100} y2={g} className="vg-grid" />
            </g>
          ))}
          <polygon
            className="vg-space"
            points={SOUND_ORDER.map((id) => {
              const c = project(TARGETS[id]);
              return `${c.x},${c.y}`;
            }).join(' ')}
          />
          <ellipse className="vg-target" cx={ellipse.cx} cy={ellipse.cy} rx={ellipse.rx} ry={ellipse.ry} />
          {Array.from(segments, ([seg, pts]) => (
            <polyline
              key={seg}
              className="vg-trail"
              points={pts
                .map((p) => {
                  const c = project(p);
                  return `${c.x},${c.y}`;
                })
                .join(' ')}
            />
          ))}
        </svg>

        {SOUND_ORDER.map((id) => {
          const c = project(TARGETS[id]);
          return (
            <span
              key={id}
              className={`vg-label ${id === sound ? 'is-active' : ''}`}
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
              aria-hidden="true"
            >
              {SOUNDS[id].ipa}
            </span>
          );
        })}

        <div
          className={`vg-cursor ${cursor ? (tracking ? '' : 'is-faded') : 'is-hidden'}`}
          style={cursor ? { transform: `translate(${(cursor.x / 100) * size.w}px, ${(cursor.y / 100) * size.h}px)` } : undefined}
          aria-hidden="true"
        >
          <svg className="vg-ring" viewBox="0 0 44 44">
            <circle className="vg-ring-track" cx={22} cy={22} r={19} />
            <circle
              className="vg-ring-fill"
              cx={22}
              cy={22}
              r={19}
              pathLength={100}
              style={{ strokeDashoffset: 100 - holdProgress * 100, opacity: holdProgress > 0 ? 1 : 0 }}
            />
          </svg>
          <span className="vg-dot" />
        </div>

        <div className={`vg-empty ${cursor ? 'is-hidden' : ''}`} aria-hidden="true">
          <p className="ob-label">Your sound appears here</p>
          <p className="ob-fine">{emptyHint ?? `Record, then hold “${SOUNDS[sound].spelled}” steadily.`}</p>
        </div>
      </div>

      <span className="vg-axis vg-axis--x" aria-hidden="true">
        ← tongue forward · tongue back →
      </span>
      <span className="vg-axis vg-axis--y" aria-hidden="true">
        jaw open ↓
      </span>
      <span className="vg-status" aria-hidden="true">
        {statusLabel}
      </span>
    </div>
  );
}
