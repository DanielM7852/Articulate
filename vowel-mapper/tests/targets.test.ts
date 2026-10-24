import { describe, expect, it } from 'vitest';
import type { TrackedFrame } from '../src/audio/tracker';
import { REFERENCE_V1 } from '../src/reference/data';
import {
  CHECK_PROMPTS, TargetRound, VoiceCheck, coachSummary, ringFor, targetDistance,
  type TargetStep, type VoiceProfile,
} from '../src/game/targets';

const HOP = 25;
type Ref = keyof typeof REFERENCE_V1.means;

const heard = (timestampMs: number, f1: number, f2: number): TrackedFrame => ({
  estimate: { valid: true, f1, f2, rms: 0.1, periodicity: 0.95, confidence: 0.85 },
  point: { f1, f2, timestampMs, segment: 0 },
  status: 'tracking',
  timestampMs,
});
const silent = (timestampMs: number): TrackedFrame => ({
  estimate: { valid: false, reason: 'quiet', rms: 0, periodicity: 0 },
  point: null,
  status: 'quiet',
  timestampMs,
});

/** The reference centre for `vowel`, every formant times `scale`, F1 moved by `radii` reference radii. */
const at = (vowel: Ref, scale = 1, radii = 0) => ({
  f1: Math.exp(REFERENCE_V1.means[vowel][0]) * scale * (vowel === 'iy' || vowel === 'ah' ? Math.exp(radii * REFERENCE_V1.radius[vowel][0]) : 1),
  f2: Math.exp(REFERENCE_V1.means[vowel][1]) * scale,
});

/** Drive a voice check where each prompt is answered by `answer(index)` (null = silence). */
function runCheck(check: VoiceCheck, answer: (index: number) => { f1: number; f2: number } | null) {
  let t = 0, state = check.push(silent(t));
  while (state.kind !== 'done' && t < 120_000) {
    t += HOP;
    const value = state.kind === 'collecting' ? answer(state.index) : null;
    state = check.push(value ? heard(t, value.f1, value.f2) : silent(t));
  }
  return state;
}

const profile = (over: Partial<VoiceProfile> = {}): VoiceProfile => ({
  version: 1, factor: Math.log(1.2), place: 'quiet', measuredAt: 0,
  start: { ee: at('iy', 1.2, 1.2), ah: at('ah', 1.2, 0.8) }, ...over,
});

const step = (sound: 'ee' | 'ah'): TargetStep => ({ word: sound === 'ee' ? 'see' : 'spa', sound, letters: ['s', sound, ''] });

/** Self-paced round: hold `value` for `ms` per note, with a rest between notes. */
function play(round: TargetRound, values: ({ f1: number; f2: number } | null)[], ms = 1200) {
  let t = 0, snap = round.push(silent(t));
  for (const value of values) {
    while (snap.current !== null && snap.notes[snap.current].status !== 'waiting') { t += HOP; snap = round.push(silent(t)); }
    if (!value) snap = round.beginAttempt();
    const end = t + ms;
    while (t < end && snap.phase !== 'finished') { t += HOP; snap = round.push(value ? heard(t, value.f1, value.f2) : silent(t)); }
    while (snap.current !== null && snap.notes[snap.current].status === 'open') { t += HOP; snap = round.push(silent(t)); }
  }
  return snap;
}

describe('voice-sized targets', () => {
  it('grades distance into three rings, closest first', () => {
    expect([0, 0.5, 0.51, 1, 1.4, 1.5, 1.6].map(ringFor)).toEqual([1, 1, 2, 2, 3, 3, null]);
  });

  it('measures ee and ah against the reference scaled by the voice multiplier', () => {
    expect(targetDistance(at('iy', 1.2), 'ee', Math.log(1.2))).toBeCloseTo(0, 6);
    expect(targetDistance(at('ah', 0.8, 1), 'ah', Math.log(0.8))).toBeCloseTo(1, 6);
  });
});

describe('voice check', () => {
  it('asks head, had, heard, then a starting ee and ah', () => {
    expect(CHECK_PROMPTS.map((p) => p.word)).toEqual(['head', 'had', 'heard', 'see', 'spa']);
  });

  it('sets the multiplier from head/had/heard only and keeps ee/ah as the start', () => {
    const check = new VoiceCheck('noisy');
    // ee and ah are far from the reference; they must not move the multiplier.
    const state = runCheck(check, (i) => i < 3 ? at(CHECK_PROMPTS[i].ref, 1.2) : at(CHECK_PROMPTS[i].ref, 1.2, 2));
    expect(state.kind).toBe('done');
    if (state.kind !== 'done' || !state.ok) throw new Error('check failed');
    expect(state.profile.factor).toBeCloseTo(Math.log(1.2), 6);
    expect(state.profile.place).toBe('noisy');
    expect(targetDistance(state.profile.start.ee!, 'ee', state.profile.factor)).toBeCloseTo(2, 6);
  });

  it('fails and names the calibration words it could not hear', () => {
    const state = runCheck(new VoiceCheck('quiet'), (i) => i === 1 ? null : at(CHECK_PROMPTS[i].ref));
    expect(state).toMatchObject({ kind: 'done', ok: false, missed: ['had'] });
  });

  it('still succeeds without a starting ee or ah', () => {
    const state = runCheck(new VoiceCheck('quiet'), (i) => i >= 3 ? null : at(CHECK_PROMPTS[i].ref));
    if (state.kind !== 'done' || !state.ok) throw new Error('check failed');
    expect(state.profile.start).toEqual({});
  });
});

describe('target round', () => {
  it('scores each held vowel by ring and compares it with the start', () => {
    const snap = play(new TargetRound([step('ee'), step('ah')], profile()), [at('iy', 1.2, 0.3), at('ah', 1.2, 1.4)]);
    expect(snap.phase).toBe('finished');
    expect(snap.notes[0]).toMatchObject({ outcome: 'measured', ring: 1, trend: 'closer' });
    expect(snap.notes[0].distance).toBeCloseTo(0.3, 2);
    expect(snap.notes[1]).toMatchObject({ outcome: 'measured', ring: 3, trend: 'farther' });
  });

  it('says "similar" for a change under the coach threshold, and gives no trend without a start', () => {
    const similar = play(new TargetRound([step('ee')], profile()), [at('iy', 1.2, 1.15)]);
    expect(similar.notes[0].trend).toBe('similar');
    const noStart = play(new TargetRound([step('ee')], profile({ start: {} })), [at('iy', 1.2, 0.2)]);
    expect(noStart.notes[0].trend).toBeUndefined();
  });

  it('does not score ee in a noisy room, but still scores ah', () => {
    const snap = play(new TargetRound([step('ee'), step('ah')], profile({ place: 'noisy' })), [at('iy', 1.2, 3), at('ah', 1.2)]);
    expect(snap.notes[0]).toMatchObject({ outcome: 'unscored' });
    expect(snap.notes[0].ring).toBeUndefined();
    expect(snap.notes[0].trend).toBeUndefined();
    expect(snap.notes[1]).toMatchObject({ outcome: 'measured', ring: 1 });
  });

  it('counts a silent attempt as not heard clearly', () => {
    const snap = play(new TargetRound([step('ah')], profile()), [null], 3500);
    expect(snap.notes[0].outcome).toBe('unheard');
  });

  it('never opens an attempt on silence alone', () => {
    const round = new TargetRound([step('ah')], profile());
    let snap = round.push(silent(0));
    for (let t = HOP; t < 5000; t += HOP) snap = round.push(silent(t));
    expect(snap.notes[0].status).toBe('waiting');
  });
});

describe('coach summary', () => {
  it('sends the voice-sized distance as target version 2', () => {
    const snap = play(new TargetRound([step('ah')], profile()), [at('ah', 1.2, 0.5)]);
    const summary = coachSummary(snap.notes[0], step('ah'));
    expect(summary).toMatchObject({ target_id: 'aa', target_version: 2, evidence_fields: ['target_distance', 'f1_mean', 'f2_mean'], quality_flags: [] });
    expect(summary.target_distance).toBeCloseTo(0.5, 2);
    expect(summary.f1_mean).toBeCloseTo(at('ah', 1.2, 0.5).f1, 3);
  });

  it('withholds the distance for ee in a noisy room and for unheard attempts', () => {
    const noisy = play(new TargetRound([step('ee')], profile({ place: 'noisy' })), [at('iy', 1.2)]);
    expect(coachSummary(noisy.notes[0], step('ee'))).toMatchObject({ target_id: 'i', target_distance: null, quality_flags: ['noisy-room'], evidence_fields: ['f1_mean', 'f2_mean'] });
    const silentNote = play(new TargetRound([step('ah')], profile()), [null], 3500);
    expect(coachSummary(silentNote.notes[0], step('ah'))).toMatchObject({ target_distance: null, f1_mean: null, quality_flags: ['not-heard-clearly'], evidence_fields: [] });
  });
});
