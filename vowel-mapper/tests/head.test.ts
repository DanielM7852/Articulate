import { describe, expect, it } from 'vitest';
import type { TrackedFrame, VowelPoint } from '../src/audio/tracker';
import { EH_RADIUS_V1, VOICE_SIZE_V1 } from '../src/reference/data';
import {
  HeadPractice, PATH_POINTS, modelFromTakes, pathDistance, resamplePath, targetPath, wordPath,
  type HeadModel,
} from '../src/game/head';
import { uhFactor, type VoiceProfile } from '../src/game/targets';

const HOP = 25;
type Formants = { f1: number; f2: number };

const heard = (timestampMs: number, f1: number, f2: number, segment = 0): TrackedFrame => ({
  estimate: { valid: true, f1, f2, rms: 0.1, periodicity: 0.95, confidence: 0.85 },
  point: { f1, f2, timestampMs, segment },
  status: 'tracking',
  timestampMs,
});
const silent = (timestampMs: number): TrackedFrame => ({
  estimate: { valid: false, reason: 'quiet', rms: 0, periodicity: 0 },
  point: null,
  status: 'quiet',
  timestampMs,
});

/** A "head"-like glide: /ɛ/ at 680/2040 Hz moving F1 down and F2 up by 10% towards the "d", all times `scale`. */
const glide = (u: number, scale = 1): Formants => ({ f1: 680 * scale * Math.exp(-0.1 * u), f2: 2040 * scale * Math.exp(0.1 * u) });
const points = (count: number, scale = 1, t0 = 0, segment = 0): VowelPoint[] =>
  Array.from({ length: count }, (_, i) => ({ ...glide(i / (count - 1), scale), timestampMs: t0 + i * HOP, segment }));

const model = (scale = 1, factor = 0): HeadModel => ({
  id: 'test', version: 1, word: 'head', factor, threshold: 0.5, takes: 5,
  path: resamplePath(points(40, scale))!.map((p) => [Math.log(p.f1), Math.log(p.f2)] as const),
});
const profile = (factor: number): VoiceProfile => ({ version: 1, factor, place: 'quiet', sizing: 'approximate', start: {}, measuredAt: 0 });

/** Say a glide of `count` frames at `scale`, then stay silent long enough for the attempt to end. */
function say(practice: HeadPractice, t: number, count: number, scale = 1) {
  let snap = practice.push(silent(t));
  for (let i = 0; i < count; i++) { t += HOP; snap = practice.push(heard(t, glide(i / Math.max(1, count - 1), scale).f1, glide(i / Math.max(1, count - 1), scale).f2)); }
  for (let i = 0; i < 80; i++) { t += HOP; snap = practice.push(silent(t)); }
  return { snap, t };
}
function sayAll(practice: HeadPractice, scales: (number | null)[], count = 40) {
  let t = 0, snap = practice.push(silent(0));
  for (const scale of scales) ({ snap, t } = say(practice, t, scale === null ? 3 : count, scale ?? 1));
  return snap;
}

describe('word path', () => {
  it('keeps the longest unbroken stretch of tracked sound', () => {
    const word = [...points(3, 1.5, 0, 0), ...points(20, 1, 200, 1), ...points(4, 0.7, 900, 2)];
    expect(wordPath(word)).toHaveLength(20);
    expect(wordPath(word)[0].segment).toBe(1);
  });

  it('resamples to a fixed number of points over the word’s own time, in log Hz', () => {
    const path = resamplePath(points(25))!;
    expect(path).toHaveLength(PATH_POINTS);
    expect(path[0].f1).toBeCloseTo(680, 6);
    expect(path.at(-1)!.f2).toBeCloseTo(2040 * Math.exp(0.1), 6);
    // Halfway in time is halfway along the glide in log Hz.
    const mid = resamplePath(points(25), 3)![1];
    expect(Math.log(mid.f1)).toBeCloseTo(Math.log(680) - 0.05, 6);
  });

  it('needs the same 12 tracked points as a held vowel', () => {
    expect(resamplePath(points(11))).toBeNull();
    expect(resamplePath(points(12))).not.toBeNull();
  });

  it('measures the mean per-point distance in /ɛ/ reference radii', () => {
    const a = resamplePath(points(30))!;
    expect(pathDistance(a, a)).toBe(0);
    const shifted = a.map((p) => ({ f1: p.f1 * Math.exp(EH_RADIUS_V1[0]), f2: p.f2 }));
    expect(pathDistance(shifted, a)).toBeCloseTo(1, 6);
  });
});

describe('model voice', () => {
  it('takes the per-point log-median of the takes and sets the pass mark from their own spread', () => {
    const takes = [0.98, 0.99, 1, 1.01, 1.03].map((s) => resamplePath(points(40, s))!);
    const built = modelFromTakes(takes);
    expect(Math.exp(built.path[0][0])).toBeCloseTo(680, 6);
    const spread = takes.map((take) => pathDistance(take, built.path.map(([f1, f2]) => ({ f1: Math.exp(f1), f2: Math.exp(f2) })))).sort((a, b) => a - b);
    expect(built.spread).toEqual(spread);
    // 90th percentile of take-to-median distance, × 1.5.
    expect(built.threshold).toBeCloseTo(1.5 * (spread[3] + 0.6 * (spread[4] - spread[3])), 6);
  });

  it('sizes the model to the learner with one log shift', () => {
    const target = targetPath(model(1, -0.2), Math.log(1.1) - 0.2);
    expect(target[0].f1).toBeCloseTo(680 * 1.1, 6);
    expect(target[0].f2).toBeCloseTo(2040 * 1.1, 6);
  });

  it('sizes the model speaker with the same "uh" + voice group rule as learners', () => {
    const uh = { f1: Math.exp(VOICE_SIZE_V1.uh[0]) * 1.2, f2: Math.exp(VOICE_SIZE_V1.uh[1]) * 1.2 };
    expect(uhFactor(uh, 'women')).toBeCloseTo((Math.log(1.2) + VOICE_SIZE_V1.groupFactor.women) / 2, 6);
  });
});

describe('head practice', () => {
  it('measures each attempt against the model sized to the learner', () => {
    // A learner whose voice is 10% bigger, saying the model's glide 10% bigger: a perfect match.
    const snap = sayAll(new HeadPractice(model(1, 0), profile(Math.log(1.1))), [1.1]);
    expect(snap.attempts).toHaveLength(1);
    expect(snap.attempts[0]).toMatchObject({ outcome: 'measured', matched: true });
    expect(snap.attempts[0].distance).toBeCloseTo(0, 2);
    expect(snap.attempts[0].path).toHaveLength(PATH_POINTS);
  });

  it('matches the model after three close attempts in a row', () => {
    const practice = new HeadPractice(model(), profile(0));
    const snap = sayAll(practice, [1, 1.3, 1, 1, 1]);
    expect(snap.attempts.map((a) => a.matched)).toEqual([true, false, true, true, true]);
    expect(snap.streak).toBe(3);
    expect(snap.phase).toBe('matched');
  });

  it('stops listening once matched', () => {
    const snap = sayAll(new HeadPractice(model(), profile(0)), [1, 1, 1, 1]);
    expect(snap.attempts).toHaveLength(3);
  });

  it('never counts an attempt it could not hear clearly, for or against', () => {
    const snap = sayAll(new HeadPractice(model(), profile(0)), [1, 1, null, 1], 40);
    expect(snap.attempts.map((a) => a.outcome)).toEqual(['measured', 'measured', 'measured']);
    const short = sayAll(new HeadPractice(model(), profile(0)), [1, 1], 8);
    expect(short.attempts.map((a) => a.outcome)).toEqual(['unheard', 'unheard']);
    expect(short.streak).toBe(0);
    const withMiss = new HeadPractice(model(), profile(0));
    let t = 0;
    for (const count of [40, 8, 40, 40]) t = say(withMiss, t, count).t;
    expect(withMiss.snapshot()).toMatchObject({ phase: 'matched', streak: 3 });
  });

  it('ignores a blip too short to be a word', () => {
    const snap = sayAll(new HeadPractice(model(), profile(0)), [null]);
    expect(snap.attempts).toHaveLength(0);
    expect(snap.phase).toBe('listening');
  });

  it('shows the attempt as it is said, then rests before the next', () => {
    const practice = new HeadPractice(model(), profile(0));
    let snap = practice.push(silent(0));
    for (let i = 1; i <= 10; i++) snap = practice.push(heard(i * HOP, 680, 2040));
    expect(snap.phase).toBe('hearing');
    expect(snap.live).toHaveLength(10);
    for (let i = 11; i <= 30; i++) snap = practice.push(heard(i * HOP, 680, 2040));
    for (let i = 31; i <= 45; i++) snap = practice.push(silent(i * HOP));
    expect(snap.phase).toBe('resting');
    expect(snap.live).toHaveLength(0);
    // Sound during the rest is not an attempt.
    snap = practice.push(heard(46 * HOP, 680, 2040));
    expect(snap.phase).toBe('resting');
  });

  it('ends a long attempt at the time limit', () => {
    const practice = new HeadPractice(model(), profile(0), { maxMs: 2000 });
    let snap = practice.push(silent(0));
    for (let t = HOP; t <= 3000 && !snap.attempts.length; t += HOP) snap = practice.push(heard(t, 680, 2040));
    expect(snap.attempts).toHaveLength(1);
  });
});
