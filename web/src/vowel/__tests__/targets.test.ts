import { test, expect, run } from '../../game/__tests__/harness';
import { TARGETS, targetsFor, inTarget } from '../targets';

test('null or empty voice gives the fixed targets', () => {
  for (const v of [null, undefined, {}]) {
    const t = targetsFor(v);
    for (const id of ['i', 'u', 'a'] as const) {
      expect(t[id].f1, id).toBeCloseTo(TARGETS[id].f1, 1e-9);
      expect(t[id].f2, id).toBeCloseTo(TARGETS[id].f2, 1e-9);
    }
  }
});

test('factor scales the fallback centres, not the half-widths', () => {
  const t = targetsFor({ factor: Math.log(1.2) });
  expect(t.a.f1).toBeCloseTo(TARGETS.a.f1 * 1.2, 1e-9);
  expect(t.i.f2).toBeCloseTo(TARGETS.i.f2 * 1.2, 1e-9);
  expect(t.u.rf1).toBe(TARGETS.u.rf1);
  expect(t.u.rf2).toBe(TARGETS.u.rf2);
});

test('a near anchor (within one radius) becomes the centre; others still fall back to the sized reference', () => {
  const t = targetsFor({ factor: 0.2, vowels: { i: { f1: 450, f2: 3000 } } });
  expect(t.i.f1).toBeCloseTo(450, 1e-6);
  expect(t.i.f2).toBeCloseTo(3000, 1e-6);
  expect(t.i.rf1).toBe(TARGETS.i.rf1);
  expect(t.u.f1).toBeCloseTo(TARGETS.u.f1 * Math.exp(0.2), 1e-9);
});

test('a far anchor moves the centre exactly one radius toward it', () => {
  const far = { f1: 390 * Math.exp(0.9), f2: 2500 };
  const t = targetsFor({ vowels: { i: far } });
  const d = (p: { f1: number; f2: number }, q: { f1: number; f2: number }) =>
    Math.hypot(Math.log(q.f1 / p.f1) / TARGETS.i.rf1, Math.log(q.f2 / p.f2) / TARGETS.i.rf2);
  expect(d(TARGETS.i, t.i)).toBeCloseTo(1, 1e-9);
  expect(d(t.i, far)).toBeCloseTo(2, 1e-9);
});

test('hold detection follows the pulled centre, not a far anchor', () => {
  const far = { f1: 390 * Math.exp(0.9), f2: 2500 };
  const t = targetsFor({ vowels: { i: far } });
  expect(inTarget(t.i, t.i)).toBe(true);
  expect(inTarget(far, t.i)).toBe(false);
});

run();
