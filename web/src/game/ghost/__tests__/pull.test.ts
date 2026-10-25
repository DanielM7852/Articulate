import { expect, test } from '../../__tests__/harness';
import { REFERENCE_V1 } from '@vowel-mapper/reference/data';
import { ghostModel } from '../models';
import { sizeModel } from '../follow';
import { anchorDistance } from '../../../vowel/pull';
import { validateGhostModel } from '../validate';
import { GHOST_WORDS } from '../words';
import recordedTiming from '../models/recorded-timing.json';

const R_IY = (REFERENCE_V1.radius.iy[0] + REFERENCE_V1.radius.iy[1]) / 2;
const IY = { f1: Math.exp(REFERENCE_V1.means.iy[0]), f2: Math.exp(REFERENCE_V1.means.iy[1]) };
const FACTOR = 0.1;
const SIZED = { f1: IY.f1 * Math.exp(FACTOR), f2: IY.f2 * Math.exp(FACTOR) };
const offset = (radii: number) => ({ f1: SIZED.f1 * Math.exp(radii * R_IY), f2: SIZED.f2 });

// sheep holds iy in the middle of its single stretch.
const iyPoint = (m: ReturnType<typeof ghostModel>) => {
  const pts = m.segments[0].points;
  return pts[Math.floor(pts.length / 2)];
};

test('pull: no personal or no anchors gives today\'s model', () => {
  const base = ghostModel('sheep');
  expect(ghostModel('sheep', { factor: FACTOR })).toBe(base);
  expect(ghostModel('sheep', { factor: FACTOR, anchors: {} })).toBe(base);
});

test('pull: an anchor 0.5 radius away is reached by the sized iy target', () => {
  const anchor = offset(0.5);
  const m = sizeModel(ghostModel('sheep', { factor: FACTOR, anchors: { i: anchor } }), FACTOR);
  const p = iyPoint(m);
  expect(anchorDistance(p, anchor, R_IY)).toBeCloseTo(0, 0.01);
});

test('pull: an anchor 3 radii away moves the target one radius toward it', () => {
  const anchor = offset(3);
  const m = sizeModel(ghostModel('sheep', { factor: FACTOR, anchors: { i: anchor } }), FACTOR);
  const p = iyPoint(m);
  expect(anchorDistance(SIZED, p, R_IY)).toBeCloseTo(1, 0.02);
  expect(anchorDistance(p, anchor, R_IY)).toBeCloseTo(2, 0.02);
});

test('pull: r points and spread are unchanged, provenance notes the pull', () => {
  const base = ghostModel('rent');
  const m = ghostModel('rent', { factor: FACTOR, anchors: { eh: { f1: 700, f2: 1500 } } });
  expect(m.segments[0].points[0].f1).toBe(base.segments[0].points[0].f1);
  expect(m.segments[0].points[0].f2).toBe(base.segments[0].points[0].f2);
  expect(m.segments[0].spread.join()).toBe(base.segments[0].spread.join());
  expect(m.provenance.includes('personal pull')).toBe(true);
  expect(ghostModel('rent').provenance.includes('personal pull')).toBe(false);
});

test('recorded track: source recorded, validates, keeps the recorded timeline', () => {
  const m = ghostModel('track');
  expect(m.source).toBe('recorded');
  expect(m.factor).toBe(0);
  expect(validateGhostModel(m, GHOST_WORDS.track).length).toBe(0);
  const rec = recordedTiming.words.track;
  expect(m.durationMs).toBe(rec.durationMs);
  const at = (z: string) => m.markers.find((x) => x.zoneId === z)!.t;
  const peak = (p: string) => rec.phones.find((x) => x.p === p)!.peak;
  expect(at('t')).toBeCloseTo(peak('t'), 0.005);
  expect(at('r')).toBeCloseTo(peak('ɹ'), 0.005);
  expect(at('k')).toBeCloseTo(peak('k'), 0.005);
  expect(m.parts[1].t0).toBeCloseTo(rec.phones.find((x) => x.p === 'æ')!.t0, 0.005);
  expect(m.parts[2].t0).toBeCloseTo(rec.phones.find((x) => x.p === 'k')!.t0, 0.005);
  expect(m.provenance.includes('median of 10')).toBe(true);
});

test('recorded track: personal pull still moves the ae target', () => {
  const base = ghostModel('track');
  const m = ghostModel('track', { factor: FACTOR, anchors: { ae: { f1: 900, f2: 1700 } } });
  const last = (x: ReturnType<typeof ghostModel>) => x.segments[0].points[x.segments[0].points.length - 1];
  expect(m.source).toBe('recorded');
  expect(m.durationMs).toBe(base.durationMs);
  expect(last(m).f1 === last(base).f1 && last(m).f2 === last(base).f2).toBe(false);
  expect(m.provenance.includes('personal pull')).toBe(true);
  expect(validateGhostModel(m, GHOST_WORDS.track).length).toBe(0);
});
