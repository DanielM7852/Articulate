import type { Step } from './beatmap';
import type { GameOptions, NoteState } from './run';
import { VOWEL_LABEL, VOWELS, zoneOutline, type VowelId, type Zone, type ZoneSet } from './zones';
import { projectVowel } from '../components/plot';

interface Projected {
  points: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function project(zone: Zone): Projected {
  const outline = zoneOutline(zone, 48).map(projectVowel);
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const centre = projectVowel(zone);
  return {
    points: outline.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    cx: centre.x,
    cy: centre.y,
    rx: (Math.max(...xs) - Math.min(...xs)) / 2,
    ry: (Math.max(...ys) - Math.min(...ys)) / 2,
  };
}

export interface GameOverlayProps {
  zones: ZoneSet;
  textScale: number;
  step?: Step;
  note?: NoteState;
  options?: GameOptions;
  timeMs?: number;
}

/** Zones, glide path, hold progress and approach ring, drawn in the plot's own coordinates. */
export function GameOverlay({ zones, textScale, step, note, options, timeMs = 0 }: GameOverlayProps) {
  const shapes = Object.fromEntries(VOWELS.map((vowel) => [vowel, project(zones[vowel])])) as Record<VowelId, Projected>;
  const spec = note && note.status !== 'upcoming' ? step?.note : undefined;
  const active = new Set<VowelId>(spec ? (spec.kind === 'glide' ? [spec.from, spec.to] : [spec.vowel]) : []);
  const minZone = options?.minZonePoints ?? 2;
  const reached = new Set<VowelId>();
  if (spec?.kind === 'glide' && note) {
    if (note.fromPoints >= minZone) reached.add(spec.from);
    if (note.outcome === 'hit') reached.add(spec.to);
  }
  if (spec?.kind === 'hold' && note?.outcome === 'hit') reached.add(spec.vowel);
  const start = spec ? shapes[spec.kind === 'glide' ? spec.from : spec.vowel] : null;
  const approach = note?.status === 'approaching' && options && start
    ? Math.min(1, Math.max(0, (note.targetMs - timeMs) / options.approachMs))
    : null;

  return (
    <g className="game-overlay" data-testid="game-overlay">
      <defs>
        <marker id="game-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      {VOWELS.map((vowel) => {
        const shape = shapes[vowel];
        const state = reached.has(vowel) ? 'is-reached' : active.has(vowel) ? 'is-active' : '';
        return (
          <g key={vowel} className={`game-zone ${state}`} data-testid={`zone-${vowel}`}>
            <polygon points={shape.points} />
            <text x={shape.cx} y={shape.cy + 4.5 * textScale} textAnchor="middle" style={{ fontSize: 13 * textScale }}>{VOWEL_LABEL[vowel].sound}</text>
          </g>
        );
      })}
      {spec?.kind === 'glide' && <GlidePath from={shapes[spec.from]} to={shapes[spec.to]} />}
      {spec?.kind === 'hold' && note && note.heldMs > 0 && (
        <polygon className="game-hold-progress" points={shapes[spec.vowel].points} pathLength={1}
          strokeDasharray={`${Math.min(1, note.heldMs / spec.holdMs)} 1`} />
      )}
      {approach !== null && start && (
        <ellipse className="game-approach" data-testid="approach-ring" cx={start.cx} cy={start.cy}
          rx={start.rx * (1 + 2.2 * approach)} ry={start.ry * (1 + 2.2 * approach)} style={{ opacity: 0.35 + 0.65 * (1 - approach) }} />
      )}
    </g>
  );
}

function GlidePath({ from, to }: { from: Projected; to: Projected }) {
  // Start and end on the zone edges, bowed slightly so the path never hides a third zone's label.
  const dx = to.cx - from.cx, dy = to.cy - from.cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const edge = (shape: Projected) => Math.hypot(ux * shape.rx, uy * shape.ry) + 6;
  const x1 = from.cx + ux * edge(from), y1 = from.cy + uy * edge(from);
  const x2 = to.cx - ux * edge(to), y2 = to.cy - uy * edge(to);
  const bow = Math.min(40, length * 0.12);
  const qx = (x1 + x2) / 2 - uy * bow, qy = (y1 + y2) / 2 + ux * bow;
  return <path className="game-glide" data-testid="glide-path" d={`M${x1} ${y1} Q${qx} ${qy} ${x2} ${y2}`} markerEnd="url(#game-arrow)" />;
}
