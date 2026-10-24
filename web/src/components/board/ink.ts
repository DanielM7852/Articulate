import type { VowelPoint } from '@vowel-mapper/audio/tracker';
import {
  TRAIL_LIFETIME_MS,
  advanceHead,
  buildRibbons,
  buildTrail,
  headRange,
  trailHead,
  trailOpacity,
} from '@vowel-mapper/components/trail';

type Vec = { x: number; y: number };
/** A trail sample plus its arrival on the presentation clock (performance.now). */
type InkPoint = VowelPoint & { at: number };

/** New samples closer together than this (frame clock) are skipped, bounding the trace to ~120 points. */
const MIN_SPACING_MS = 24;

/**
 * Imperative version of VowelGraph's trail: the same pure helpers (monotone Hermite
 * strokes, 60 ms eased display head, tapered comet ribbons, 3 s fade), but stepped from
 * the board's own rAF loop instead of React state, so a 60-100 Hz frame stream never
 * re-renders the board. Cosmetic only: nothing here feeds scoring.
 */
export class InkTrail {
  private points: InkPoint[] = [];
  private segment = 0;
  private broken = true;
  private headMs: number | null = null;
  private latest: InkPoint | null = null;

  /** Add an accepted F1/F2 sample (frame-clock timestamp). */
  add(f1: number, f2: number, timestampMs: number, at: number) {
    if (this.broken) {
      this.segment++;
      this.broken = false;
    } else if (this.latest && timestampMs - this.latest.timestampMs < MIN_SPACING_MS) {
      return;
    }
    const point: InkPoint = { f1, f2, timestampMs, segment: this.segment, at };
    if (this.latest && timestampMs <= this.latest.timestampMs) return;
    this.points.push(point);
    this.latest = point;
  }

  /** End the current stroke: the next sample starts a new one (unvoiced, loop restart). */
  breakStroke() {
    this.broken = true;
  }

  clear() {
    this.points = [];
    this.latest = null;
    this.headMs = null;
    this.broken = true;
  }

  get last(): { f1: number; f2: number } | null {
    return this.latest;
  }

  /**
   * Step the eased head and build ribbons. Returns the display position of the cursor
   * (eased along the newest stroke) and ribbon paths in CSS pixels.
   */
  step(now: number, dtMs: number, toPx: (p: { f1: number; f2: number }) => Vec, smooth: boolean, width: number) {
    // Expired ink goes, but the newest sample stays as the cursor's anchor.
    const cutoff = now - TRAIL_LIFETIME_MS;
    let drop = 0;
    while (drop < this.points.length - 1 && this.points[drop].at < cutoff) drop++;
    if (drop) this.points.splice(0, drop);

    const point = this.latest;
    const trace = point ? this.points.slice(0, -1) : this.points;
    const range = headRange(trace, point);
    this.headMs = advanceHead(this.headMs, range, dtMs, !smooth);
    const geometry = buildTrail(trace, point, smooth, toPx);
    const ribbons = buildRibbons(geometry, this.headMs, (sample) => width * trailOpacity(now - (sample as InkPoint).at));
    const cursor = point ? (trailHead(geometry, this.headMs) ?? toPx(point)) : null;
    return { cursor, ribbons };
  }
}
