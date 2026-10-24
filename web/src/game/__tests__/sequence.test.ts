import type { LipFrame } from '../../vision/lipTelemetry';
import type { WordAttemptResult } from '../types';
import { TRACK } from '../words';
import { WordAttempt } from '../sequence';
import { SCORING, assessQuality, loudnessFromRms, median, vowelDistance, vowelVerdict } from '../scoring';
import { demoAt, demoSegments } from '../demo';
import { AE, R_FLAT, R_GOOD, goodTrack, render, type Segment } from './frames';
import { expect, test } from './harness';

function play(segments: Segment[], lip: LipFrame | null = null, stepMs?: number): { attempt: WordAttempt; result: WordAttemptResult } {
  const attempt = new WordAttempt(TRACK, 'test');
  for (const frame of render(segments, 1000, stepMs)) attempt.push(frame, lip);
  const result = attempt.result ?? attempt.finish();
  return { attempt, result };
}

const verdicts = (r: WordAttemptResult) => r.zones.map((z) => z.verdict).join(' ');
const zone = (r: WordAttemptResult, id: string) => r.zones.find((z) => z.zoneId === id)!;

const LIP: LipFrame = {
  t: 0, ok: true, flags: [], lipOpening: 0.3, outerLipHeight: 0, lipWidth: 0, lipAspectRatio: 0, lipProtrusionZ: 0,
  jawDrop: 0, mouthSymmetry: 0, innerMouthArea: 0, rounding: 0.1, spread: 0.6, openness: 0.5, yawDeg: 0, pitchDeg: 0, rollDeg: 0,
};

test('good "track": every zone hits and the attempt ends on the final burst', () => {
  const { result } = play(goodTrack());
  expect(verdicts(result)).toBe('hit hit hit hit');
  expect(result.quality).toBe('usable');
  expect(result.qualityReason).toBe(undefined);
  expect(result.word).toBe('track');
  expect(result.attemptId).toBe('test');
  // Starts at the t burst (1200), ends at the k burst (1200 + 10 + 40 + 280 + 320 + 80 = 1930).
  expect(result.durationMs).toBe(730);
  const t = zone(result, 't');
  expect(t.evidence.burstDetected).toBe(1);
  expect(t.evidence.burstMs).toBe(0);
  expect(t.evidence.voicedBefore).toBe(0);
  const r = zone(result, 'r');
  expect(r.dwellMs >= 250, 'r dwell').toBeTruthy();
  expect(r.evidence.valueMedian).toBe(350);
  expect(r.evidence.inBandFraction).toBe(1);
  const a = zone(result, 'a');
  expect(a.dwellMs >= 220, 'a dwell').toBeTruthy();
  expect(a.evidence.f1Median).toBe(720);
  expect(a.evidence.f2Median).toBe(1850);
  expect(a.evidence.f1Offset).toBe(0);
  expect(a.evidence.inTargetFraction).toBeGreaterThan(0.5);
  const k = zone(result, 'k');
  expect(k.evidence.burstDetected).toBe(1);
  expect(k.evidence.burstMs).toBe(730);
  expect(k.evidence.voicedBefore).toBe(1);
  expect(k.endMs).toBe(730);
  expect(result.lipUsable).toBe(false);
  expect('spreadMean' in a.evidence).toBe(false);
});

test('missing final k: k is a miss, attempt ends after 700 ms of silence', () => {
  const segments = goodTrack().filter((s, i, all) => !(s.kind === 'burst' && i === all.length - 2));
  const { result } = play(segments);
  expect(verdicts(result)).toBe('hit hit hit miss');
  const k = zone(result, 'k');
  expect(k.evidence.burstDetected).toBe(0);
  expect(k.evidence.burstMs).toBe(-1);
  // Last voiced frame at 1200+10+40+600-10 = 1840 relative 640; +700 silence.
  expect(result.durationMs).toBe(640 + SCORING.endSilenceMs);
  expect(result.quality).toBe('usable');
});

test('flat r (f3gap 900): r misses, the vowel after it still hits', () => {
  const segments: Segment[] = [
    { kind: 'silence', ms: 200 },
    { kind: 'burst' },
    { kind: 'noise', ms: 40 },
    { kind: 'voice', ms: 280, ...R_FLAT },
    { kind: 'voice', ms: 320, ...AE },
    { kind: 'silence', ms: 80 },
    { kind: 'burst' },
    { kind: 'silence', ms: 900 },
  ];
  const { result } = play(segments);
  expect(verdicts(result)).toBe('hit miss hit hit');
  const r = zone(result, 'r');
  expect(r.evidence.inBandFraction).toBe(0);
  expect(r.evidence.valueMedian).toBe(900);
  expect(r.dwellMs).toBe(0);
  expect(r.evidence.valueBest).toBe(900);
  // The vowel takes over from its first in-target frame (1530, the burst was at 1200).
  expect(zone(result, 'a').startMs).toBe(330);
});

test('silent attempt: everything skipped, quality unclear (silence)', () => {
  const { result } = play([{ kind: 'silence', ms: SCORING.startTimeoutMs + 200 }]);
  expect(verdicts(result)).toBe('skipped skipped skipped skipped');
  expect(result.quality).toBe('unclear');
  expect(result.qualityReason).toBe('silence');
  expect(result.durationMs).toBe(0);
  expect(zone(result, 't').startMs).toBe(null);
  expect(zone(result, 'k').evidence.burstMs).toBe(-1);
});

test('no frames at all: finish() marks everything skipped', () => {
  const attempt = new WordAttempt(TRACK, 'none');
  const result = attempt.finish();
  expect(verdicts(result)).toBe('skipped skipped skipped skipped');
  expect(result.qualityReason).toBe('silence');
});

test('t without a burst: voicing starts, t misses after the grace, r still scores', () => {
  const { result } = play([
    { kind: 'silence', ms: 200 },
    { kind: 'voice', ms: 300, ...R_GOOD },
    { kind: 'voice', ms: 320, ...AE },
    { kind: 'silence', ms: 80 },
    { kind: 'burst' },
    { kind: 'silence', ms: 900 },
  ]);
  expect(verdicts(result)).toBe('miss hit hit hit');
  expect(zone(result, 't').evidence.voicedBefore).toBe(1);
  expect(zone(result, 't').evidence.burstDetected).toBe(0);
});

test('vowel off target but near: partial; far: miss', () => {
  const near = play([
    { kind: 'burst' }, { kind: 'noise', ms: 40 },
    { kind: 'voice', ms: 280, ...R_GOOD },
    // 1.15 radii out along F2 (outside, within 1.3).
    { kind: 'voice', ms: 320, f1: 720, f2: 1850 + 320 * 1.15, f3: 2900 },
    { kind: 'silence', ms: 80 }, { kind: 'burst' }, { kind: 'silence', ms: 100 },
  ]).result;
  expect(verdicts(near)).toBe('hit hit partial hit');
  expect(near.zones[2].evidence.inTargetFraction).toBe(0);
  const far = play([
    { kind: 'burst' }, { kind: 'noise', ms: 40 },
    { kind: 'voice', ms: 280, ...R_GOOD },
    { kind: 'voice', ms: 320, f1: 400, f2: 2500, f3: 3000 },
    { kind: 'silence', ms: 80 }, { kind: 'burst' }, { kind: 'silence', ms: 100 },
  ]).result;
  expect(verdicts(far)).toBe('hit hit miss hit');
  expect(far.zones[2].evidence.f2Offset).toBeCloseTo(Math.log(2500 / 1850), 1e-3);
});

test('short r that dips into the band: partial, and hands the vowel its frames', () => {
  const { result } = play([
    { kind: 'burst' }, { kind: 'noise', ms: 40 },
    { kind: 'voice', ms: 60, ...R_FLAT },
    { kind: 'voice', ms: 120, ...R_GOOD },
    { kind: 'voice', ms: 320, ...AE },
    { kind: 'silence', ms: 80 }, { kind: 'burst' }, { kind: 'silence', ms: 100 },
  ]);
  expect(verdicts(result)).toBe('hit partial hit hit');
  expect(zone(result, 'r').evidence.inBandFraction).toBeGreaterThan(0);
});

test('clipped capture is flagged unclear', () => {
  const segments = goodTrack().map((s) => (s.kind === 'voice' ? { ...s, clipped: true } : s));
  const { result } = play(segments);
  expect(result.quality).toBe('unclear');
  expect(result.qualityReason).toBe('clipped');
});

test('too few voiced frames is no-voice; a burst-only blip is too short or no-voice', () => {
  const { result } = play([{ kind: 'burst' }, { kind: 'voice', ms: 50, ...AE }, { kind: 'silence', ms: 4000 }]);
  expect(result.quality).toBe('unclear');
  expect(result.qualityReason).toBe('no-voice');
  expect(assessQuality({ started: true, totalFrames: 20, voicedFrames: 20, clippedFrames: 0, durationMs: 200 }).qualityReason).toBe('too-short');
});

test('attempt is capped at 2.5 x pace', () => {
  const { result } = play([{ kind: 'burst' }, { kind: 'noise', ms: 40 }, { kind: 'voice', ms: 5000, ...R_FLAT }]);
  expect(result.durationMs).toBe(SCORING.maxDurationFactor * TRACK.paceMs);
  expect(zone(result, 'k').verdict).toBe('skipped');
});

test('lip means are reported when the camera was usable', () => {
  const { result } = play(goodTrack(), LIP);
  expect(result.lipUsable).toBe(true);
  const a = zone(result, 'a');
  expect(a.evidence.spreadMean).toBe(0.6);
  expect(a.evidence.roundingMean).toBe(0.1);
  expect(a.evidence.lipOpeningMean).toBe(0.3);
});

test('results are produced once; pushes after the end are ignored', () => {
  const attempt = new WordAttempt(TRACK, 'once');
  const frames = render(goodTrack());
  for (const f of frames) attempt.push(f);
  const first = attempt.result;
  attempt.push({ ...frames[0], timestampMs: 99999, burst: true });
  expect(attempt.result === first).toBe(true);
  expect(attempt.snapshot().done).toBe(true);
});

test('tick() ends a stalled attempt by silence without new frames', () => {
  const attempt = new WordAttempt(TRACK, 'tick');
  const frames = render(goodTrack().slice(0, 5));
  for (const f of frames) attempt.push(f);
  expect(attempt.done).toBe(false);
  attempt.tick(frames.at(-1)!.timestampMs + SCORING.endSilenceMs + 10);
  expect(attempt.done).toBe(true);
  expect(verdicts(attempt.result!)).toBe('hit hit hit miss');
});

test('scoring helpers', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
  expect(median([])).toBe(null);
  expect(loudnessFromRms(0)).toBe(0);
  expect(loudnessFromRms(1)).toBe(1);
  expect(loudnessFromRms(0.05)).toBeGreaterThan(loudnessFromRms(0.005));
  expect(vowelDistance({ f1: 720, f2: 1850 + 320 }, TRACK.zones[2].vowel!)).toBeCloseTo(1, 1e-9);
  expect(vowelVerdict({ dwellMs: 10, holdMs: 220, f1Median: 0, f2Median: 0, target: TRACK.zones[2].vowel! })).toBe('partial');
});

test('demo walks t -> r -> a -> ck in order, needle lands in the band, then rests', () => {
  const segs = demoSegments(TRACK);
  expect(segs.at(-1)!.end).toBeCloseTo(TRACK.paceMs, 1e-6);
  const mid = (i: number) => (segs[i].start + segs[i].end) / 2;
  expect(demoAt(TRACK, mid(0)).activeIndex).toBe(0);
  const r = demoAt(TRACK, segs[1].end - 1);
  expect(r.activeIndex).toBe(1);
  expect(r.needle! <= 600, 'needle in band').toBeTruthy();
  const a = demoAt(TRACK, segs[2].end - 1);
  expect(a.activeIndex).toBe(2);
  expect(vowelDistance(a.ghost!, TRACK.zones[2].vowel!)).toBeLessThan(0.05);
  expect(a.statuses.join(' ')).toBe('hit hit active upcoming');
  expect(demoAt(TRACK, segs[3].end - 1).releasedIndex).toBe(3);
  const rest = demoAt(TRACK, TRACK.paceMs + 100);
  expect(rest.activeIndex).toBe(-1);
  expect(demoAt(TRACK, TRACK.paceMs + 1000).loop).toBe(1);
});

test('the same scenarios hold at the real 25 ms frame rate', () => {
  expect(verdicts(play(goodTrack(), null, 25).result)).toBe('hit hit hit hit');
  const noK = goodTrack().filter((s, i, all) => !(s.kind === 'burst' && i === all.length - 2));
  expect(verdicts(play(noK, null, 25).result)).toBe('hit hit hit miss');
  const flat = goodTrack().map((s) => (s.kind === 'voice' && s.f1 === R_GOOD.f1 ? { ...s, ...R_FLAT } : s));
  expect(verdicts(play(flat, null, 25).result)).toBe('hit miss hit hit');
  const silent = play([{ kind: 'silence', ms: SCORING.startTimeoutMs + 200 }], null, 25).result;
  expect(verdicts(silent)).toBe('skipped skipped skipped skipped');
  expect(play(goodTrack(), null, 25).result.quality).toBe('usable');
});
