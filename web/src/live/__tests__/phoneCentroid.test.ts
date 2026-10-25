import { expect, test } from '../../game/__tests__/harness';
import { phonePlace } from '../../game/ghost/phoneMap';
import { CENTROID_MIN_MASS, easePlace, frameCentroid, latestPhonePlace, newestCentroid } from '../phoneCentroid';
import { parseFrames, type Phone, type PhoneFrame } from '../phoneStream';

const fr = (mass: number, ...top: [string, number][]): PhoneFrame => ({ t: 0, mass, top });
const P = (s: string) => phonePlace(s)!;

test('centroid: single symbol sits on its place', () => {
  const c = frameCentroid(fr(0.9, ['t', 0.8]))!;
  expect(c.x).toBeCloseTo(P('t').x, 1e-9);
  expect(c.y).toBeCloseTo(P('t').y, 1e-9);
});

test('centroid: probability-weighted average of places', () => {
  const c = frameCentroid(fr(0.9, ['t', 0.6], ['k', 0.2]))!;
  expect(c.x).toBeCloseTo((0.6 * P('t').x + 0.2 * P('k').x) / 0.8, 1e-9);
  expect(c.y).toBeCloseTo((0.6 * P('t').y + 0.2 * P('k').y) / 0.8, 1e-9);
  const m = frameCentroid(fr(0.9, ['t', 0.4], ['k', 0.4]))!;
  expect(m.x).toBeCloseTo((P('t').x + P('k').x) / 2, 1e-9);
});

test('centroid: mass gate', () => {
  expect(frameCentroid(fr(CENTROID_MIN_MASS - 0.01, ['t', 0.9]))).toBe(null);
  expect(frameCentroid(fr(CENTROID_MIN_MASS, ['t', 0.9])) !== null).toBe(true);
});

test('centroid: weight gate and unknown symbols', () => {
  expect(frameCentroid(fr(0.9, ['t', 0.2]))).toBe(null);
  expect(frameCentroid(fr(0.9, ['t', 0.2], ['k', 0.15])) !== null).toBe(true);
  // unknown symbols carry no weight and do not pull the position
  const c = frameCentroid(fr(0.9, ['t', 0.4], ['ʘ', 0.5], ['<unk>', 0.5]))!;
  expect(c.x).toBeCloseTo(P('t').x, 1e-9);
  expect(frameCentroid(fr(0.9, ['ʘ', 0.9]))).toBe(null);
  expect(frameCentroid(fr(0.9))).toBe(null);
});

test('centroid: symbols are folded (aspiration, r, nasalised)', () => {
  const a = frameCentroid(fr(0.9, ['kʰ', 0.5], ['r', 0.5]))!;
  expect(a.x).toBeCloseTo((P('k').x + P('ɹ').x) / 2, 1e-9);
  const b = frameCentroid(fr(0.9, ['æ̃', 0.6]))!;
  expect(b.y).toBeCloseTo(P('æ').y, 1e-9);
});

test('centroid: newest usable frame wins; blanks are skipped', () => {
  const frames = [fr(0.9, ['t', 0.8]), fr(0.9, ['k', 0.8]), fr(0.1, ['s', 0.9])];
  expect(newestCentroid(frames)!.x).toBeCloseTo(P('k').x, 1e-9);
  expect(newestCentroid([fr(0.1, ['t', 0.9])])).toBe(null);
  expect(newestCentroid([])).toBe(null);
});

test('centroid: exponential easing', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 1, y: 1 };
  expect(easePlace(a, b, 0).x).toBe(0);
  expect(easePlace(a, b, 70).x).toBeCloseTo(1 - Math.exp(-1), 1e-9);
  expect(easePlace(a, b, 1e6).x).toBeCloseTo(1, 1e-9);
});

test('fallback: latest significant mapped phone when no frames', () => {
  const ph = (p: string, conf = 0.9): Phone => ({ p, startMs: 0, endMs: 50, conf });
  expect(latestPhonePlace([])).toBe(null);
  expect(latestPhonePlace([ph('t'), ph('ɹ')])!.x).toBeCloseTo(P('ɹ').x, 1e-9);
  // low confidence, noise and unknown symbols are skipped back to the previous phone
  expect(latestPhonePlace([ph('t'), ph('k', 0.1), ph('ʔ'), ph('ʘ')])!.x).toBeCloseTo(P('t').x, 1e-9);
  expect(latestPhonePlace([ph('kʰ')])!.x).toBeCloseTo(P('k').x, 1e-9);
});

test('parseFrames: absent -> [], malformed entries dropped', () => {
  expect(parseFrames(undefined).length).toBe(0);
  expect(parseFrames('x').length).toBe(0);
  const out = parseFrames([{ t: 10, mass: 0.8, top: [['t', 0.7], ['k', 'x'], [1, 2], ['s', 0]] }, { t: 'a' }, null, { t: 20, mass: 0.2 }]);
  expect(out.length).toBe(2);
  expect(out[0].top.length).toBe(1);
  expect(out[0].top[0][0]).toBe('t');
  expect(out[1].top.length).toBe(0);
});
