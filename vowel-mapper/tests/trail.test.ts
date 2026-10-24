import { describe, expect, it } from 'vitest';
import type { VowelPoint } from '../src/audio/tracker';
import { buildTrail, sampleArrivalTimes, sampleKey, TRAIL_LIFETIME_MS, trailOpacity } from '../src/components/trail';
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

  it('projects through a custom projector when supplied', () => {
    const strokes = buildTrail([sample(0), sample(50, 500, 1500)], null, false, (p) => ({ x: p.f2 / 100, y: p.f1 / 100 }));
    expect(strokes[0].start).toEqual({ x: 23, y: 3 });
    expect(strokes[0].end).toEqual({ x: 15, y: 5 });
    expect(strokes[0].d).toBe('M23,3 L15,5');
  });
});
