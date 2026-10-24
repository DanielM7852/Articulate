import type { VowelPoint } from '../audio/tracker';
import { projectVowel } from './plot';

export const TRAIL_LIFETIME_MS = 3000;
/** The displayed head eases toward the newest accepted sample with this time constant. */
export const HEAD_TIME_CONSTANT_MS = 60;
/** The displayed head never trails the newest accepted sample by more than this. */
export const HEAD_MAX_LAG_MS = 100;
/** Longest clock step the head integrates at once, so a stalled frame never lurches. */
const HEAD_MAX_STEP_MS = 64;

export const sampleKey = (point: VowelPoint) => `${point.segment}:${point.timestampMs}`;

type Vec = { x: number; y: number };

/** AudioContext time can pause. Remember arrival times so old ink never revives
 * when capture resumes, and backdate batched history using its audio timestamps. */
export function sampleArrivalTimes(previous: ReadonlyMap<string, number>, trace: readonly VowelPoint[], point: VowelPoint | null, now: number) {
  const samples = point ? [...trace, point] : trace;
  const latest = Math.max(...samples.map((sample) => sample.timestampMs));
  return new Map(samples.map((sample) => {
    const key = sampleKey(sample);
    return [key, previous.get(key) ?? now - Math.max(0, latest - sample.timestampMs)];
  }));
}

/** Comet-tail fade: full at the head, then a smoothstep that reaches exactly zero
 * at the end of the lifetime with zero slope, so ink never visibly cuts off. */
export function trailOpacity(ageMs: number) {
  const life = Math.max(0, Math.min(1, 1 - ageMs / TRAIL_LIFETIME_MS));
  return life * life * (3 - 2 * life);
}

function trailSamples(trace: readonly VowelPoint[], point: VowelPoint | null) {
  const samples = [...trace];
  if (point && (!samples.length || point.timestampMs > samples.at(-1)!.timestampMs)) samples.push(point);
  return samples;
}

/** Audio-time span of the newest unbroken stroke: where the display head may travel. */
export function headRange(trace: readonly VowelPoint[], point: VowelPoint | null) {
  const samples = trailSamples(trace, point);
  if (!samples.length) return null;
  let first = samples.length - 1;
  while (first > 0 && samples[first - 1].segment === samples[first].segment && samples[first - 1].timestampMs < samples[first].timestampMs) first--;
  return { start: samples[first].timestampMs, end: samples.at(-1)!.timestampMs };
}

/** Frame-rate independent exponential approach of the display head (audio ms) toward
 * the newest sample. Snaps on first appearance, on reset and when asked (reduced
 * motion); a new stroke starts from its first sample. Cosmetic only: the result never
 * reaches tracking, targets or scoring. */
export function advanceHead(head: number | null, range: { start: number; end: number } | null, dtMs: number, snap = false) {
  if (!range) return null;
  if (snap || head === null || head > range.end) return range.end;
  const from = Math.max(head, range.start, range.end - HEAD_MAX_LAG_MS);
  const step = Math.min(HEAD_MAX_STEP_MS, Math.max(0, dtMs));
  const next = from + (range.end - from) * (1 - Math.exp(-step / HEAD_TIME_CONSTANT_MS));
  return range.end - next < 0.5 ? range.end : next;
}

// Monotone Hermite tangents: no overshoot on either axis, including tight turns.
function tangent(before: number, after: number) {
  return before * after <= 0 ? 0 : 2 * before * after / (before + after);
}

/** Cosmetic geometry only. Never returns measurements to tracking or scoring.
 * Every curve ends at the accepted point: no buffering or head smoothing delay. */
export function buildTrail(
  trace: readonly VowelPoint[],
  point: VowelPoint | null,
  smooth = true,
  project: (point: VowelPoint) => Vec = projectVowel,
) {
  const samples = trailSamples(trace, point);
  const projected = samples.map((sample) => project(sample));
  return samples.flatMap((sample, index) => {
    if (index === 0) return [];
    const previous = samples[index - 1];
    if (sample.segment !== previous.segment || sample.timestampMs <= previous.timestampMs) return [];
    const start = projected[index - 1];
    const end = projected[index];
    const before = index > 1 && samples[index - 2].segment === sample.segment ? projected[index - 2] : start;
    const after = index + 1 < samples.length && samples[index + 1].segment === sample.segment ? projected[index + 1] : end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const c1 = smooth ? { x: start.x + tangent(start.x - before.x, dx) / 3, y: start.y + tangent(start.y - before.y, dy) / 3 } : start;
    const c2 = smooth ? { x: end.x - tangent(dx, after.x - end.x) / 3, y: end.y - tangent(dy, after.y - end.y) / 3 } : end;
    const d = smooth
      ? `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`
      : `M${start.x},${start.y} L${end.x},${end.y}`;
    return [{ key: `${sampleKey(previous)}-${sampleKey(sample)}`, from: previous, to: sample, start, end, c1, c2, curved: smooth, d }];
  });
}

export type TrailStroke = ReturnType<typeof buildTrail>[number];

const lerp = (a: Vec, b: Vec, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** De Casteljau keeps coincident control points exact, so a held vowel never jitters. */
function strokeAt(stroke: TrailStroke, t: number) {
  if (!stroke.curved) return lerp(stroke.start, stroke.end, t);
  const a = lerp(stroke.start, stroke.c1, t);
  const b = lerp(stroke.c1, stroke.c2, t);
  const c = lerp(stroke.c2, stroke.end, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

const progress = (stroke: TrailStroke, headMs: number) =>
  (headMs - stroke.from.timestampMs) / (stroke.to.timestampMs - stroke.from.timestampMs);

/** Display position of the head on the newest stroke, or null when the head is at
 * (or has no stroke leading to) the newest accepted point: draw that point as-is. */
export function trailHead(strokes: readonly TrailStroke[], headMs: number | null): Vec | null {
  if (headMs === null) return null;
  for (let index = strokes.length - 1; index >= 0; index--) {
    const stroke = strokes[index];
    if (index < strokes.length - 1 && stroke.to !== strokes[index + 1].from) break;
    if (headMs >= stroke.to.timestampMs) return null;
    if (headMs >= stroke.from.timestampMs) return strokeAt(stroke, progress(stroke, headMs));
  }
  return null;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Closed outline of a variable-width centreline: one filled shape, no seams or overlaps. */
function outline(points: readonly (Vec & { w: number })[]) {
  const left: string[] = [];
  const right: string[] = [];
  let normal = { x: 0, y: -1 };
  points.forEach((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    let dx = after.x - before.x;
    let dy = after.y - before.y;
    if (Math.hypot(dx, dy) < 1e-6) {
      dx = point.x - before.x;
      dy = point.y - before.y;
    }
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) normal = { x: -dy / length, y: dx / length };
    const half = point.w / 2;
    left.push(`${round(point.x + normal.x * half)},${round(point.y + normal.y * half)}`);
    right.push(`${round(point.x - normal.x * half)},${round(point.y - normal.y * half)}`);
  });
  return `M${left.join(' L')} L${right.reverse().join(' L')} Z`;
}

/** One filled, tapered ribbon per unbroken stroke, drawn only up to the display head so
 * new ink grows out of the cursor instead of popping in. `width` maps a sample to its
 * ribbon width (zero once expired); widths interpolate smoothly between samples. */
export function buildRibbons(strokes: readonly TrailStroke[], headMs: number | null, width: (sample: VowelPoint) => number) {
  const ribbons: { key: string; segment: number; d: string }[] = [];
  let run: (Vec & { w: number })[] = [];
  // Keyed by the start of the unbroken stroke, so the element survives its tail expiring.
  let chain = '';
  let key = '';
  let segment = 0;
  let previous: TrailStroke | null = null;
  const push = (point: Vec, w: number) => {
    const last = run.at(-1);
    // Collapse near-duplicate vertices (held vowels); the newest position wins.
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.25) run[run.length - 1] = { ...point, w: Math.max(w, last.w) };
    else run.push({ ...point, w });
  };
  const flush = () => {
    if (run.length > 1) ribbons.push({ key, segment, d: outline(run) });
    run = [];
  };
  for (const stroke of strokes) {
    if (headMs !== null && stroke.from.timestampMs >= headMs) break;
    const w0 = width(stroke.from);
    const w1 = width(stroke.to);
    const continues = previous !== null && previous.to === stroke.from;
    previous = stroke;
    if (!continues) chain = sampleKey(stroke.from);
    if (!continues || (w0 <= 0 && w1 <= 0)) flush();
    if (w0 <= 0 && w1 <= 0) continue;
    if (!run.length) {
      key = chain;
      segment = stroke.to.segment;
      push(stroke.start, w0);
    }
    const reach = headMs === null ? 1 : Math.min(1, progress(stroke, headMs));
    const polygon = Math.hypot(stroke.c1.x - stroke.start.x, stroke.c1.y - stroke.start.y)
      + Math.hypot(stroke.c2.x - stroke.c1.x, stroke.c2.y - stroke.c1.y)
      + Math.hypot(stroke.end.x - stroke.c2.x, stroke.end.y - stroke.c2.y);
    const steps = stroke.curved ? Math.max(1, Math.ceil(Math.min(8, polygon / 4) * reach)) : 1;
    for (let step = 1; step <= steps; step++) {
      const t = (reach * step) / steps;
      push(t === 1 ? stroke.end : strokeAt(stroke, t), w0 + (w1 - w0) * t);
    }
  }
  flush();
  return ribbons;
}
