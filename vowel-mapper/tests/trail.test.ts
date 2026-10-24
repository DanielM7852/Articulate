import { describe, expect, it } from 'vitest';
import type { VowelPoint } from '../src/audio/tracker';
import {
  advanceHead, buildRibbons, buildTrail, HEAD_MAX_LAG_MS, HEAD_TIME_CONSTANT_MS, sampleArrivalTimes, sampleKey, TRAIL_LIFETIME_MS, trailHead, trailOpacity,
} from '../src/components/trail';
import { projectVowel } from '../src/components/plot';

const sample = (timestampMs: number, f1 = 300, f2 = 2300, segment = 0): VowelPoint => ({ timestampMs, f1, f2, segment });

describe('presentation-only trail', () => {
  it('decays monotonically to exactly zero, with bounded opacity', () => {
    expect(trailOpacity(-10)).toBe(1);
    const opacity = [0, 500, 1500, 2999, 3000, 10000].map(trailOpacity);
    expect(opacity).toEqual([...opacity].sort((a, b) => b - a));
    expect(opacity[0]).toBe(1);
    expect(opacity[3]).toBeGreaterThan(0);
    expect(trailOpacity(TRAIL_LIFETIME_MS)).toBe(0);
    expect(opacity.at(-1)).toBe(0);
  });

  it('backdates history, retains arrival time through stalls and prunes on reset', () => {
    const old = sample(100);
    const head = sample(150);
    const first = sampleArrivalTimes(new Map(), [old], head, 5000);
    expect(first.get(sampleKey(old))).toBe(4950);
    expect(first.get(sampleKey(head))).toBe(5000);
    // Audio time barely advances after a long suspension; old ink must stay old.
    const resumed = sample(175);
    const second = sampleArrivalTimes(first, [old, head], resumed, 10000);
    expect(second.get(sampleKey(old))).toBe(4950);
    expect(second.get(sampleKey(head))).toBe(5000);
    expect(second.get(sampleKey(resumed))).toBe(10000);
    expect(trailOpacity(10000 - second.get(sampleKey(old))!)).toBe(0);
    expect(sampleArrivalTimes(second, [], null, 10000).size).toBe(0);
    expect(sampleArrivalTimes(second, [resumed], resumed, 10000).size).toBe(1);
  });

  it('does not join separate strokes, even if a segment ID is reused later', () => {
    const trace = [sample(0), sample(50), sample(100, 750, 1200, 1), sample(150, 700, 1300, 1), sample(200)];
    const strokes = buildTrail(trace, null);
    expect(strokes).toHaveLength(2);
    expect(strokes.every(({ from, to }) => from.segment === to.segment)).toBe(true);
    expect(buildTrail([sample(50), sample(50), sample(0)], null)).toEqual([]);
  });

  it('ends at the newest accepted point, without waiting for a future sample or mutating input', () => {
    const trace = Object.freeze([Object.freeze(sample(0)), Object.freeze(sample(50, 500, 1500))]);
    const point = Object.freeze(sample(75, 600, 1300));
    const strokes = buildTrail(trace, point);
    expect(strokes).toHaveLength(2);
    expect(strokes.at(-1)!.end).toEqual(projectVowel(point));
    expect(strokes.at(-1)!.to).toBe(point);
    expect(trace).toHaveLength(2);
    expect(buildTrail([...trace, point], point)).toHaveLength(2);
    expect(buildTrail(trace, sample(75, 600, 1300, 1))).toHaveLength(1);
  });

  it('keeps every cubic control point inside its accepted endpoints, even at sharp turns', () => {
    const strokes = buildTrail([sample(0), sample(50, 900, 600), sample(100, 200, 3200), sample(150, 750, 1200)], null);
    for (const { d, start, end } of strokes) {
      const coordinates = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let i = 2; i < 6; i += 2) {
        expect(coordinates[i]).toBeGreaterThanOrEqual(Math.min(start.x, end.x));
        expect(coordinates[i]).toBeLessThanOrEqual(Math.max(start.x, end.x));
        expect(coordinates[i + 1]).toBeGreaterThanOrEqual(Math.min(start.y, end.y));
        expect(coordinates[i + 1]).toBeLessThanOrEqual(Math.max(start.y, end.y));
      }
    }
    expect(buildTrail([sample(0), sample(50)], null, false)[0].d).toContain(' L');
  });

  it('fades as a smooth comet tail: near-full when fresh, zero slope into expiry', () => {
    expect(trailOpacity(100)).toBeGreaterThan(0.99);
    expect(trailOpacity(TRAIL_LIFETIME_MS / 2)).toBeCloseTo(0.5, 5);
    // No visible cut-off: the last 100 ms of ink is already almost invisible.
    expect(trailOpacity(TRAIL_LIFETIME_MS - 100)).toBeLessThan(0.005);
    const steps = Array.from({ length: 31 }, (_, i) => trailOpacity(i * 100));
    const drops = steps.slice(1).map((value, i) => steps[i] - value);
    expect(Math.max(...drops)).toBeLessThan(0.06);
  });

  it('eases the display head frame-rate independently, bounded in lag, and lands exactly', () => {
    const range = { start: 0, end: 100 };
    expect(advanceHead(null, range, 16)).toBe(100);
    expect(advanceHead(50, null, 16)).toBeNull();
    expect(advanceHead(40, range, 16, true)).toBe(100);
    expect(advanceHead(140, range, 16)).toBe(100);
    // A new stroke starts from its own first sample, never from the previous stroke.
    expect(advanceHead(10, { start: 80, end: 100 }, 0)).toBe(80);
    // Never more than the maximum lag behind the accepted point.
    expect(advanceHead(-500, { start: -1000, end: 100 }, 0)).toBe(100 - HEAD_MAX_LAG_MS);
    const once = advanceHead(50, range, 32)!;
    const twice = advanceHead(advanceHead(50, range, 16), range, 16)!;
    expect(once).toBeCloseTo(twice, 9);
    expect(once).toBeCloseTo(100 - 50 * Math.exp(-32 / HEAD_TIME_CONSTANT_MS), 9);
    let head: number | null = 0;
    for (let frame = 0; frame < 60 && head !== 100; frame++) head = advanceHead(head, range, 16);
    expect(head).toBe(100);
  });

  it('places the head on the curve, then exactly on the accepted point', () => {
    const trace = [sample(0), sample(50, 500, 1500), sample(100, 650, 1200)];
    const strokes = buildTrail(trace, null);
    expect(trailHead(strokes, 100)).toBeNull();
    expect(trailHead(strokes, null)).toBeNull();
    expect(trailHead(strokes, 50)).toEqual(strokes[1].start);
    const mid = trailHead(strokes, 75)!;
    const [a, b] = [projectVowel(trace[1]), projectVowel(trace[2])];
    expect(mid.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x));
    expect(mid.x).toBeLessThanOrEqual(Math.max(a.x, b.x));
    // A held vowel keeps the head on the exact accepted coordinates.
    const held = buildTrail([sample(0), sample(50)], null);
    expect(trailHead(held, 25)).toEqual(projectVowel(sample(0)));
    // A lone sample on a new stroke has nothing to ease along.
    expect(trailHead(buildTrail(trace, sample(150, 700, 900, 1)), 150)).toBeNull();
  });

  it('draws one closed ribbon per stroke, only up to the head, tapering to nothing', () => {
    const trace = [sample(0), sample(50, 500, 1500), sample(100, 650, 1200), sample(150, 300, 2300, 1), sample(200, 350, 2100, 1)];
    const strokes = buildTrail(trace, null);
    const ribbons = buildRibbons(strokes, null, () => 6);
    expect(ribbons.map((ribbon) => ribbon.segment)).toEqual([0, 1]);
    expect(ribbons.every((ribbon) => ribbon.d.startsWith('M') && ribbon.d.endsWith(' Z'))).toBe(true);
    // Expired ink is dropped; a head before the second stroke hides it.
    expect(buildRibbons(strokes, null, (s) => (s.segment === 1 ? 0 : 6)).map((r) => r.segment)).toEqual([0]);
    expect(buildRibbons(strokes, 150, () => 6)).toHaveLength(1);
    expect(buildRibbons(strokes, 0, () => 6)).toEqual([]);
    const area = (d: string) => {
      const xy = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      let sum = 0;
      for (let i = 0; i < xy.length; i += 2) {
        const j = (i + 2) % xy.length;
        sum += xy[i] * xy[j + 1] - xy[j] * xy[i + 1];
      }
      return Math.abs(sum) / 2;
    };
    // Narrower ink and a shorter reach both shrink the ribbon.
    expect(area(buildRibbons(strokes, null, () => 2)[0].d)).toBeLessThan(area(ribbons[0].d));
    expect(area(buildRibbons(strokes, 75, () => 6)[0].d)).toBeLessThan(area(ribbons[0].d));
    // The ribbon key survives its tail expiring, so the element is not remounted.
    expect(buildRibbons(strokes, null, (s) => (s.timestampMs === 0 ? 0 : 6))[0].key).toBe(ribbons[0].key);
  });

  it('projects through a custom projector when supplied', () => {
    const strokes = buildTrail([sample(0), sample(50, 500, 1500)], null, false, (p) => ({ x: p.f2 / 100, y: p.f1 / 100 }));
    expect(strokes[0].start).toEqual({ x: 23, y: 3 });
    expect(strokes[0].end).toEqual({ x: 15, y: 5 });
    expect(strokes[0].d).toBe('M23,3 L15,5');
  });
});
