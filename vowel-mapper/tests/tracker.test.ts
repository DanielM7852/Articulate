import { expect, it } from 'vitest';
import { VowelTracker } from '../src/audio/tracker';
import type { FormantEstimate } from '../src/audio/estimator';

const measured = (f1: number, f2: number): FormantEstimate => ({
  valid: true, f1, f2, rms: 0.1, periodicity: 0.95, confidence: 0.85,
});

it('rejects an isolated large jump but accepts a persistent new vowel', () => {
  const tracker = new VowelTracker();
  tracker.push(measured(300, 2300), 0);
  tracker.push(measured(300, 2300), 20);
  expect(tracker.push(measured(900, 1000), 40).point).toBeNull();
  expect(tracker.push(measured(300, 2300), 60).point?.f1).toBeCloseTo(300);
  tracker.push(measured(900, 1000), 80);
  tracker.push(measured(900, 1000), 100);
  expect(tracker.push(measured(900, 1000), 120).point?.f1).toBeCloseTo(900);
});

it('breaks the trail across silence and reacquires without interpolating across the gap', () => {
  const tracker = new VowelTracker();
  tracker.push(measured(300, 2300), 0);
  const first = tracker.push(measured(300, 2300), 20).point!;
  expect(tracker.push({ valid: false, reason: 'quiet', rms: 0, periodicity: 0 }, 400).point).toBeNull();
  tracker.push(measured(800, 1200), 500);
  const next = tracker.push(measured(800, 1200), 520).point!;
  expect(next.f1).toBeCloseTo(800);
  expect(next.segment).toBeGreaterThan(first.segment);
});

it('treats a sound after a burst of conflicting estimates as new, needing two agreeing frames', () => {
  const tracker = new VowelTracker();
  let time = 0;
  let before = null;
  for (let i = 0; i < 20; i++) before = tracker.push(measured(370, 930), time += 25).point;
  // 200 ms of valid but conflicting estimates, none consistent enough to confirm a jump.
  for (let i = 0; i < 8; i++) tracker.push(i % 2 ? measured(370, 2400) : measured(905, 2800), time += 25);
  expect(tracker.push(measured(905, 2800), time += 25).point).toBeNull();
  const after = tracker.push(measured(905, 2800), time += 25).point;
  expect(after?.f1).toBeCloseTo(905);
  expect(after!.segment).toBeGreaterThan(before!.segment);
});

it('does not let one stray frame near the old position restart the trail after a long unaccepted stretch', () => {
  const tracker = new VowelTracker();
  let time = 0;
  let before = null;
  for (let i = 0; i < 20; i++) before = tracker.push(measured(370, 930), time += 25).point;
  for (let i = 0; i < 8; i++) tracker.push(i % 2 ? measured(370, 2400) : measured(905, 2800), time += 25);
  expect(tracker.push(measured(370, 930), time += 25).point).toBeNull();
  const after = tracker.push(measured(370, 930), time += 25).point;
  expect(after?.f1).toBeCloseTo(370);
  expect(after!.segment).toBeGreaterThan(before!.segment);
});

it('draws a new vowel within 300 ms when its frames alternate with uncertain ones', () => {
  const tracker = new VowelTracker();
  const uncertain: FormantEstimate = { valid: false, reason: 'uncertain', rms: 0.1, periodicity: 0.9 };
  let time = 0;
  for (let i = 0; i < 20; i++) tracker.push(measured(340, 2050), time += 25);
  const start = time + 25;
  let drawn = null;
  for (let i = 0; i < 40 && !drawn; i++) {
    const point = tracker.push(i % 2 ? uncertain : measured(675, 1320), time += 25).point;
    if (point) drawn = point;
  }
  expect(drawn?.f1).toBeCloseTo(675);
  expect(drawn!.timestampMs - start).toBeLessThan(300);
});

it('keeps one unbroken segment while a held vowel alternates with uncertain frames', () => {
  const tracker = new VowelTracker();
  const uncertain: FormantEstimate = { valid: false, reason: 'uncertain', rms: 0.1, periodicity: 0.9 };
  let time = 0;
  tracker.push(measured(675, 1320), time += 25);
  const points = [];
  for (let i = 0; i < 40; i++) {
    const point = tracker.push(i % 2 ? uncertain : measured(675, 1320), time += 25).point;
    if (point) points.push(point);
  }
  expect(points).toHaveLength(20);
  expect(new Set(points.map((point) => point.segment)).size).toBe(1);
});

it('does not pair frames across silence, whether starting a sound or continuing one', () => {
  const quiet: FormantEstimate = { valid: false, reason: 'quiet', rms: 0, periodicity: 0 };
  const starting = new VowelTracker();
  starting.push(measured(300, 2300), 0);
  for (let time = 25; time <= 150; time += 25) starting.push(quiet, time);
  expect(starting.push(measured(320, 2200), 175).point).toBeNull();
  const continuing = new VowelTracker();
  continuing.push(measured(300, 2300), 0);
  continuing.push(measured(300, 2300), 25);
  for (let time = 50; time <= 150; time += 25) continuing.push(quiet, time);
  expect(continuing.push(measured(420, 1800), 175).point).toBeNull();
  expect(continuing.push(measured(420, 1800), 200).point).not.toBeNull();
});

it('requires the two agreeing frames of a new sound to be close together and in order', () => {
  const apart = new VowelTracker();
  apart.push(measured(400, 2000), 0);
  expect(apart.push(measured(400, 2000), 5000).point).toBeNull();
  const backwards = new VowelTracker();
  backwards.push(measured(400, 2000), 100);
  expect(backwards.push(measured(400, 2000), 50).point).toBeNull();
});

it('does not draw the first point of a sound until two frames agree', () => {
  const tracker = new VowelTracker();
  tracker.push(measured(370, 930), 0);
  expect(tracker.push(measured(905, 2800), 25).point).toBeNull();
  expect(tracker.push(measured(905, 2800), 50).point?.f1).toBeCloseTo(905);
});

it('requires two agreeing voiced frames to start and dampens small frame-to-frame jitter', () => {
  const tracker = new VowelTracker();
  expect(tracker.push(measured(400, 2000), 0).point).toBeNull();
  expect(tracker.push(measured(400, 2000), 20).point?.f1).toBeCloseTo(400);
  const point = tracker.push(measured(440, 2200), 40).point;
  expect(point?.f1).toBeGreaterThan(400);
  expect(point?.f1).toBeLessThan(420);
});
