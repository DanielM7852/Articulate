import type { WordSpec, WordZone } from './types';
import type { ZoneStatus } from './sequence';
import { clamp } from './scoring';

/**
 * Ava's example: a scripted pass through the word's zones over `spec.paceMs`, then a
 * short rest, looped. Pure function of elapsed time so the board can sample it in its
 * frame loop (and tests can check it). Positions are F1/F2 Hz in the board's plane.
 */
export const DEMO_REST_MS = 900;

/** Relative share of the pace each kind of zone gets. */
const WEIGHT: Record<WordZone['kind'], number> = { stop: 0.55, tuner: 1.3, vowel: 1.6 };

export interface DemoFrame {
  /** Zone being demonstrated, -1 during the rest. */
  activeIndex: number;
  statuses: ZoneStatus[];
  /** Ghost cursor position, null before the first voiced zone of the loop. */
  ghost: { f1: number; f2: number } | null;
  ghostVoiced: boolean;
  /** Loop counter: a new loop starts a new ink stroke. */
  loop: number;
  /** Scripted tuner value (Hz) while a tuner zone is shown, else null. */
  needle: number | null;
  /** 0..1 hold progress of the active vowel/tuner zone. */
  progress: number;
  /** Index of a stop zone whose release has happened in this loop (for the flash), else -1. */
  releasedIndex: number;
}

export function demoSegments(spec: WordSpec) {
  const total = spec.zones.reduce((sum, zone) => sum + WEIGHT[zone.kind], 0) || 1;
  let at = 0;
  return spec.zones.map((zone) => {
    const length = (WEIGHT[zone.kind] / total) * spec.paceMs;
    const segment = { start: at, end: at + length };
    at += length;
    return segment;
  });
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where a zone sits on the plane: vowel centres; a tuner borrows a closer, backer point than the vowel after it. */
export function demoAnchor(spec: WordSpec, index: number): { f1: number; f2: number } {
  const zone = spec.zones[index];
  if (zone?.vowel) return { f1: zone.vowel.f1, f2: zone.vowel.f2 };
  const vowel = spec.zones.find((z) => z.vowel)?.vowel;
  const base = vowel ? { f1: vowel.f1, f2: vowel.f2 } : { f1: 600, f2: 1600 };
  if (zone?.kind === 'tuner') return { f1: base.f1 * 0.65, f2: base.f2 * 0.7 };
  // Stops hold the position of the nearest voiced neighbour.
  for (let d = 1; d < spec.zones.length; d++) {
    for (const j of [index + d, index - d]) {
      const other = spec.zones[j];
      if (other && other.kind !== 'stop') return demoAnchor(spec, j);
    }
  }
  return base;
}

export function demoAt(spec: WordSpec, elapsedMs: number): DemoFrame {
  const cycle = spec.paceMs + DEMO_REST_MS;
  const loop = Math.floor(Math.max(0, elapsedMs) / cycle);
  const t = Math.max(0, elapsedMs) - loop * cycle;
  const segments = demoSegments(spec);
  const activeIndex = t >= spec.paceMs ? -1 : segments.findIndex((s) => t >= s.start && t < s.end);
  const statuses: ZoneStatus[] = spec.zones.map((_, i) =>
    activeIndex === -1 ? 'hit' : i < activeIndex ? 'hit' : i === activeIndex ? 'active' : 'upcoming');

  let ghost: DemoFrame['ghost'] = null;
  let ghostVoiced = false;
  let needle: number | null = null;
  let progress = 0;
  let releasedIndex = -1;
  const firstVoiced = spec.zones.findIndex((z) => z.kind !== 'stop');

  const index = activeIndex === -1 ? spec.zones.length - 1 : activeIndex;
  const zone = spec.zones[index];
  const seg = segments[index];
  const local = activeIndex === -1 ? 1 : clamp((t - seg.start) / (seg.end - seg.start), 0, 1);

  if (zone) {
    const here = demoAnchor(spec, index);
    if (zone.kind === 'stop') {
      // Closure, then release at 60% of the segment.
      if (local >= 0.6 || activeIndex === -1) releasedIndex = index;
      ghost = index > firstVoiced || firstVoiced === -1 ? here : demoAnchor(spec, firstVoiced);
      ghostVoiced = false;
    } else if (zone.kind === 'tuner') {
      const tuner = zone.tuner!;
      const from = tuner.pushTo === 'low' ? lerp(tuner.highHz, tuner.maxHz, 0.6) : lerp(tuner.lowHz, tuner.minHz, 0.6);
      const to = (tuner.lowHz + tuner.highHz) / 2;
      needle = lerp(from, to, easeInOut(clamp(local / 0.45, 0, 1)));
      progress = clamp((local - 0.4) / 0.5, 0, 1);
      ghost = here;
      ghostVoiced = true;
    } else {
      const prev = index > 0 ? demoAnchor(spec, index - 1) : here;
      const glide = easeInOut(clamp(local / 0.35, 0, 1));
      ghost = { f1: lerp(prev.f1, here.f1, glide), f2: lerp(prev.f2, here.f2, glide) };
      ghostVoiced = true;
      progress = clamp((local - 0.35) / 0.5, 0, 1);
    }
  }
  if (activeIndex === -1) {
    ghostVoiced = false;
    progress = 0;
  }
  // Earlier stops in this loop have released too.
  if (releasedIndex === -1 && activeIndex > 0) {
    for (let i = activeIndex - 1; i >= 0; i--) if (spec.zones[i].kind === 'stop') { releasedIndex = i; break; }
  }
  return { activeIndex, statuses, ghost, ghostVoiced, loop, needle, progress, releasedIndex };
}
