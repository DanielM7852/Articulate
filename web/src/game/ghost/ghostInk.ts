import type { VowelPoint } from '@vowel-mapper/audio/tracker';
import { advanceHead, buildRibbons, buildTrail, headRange, trailHead } from '@vowel-mapper/components/trail';

type Vec = { x: number; y: number };
type InkPoint = VowelPoint & { at: number };

/** Only this recent stretch of the learner's ink stays visible on the ghost board (it fades out over it). */
export const GHOST_INK_MAX_AGE_MS = 500;
const MIN_SPACING_MS = 24;

const fade = (ageMs: number) => {
  const life = Math.max(0, Math.min(1, 1 - ageMs / GHOST_INK_MAX_AGE_MS));
  return life * life * (3 - 2 * life);
};

/**
 * The ghost board's learner trail: same drawing as board/ink.ts InkTrail, but samples older than GHOST_INK_MAX_AGE_MS
 * are dropped so the comet stays short. Points are in whatever space the `toPx` passed to step() understands (the board
 * feeds F1/F2 in formant mode and pixel coordinates in phone mode; clear() when switching).
 */
export class GhostInk {
  private points: InkPoint[] = [];
  private segment = 0;
  private broken = true;
  private headMs: number | null = null;
  private latest: InkPoint | null = null;

  add(f1: number, f2: number, timestampMs: number, at: number) {
    if (this.broken) {
      this.segment++;
      this.broken = false;
    } else if (this.latest && timestampMs - this.latest.timestampMs < MIN_SPACING_MS) {
      return;
    }
    if (this.latest && timestampMs <= this.latest.timestampMs) return;
    const point: InkPoint = { f1, f2, timestampMs, segment: this.segment, at };
    this.points.push(point);
    this.latest = point;
  }

  breakStroke() {
    this.broken = true;
  }

  clear() {
    this.points = [];
    this.latest = null;
    this.headMs = null;
    this.broken = true;
  }

  get hasPoint(): boolean {
    return this.latest !== null;
  }

  step(now: number, dtMs: number, toPx: (p: { f1: number; f2: number }) => Vec, smooth: boolean, width: number) {
    const cutoff = now - GHOST_INK_MAX_AGE_MS;
    let drop = 0;
    while (drop < this.points.length - 1 && this.points[drop].at < cutoff) drop++;
    if (drop) this.points.splice(0, drop);
    const point = this.latest;
    const trace = point ? this.points.slice(0, -1) : this.points;
    const range = headRange(trace, point);
    this.headMs = advanceHead(this.headMs, range, dtMs, !smooth);
    const geometry = buildTrail(trace, point, smooth, toPx);
    const ribbons = buildRibbons(geometry, this.headMs, (sample) => width * fade(now - (sample as InkPoint).at));
    const cursor = point ? (trailHead(geometry, this.headMs) ?? toPx(point)) : null;
    return { cursor, ribbons };
  }
}
