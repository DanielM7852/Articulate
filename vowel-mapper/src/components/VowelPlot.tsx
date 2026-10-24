import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VowelPoint } from '../audio/tracker';
import { PLOT, projectVowel } from './plot';
import { buildRibbons, buildTrail, sampleKey, trailHead, trailOpacity } from './trail';
import { useTrailAnimation } from './useTrailAnimation';

/** Ribbon widths in plot units: a tapered comet while live, an even line once finished. */
const INK_WIDTH = 6;
const STATIC_WIDTH = 3.5;

export interface VowelPlotProps {
  trace: VowelPoint[];
  point: VowelPoint | null;
  faded: boolean;
  /** Live ink evaporates; false preserves the complete supplied trace on Finish. */
  live?: boolean;
  /**
   * Optional SVG drawn in plot coordinates (use `projectVowel`), under the trail and cursor.
   * A function receives the label scale that keeps text at its CSS-pixel size.
   */
  overlay?: ReactNode | ((textScale: number) => ReactNode);
}

/** Display-only component: owns neither a microphone nor session controls. */
export function VowelPlot({ trace, point, faded, live = false, overlay }: VowelPlotProps) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Compensate for the SVG viewBox so labels retain their CSS-pixel size.
  const textScale = Math.max(1, 800 / Math.max(1, width));
  // Cosmetic only: the eased head and the ink never feed tracking; data-f1/f2 stay the accepted point.
  const { now, arrivals, headMs, reducedMotion } = useTrailAnimation(trace, point, live);
  const geometry = useMemo(() => buildTrail(trace, point, !reducedMotion), [trace, point, reducedMotion]);
  const opacity = (sample: VowelPoint) => live ? trailOpacity(now - (arrivals.get(sampleKey(sample)) ?? now)) : 1;
  const ribbons = buildRibbons(geometry, headMs, (sample) => live ? INK_WIDTH * opacity(sample) : STATIC_WIDTH);
  const cursor = point ? trailHead(geometry, headMs) ?? projectVowel(point) : null;
  const cursorOpacity = point ? opacity(point) * (faded ? 0.2 : 1) : 0;
  return (
    <div className="plot-wrap" ref={container}>
      <div className="vertical-guide">↑ Tongue higher · jaw more closed</div>
      <svg className="vowel-plot" viewBox="0 25 800 460" role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>Live vowel space</title>
        <desc id={`${id}-description`}>F2 increases to the left. F1 increases downward. The dot shows the most recent reliable acoustic estimate. Tongue and jaw labels are approximate orientation guides.</desc>
        <defs>
          <pattern id={`${id}-grid`} width="52" height="34" patternUnits="userSpaceOnUse" x={PLOT.left} y={PLOT.top}>
            <circle cx="0.8" cy="0.8" r="0.8" fill="#cad6e8" />
          </pattern>
          <clipPath id={`${id}-clip`}>
            <rect x={PLOT.left} y={PLOT.top} width={PLOT.width} height={PLOT.height} rx="16" />
          </clipPath>
        </defs>
        <rect x={PLOT.left} y={PLOT.top} width={PLOT.width} height={PLOT.height} rx="16" fill="#f6f9ff" stroke="#dbe4f0" />
        <rect x={PLOT.left} y={PLOT.top} width={PLOT.width} height={PLOT.height} rx="16" fill={`url(#${id}-grid)`} />
        {[300, 600, 900, 1200].map((f1) => {
          const { y } = projectVowel({ f1, f2: 3500 });
          return <g key={f1} className="axis-ticks">
            <line x1={PLOT.left} x2={PLOT.left + PLOT.width} y1={y} y2={y} />
            <text x={PLOT.left - 12} y={y + 4 * textScale} textAnchor="end" style={{ fontSize: 11 * textScale }}>{f1}</text>
          </g>;
        })}
        {[3500, 2500, 1500, 500].map((f2) => {
          const { x } = projectVowel({ f1: 180, f2 });
          return <g key={f2} className="axis-ticks">
            <text x={x} y={PLOT.top + PLOT.height + 16 * textScale} textAnchor="middle" style={{ fontSize: 11 * textScale }}>{f2}</text>
          </g>;
        })}
        <text className="axis-unit" x="8" y="48" style={{ fontSize: 10 * textScale }}>F1 · Hz</text>
        <text className="axis-unit" x="798" y="480" textAnchor="end" style={{ fontSize: 10 * textScale }}>F2 · Hz</text>
        <g clipPath={`url(#${id}-clip)`}>
          {typeof overlay === 'function' ? overlay(textScale) : overlay}
          {ribbons.map((ribbon) => <path
            key={ribbon.key}
            d={ribbon.d}
            className="vowel-trail"
            data-segment={ribbon.segment}
            fillOpacity={live ? 0.8 : 0.75}
          />)}
          {cursor && cursorOpacity > 0 && <g data-testid="cursor" data-f1={point?.f1} data-f2={point?.f2} className={`vowel-cursor${faded ? ' is-faded' : ''}`} opacity={cursorOpacity} transform={`translate(${cursor.x} ${cursor.y})`}>
            <circle r="20" className="cursor-halo" />
            <circle r="7" className="cursor-dot" />
            <circle r="2" fill="white" />
          </g>}
        </g>
        {!cursor && !overlay && <g className="plot-empty">
          <g transform={`translate(398 ${250 - 35 * textScale})`}>
            <circle r="19" fill="#e6edff" />
            <path d="M-9 0h4l3-9 5 18 3-9h4" fill="none" stroke="#3764d9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text x="398" y="250" textAnchor="middle" style={{ fontSize: 14 * textScale }}>Your sound will appear here</text>
          <text className="plot-empty-hint" x="398" y={250 + 20 * textScale} textAnchor="middle" style={{ fontSize: 11 * textScale }}>Press Start, then hold a vowel.</text>
        </g>}
      </svg>
      <div className="vertical-guide">↓ Tongue lower · jaw more open</div>
      <div className="horizontal-guide"><span>← Tongue more forward</span><span>Tongue further back →</span></div>
    </div>
  );
}
