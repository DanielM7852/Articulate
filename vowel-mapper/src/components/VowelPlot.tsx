import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { VowelPoint } from '../audio/tracker';
import { PLOT, projectVowel } from './plot';

export interface VowelPlotProps {
  trace: VowelPoint[];
  point: VowelPoint | null;
  faded: boolean;
}

/** Display-only component: owns neither a microphone nor session controls. */
export function VowelPlot({ trace, point, faded }: VowelPlotProps) {
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
  const segments = new Map<number, VowelPoint[]>();
  for (const sample of trace) {
    const segment = segments.get(sample.segment) ?? [];
    segment.push(sample);
    segments.set(sample.segment, segment);
  }
  const cursor = point ? projectVowel(point) : null;
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
          {Array.from(segments, ([segment, samples]) => <polyline
            key={segment}
            points={samples.map((sample) => { const p = projectVowel(sample); return `${p.x},${p.y}`; }).join(' ')}
            className="vowel-trail"
          />)}
          {cursor && <g data-testid="cursor" data-f1={point?.f1} data-f2={point?.f2} className={`vowel-cursor${faded ? ' is-faded' : ''}`} transform={`translate(${cursor.x} ${cursor.y})`}>
            <circle r="20" className="cursor-halo" />
            <circle r="7" className="cursor-dot" />
            <circle r="2" fill="white" />
          </g>}
        </g>
        {!cursor && <g className="plot-empty">
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
