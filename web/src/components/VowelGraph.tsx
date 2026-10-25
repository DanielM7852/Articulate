import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { VowelPoint } from '@vowel-mapper/audio/tracker';
import { buildRibbons, buildTrail, sampleKey, trailHead, trailOpacity } from '@vowel-mapper/components/trail';
import { useTrailAnimation } from '@vowel-mapper/components/useTrailAnimation';
import { SOUNDS, SOUND_ORDER, type SoundId } from '../state/types';
import { HOLD_GOAL_SEC, inTarget, project, targetEllipse, type VowelTarget } from '../vowel/targets';

/** Ink widths in CSS pixels: a tapered comet tail while live, an even line otherwise. */
const INK_WIDTH = 5;
const STATIC_WIDTH = 2;

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
  live = false,
  emptyHint,
  targets,
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
  /** Ink fades over 3 s while true; false keeps the whole supplied trace at full strength. */
  live?: boolean;
  /** Second line of the empty state; defaults to the recording hint. */
  emptyHint?: string;
  /** The learner's three targets (see targetsFor): drawn, labelled and used for the hold. */
  targets: Record<SoundId, VowelTarget>;
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

  // Cosmetic only: the eased head, geometry and fade never feed tracking, targets or
  // scoring; `inside` and the hold ring below use the accepted point. Ink is built in
  // CSS pixels so the ribbon keeps an even width under the stretched plot.
  const { now, arrivals, headMs, reducedMotion } = useTrailAnimation(trace, point, live);
  const toPx = useCallback(
    (p: { f1: number; f2: number }) => {
      const c = project(p);
      return { x: (c.x / 100) * size.w, y: (c.y / 100) * size.h };
    },
    [size.w, size.h],
  );
  const geometry = useMemo(() => buildTrail(trace, point, !reducedMotion, toPx), [trace, point, reducedMotion, toPx]);
  const opacity = (sample: VowelPoint) => (live ? trailOpacity(now - (arrivals.get(sampleKey(sample)) ?? now)) : 1);
  const ribbons = buildRibbons(geometry, headMs, (sample) => (live ? INK_WIDTH * opacity(sample) : STATIC_WIDTH));

  if (hidden) {
    return (
      <div className="vg vg--hidden" role="img" aria-label="Vowel graph hidden for this attempt">
        <p className="ob-fine">Cursor, target and hold ring are hidden for this attempt.</p>
      </div>
    );
  }

  const target = targets[sound];
  const ellipse = targetEllipse(target);
  // Display position only: eased along the trail toward the accepted point, which it reaches when movement stops.
  const cursor = point ? (trailHead(geometry, headMs) ?? toPx(point)) : null;
  const inside = point !== null && tracking && inTarget(point, target);
  const holdProgress = inside ? Math.min(1, holdSec / HOLD_GOAL_SEC) : 0;

  const cursorStyle: CSSProperties | undefined = cursor
    ? {
        transform: `translate(${cursor.x}px, ${cursor.y}px)`,
        // Live: the cursor fades with its newest sample (and stays dimmed when not confidently tracking).
        ...(live ? { opacity: opacity(point!) * (tracking ? 1 : 0.3) } : {}),
      }
    : undefined;

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
              const c = project(targets[id]);
              return `${c.x},${c.y}`;
            }).join(' ')}
          />
          <ellipse className="vg-target" cx={ellipse.cx} cy={ellipse.cy} rx={ellipse.rx} ry={ellipse.ry} />
        </svg>
        {ribbons.length > 0 && size.w > 0 && size.h > 0 && (
          <svg className="vg-ink" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
            {ribbons.map((ribbon) => (
              <path key={ribbon.key} className={`vg-trail${live ? ' is-live' : ''}`} d={ribbon.d} />
            ))}
          </svg>
        )}

        {SOUND_ORDER.map((id) => {
          const c = project(targets[id]);
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
          style={cursorStyle}
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
