import { expect, test } from '../../__tests__/harness';
import type { VoiceFrame, WordAttemptResult, ZoneResult } from '../../types';
import { GhostAttempt, isClose, sizeModel, unitWindow } from '../follow';
import { GHOST_WORD_LIST, ghostModel } from '../models';
import { chainUnits, partUnits, unitIsPractisable } from '../units';
import { validateGhostModel } from '../validate';
import { DEFAULT_FACTOR, anchorsConsistent, frontAnchorOk, vowelAnchor, voiceFactor } from '../voice';
import { GHOST_WORDS } from '../words';
import { learnerStream, type StreamOptions } from './streams';

const attemptOn = (word: string, unitId: string, opts: StreamOptions = {}, learnerFactor = 0, modelFactor = learnerFactor) => {
  const spec = GHOST_WORDS[word];
  const sized = sizeModel(ghostModel(word), modelFactor);
  const unit = [...partUnits(spec), ...chainUnits(spec)].find((u) => u.id === unitId || u.label === unitId)!;
  const attempt = new GhostAttempt(spec, sizeModel(ghostModel(word), learnerFactor), unit, 'a1');
  for (const frame of learnerStream(spec, sized, unit, opts)) attempt.push(frame);
  return { result: attempt.result ?? attempt.finish(), unit, attempt, spec };
};

const zone = (r: WordAttemptResult, id: string): ZoneResult => r.zones.find((z) => z.zoneId === id)!;

// ---- units ----

test('partUnits: one unit per part, for all four words', () => {
  for (const word of GHOST_WORD_LIST) {
    const spec = GHOST_WORDS[word];
    const units = partUnits(spec);
    expect(units.length, word).toBe(spec.parts.length);
    units.forEach((u, i) => {
      expect(u.id).toBe(spec.parts[i].id);
      expect(u.label).toBe(spec.parts[i].label);
      expect(u.zoneIds.join()).toBe(spec.parts[i].zoneIds.join());
      expect(u.partIds.join()).toBe(spec.parts[i].id);
    });
  }
});

test('chainUnits: track chains ck, ack, rack, track', () => {
  const units = chainUnits(GHOST_WORDS.track);
  expect(units.map((u) => u.label).join(',')).toBe('ck,ack,rack,track');
  expect(units[0].zoneIds.join()).toBe('k');
  expect(units[2].zoneIds.join()).toBe('r,a,k');
  expect(units[2].partIds.join()).toBe('tr,a,ck');
  expect(units[3].zoneIds.join()).toBe('t,r,a,k');
});

test('chainUnits: sheep, rent and brain chain backwards to the whole word', () => {
  expect(chainUnits(GHOST_WORDS.sheep).map((u) => u.label).join(',')).toBe('p,eep,sheep');
  expect(chainUnits(GHOST_WORDS.rent).map((u) => u.label).join(',')).toBe('t,nt,ent,rent');
  expect(chainUnits(GHOST_WORDS.brain).map((u) => u.label).join(',')).toBe('n,ain,rain,brain');
  for (const word of GHOST_WORD_LIST) {
    const spec = GHOST_WORDS[word];
    const all = chainUnits(spec).at(-1)!;
    expect(all.zoneIds.join(), word).toBe(spec.zones.map((z) => z.id).join());
    expect(all.partIds.join(), word).toBe(spec.parts.map((p) => p.id).join());
  }
});

test('unitIsPractisable: cue-only units are watch-only', () => {
  expect(unitIsPractisable(GHOST_WORDS.sheep, partUnits(GHOST_WORDS.sheep)[0])).toBe(false);
  expect(unitIsPractisable(GHOST_WORDS.brain, partUnits(GHOST_WORDS.brain)[2])).toBe(false);
  expect(unitIsPractisable(GHOST_WORDS.track, partUnits(GHOST_WORDS.track)[1])).toBe(true);
});

// ---- model contract ----

test('every model passes the contract validator', () => {
  for (const word of GHOST_WORD_LIST) {
    const problems = validateGhostModel(ghostModel(word), GHOST_WORDS[word]);
    expect(problems.join('; '), word).toBe('');
  }
});

test('validator catches broken models', () => {
  const spec = GHOST_WORDS.track;
  const good = ghostModel('track');
  const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
  const shortSpread = clone();
  shortSpread.segments[0].spread.pop();
  expect(validateGhostModel(shortSpread, spec).length).toBeGreaterThan(0);
  const backwards = clone();
  backwards.segments[0].points[3].t = 0;
  expect(validateGhostModel(backwards, spec).length).toBeGreaterThan(0);
  const gap = clone();
  gap.parts[1].t0 += 0.05;
  expect(validateGhostModel(gap, spec).length).toBeGreaterThan(0);
  const badZone = clone();
  badZone.markers[0].zoneId = 'zzz';
  expect(validateGhostModel(badZone, spec).length).toBeGreaterThan(0);
  const short = clone();
  short.parts[2].t1 = 0.9;
  expect(validateGhostModel(short, spec).length).toBeGreaterThan(0);
});

test('models: markers per consonant, only stops scored, path breaks at stops', () => {
  const track = ghostModel('track');
  expect(track.source).toBe('recorded');
  expect(ghostModel('rent').source).toBe('synthetic');
  expect(track.factor).toBe(0);
  expect(track.markers.map((m) => `${m.zoneId}:${m.kind}:${m.scored}`).join()).toBe('t:stop:true,r:liquid:false,k:stop:true');
  const rent = ghostModel('rent');
  expect(rent.markers.find((m) => m.zoneId === 'n')!.scored).toBe(false);
  expect(ghostModel('sheep').markers.find((m) => m.zoneId === 'sh')!.kind).toBe('fricative');
  // Spread is in ln units around the reference radii (0.1 to 0.2).
  for (const word of GHOST_WORD_LIST) {
    for (const s of ghostModel(word).segments) for (const v of s.spread) expect(v, word).toBeGreaterThan(0.1);
    for (const s of ghostModel(word).segments) for (const v of s.spread) expect(v, word).toBeLessThan(0.25);
  }
});

// ---- sizing ----

test('sizeModel shifts every point by exp(learner - model factor) and keeps the spread', () => {
  const m = ghostModel('sheep');
  const big = sizeModel(m, 0.1);
  expect(big.factor).toBe(0.1);
  expect(big.segments[0].points[5].f1 / m.segments[0].points[5].f1).toBeCloseTo(Math.exp(0.1), 1e-9);
  expect(big.segments[0].points[5].f2 / m.segments[0].points[5].f2).toBeCloseTo(Math.exp(0.1), 1e-9);
  expect(big.segments[0].spread[5]).toBe(m.segments[0].spread[5]);
  expect(m.factor).toBe(0);
});

test('unitWindow: part units use part edges; rack starts where voicing resumes', () => {
  const m = ghostModel('track');
  const units = chainUnits(GHOST_WORDS.track);
  const parts = partUnits(GHOST_WORDS.track);
  expect(unitWindow(m, parts[1])[0]).toBe(m.parts[1].t0);
  expect(unitWindow(m, parts[1])[1]).toBe(m.parts[1].t1);
  expect(unitWindow(m, units[3])[0]).toBe(0);
  expect(unitWindow(m, units[3])[1]).toBe(1);
  const rack = unitWindow(m, units[2]);
  expect(rack[0]).toBeCloseTo(m.segments[0].points[0].t, 1e-9);
  expect(rack[1]).toBe(1);
});

// ---- following ----

test('following the sized ghost gives hits across all four words (whole word)', () => {
  for (const word of GHOST_WORD_LIST) {
    const spec = GHOST_WORDS[word];
    const whole = chainUnits(spec).at(-1)!;
    const { result } = attemptOn(word, whole.id);
    expect(result.quality, word).toBe('usable');
    for (const z of result.zones) {
      const kind = spec.zones.find((s) => s.id === z.zoneId)!.kind;
      if (kind === 'vowel') {
        expect(z.verdict, `${word}/${z.zoneId}`).toBe('hit');
        expect(z.evidence.pathDistance, `${word}/${z.zoneId}`).toBeLessThan(0.3);
        expect(z.evidence.closeFraction).toBe(1);
      }
      if (kind === 'stop') expect(z.verdict, `${word}/${z.zoneId}`).toBe('hit');
    }
    expect(isClose(result, whole), word).toBe(true);
  }
});

test('following each part on its own gives hits', () => {
  for (const word of GHOST_WORD_LIST) {
    const spec = GHOST_WORDS[word];
    for (const unit of partUnits(spec)) {
      if (!unitIsPractisable(spec, unit)) continue;
      const { result } = attemptOn(word, unit.id);
      expect(result.quality, `${word}/${unit.id}`).toBe('usable');
      expect(isClose(result, unit), `${word}/${unit.id}`).toBe(true);
    }
  }
});

test('timing the same path slower or faster still follows it', () => {
  for (const pace of [0.7, 1.4]) {
    const { result, unit } = attemptOn('track', 'a', { pace });
    expect(zone(result, 'a').verdict, `pace ${pace}`).toBe('hit');
    expect(isClose(result, unit)).toBe(true);
  }
});

test('a path shifted by more than the spread is a miss', () => {
  const { result, unit } = attemptOn('track', 'a', { lnShift: 0.4 });
  const a = zone(result, 'a');
  expect(a.verdict).toBe('miss');
  expect(a.evidence.pathDistance).toBeGreaterThan(1.5);
  expect(a.evidence.closeFraction).toBeLessThan(0.5);
  expect(isClose(result, unit)).toBe(false);
});

test('a path just past the spread is partial, just inside is a hit', () => {
  const spread = ghostModel('sheep').segments[0].spread[10];
  const inside = attemptOn('sheep', 'ee', { lnShift: spread * 0.6, lnShift2: 0 }).result;
  expect(zone(inside, 'ee').verdict).toBe('hit');
  const near = attemptOn('sheep', 'ee', { lnShift: spread * 1.25, lnShift2: 0 }).result;
  expect(zone(near, 'ee').verdict).toBe('partial');
});

test('learner factor sizing: a shifted voice hits its own sized ghost and misses the unsized one', () => {
  const factor = 0.12;
  const sized = attemptOn('track', 'a', { lnShift: factor }, factor, 0).result;
  expect(zone(sized, 'a').verdict).toBe('hit');
  const unsized = attemptOn('track', 'a', { lnShift: factor }, 0, 0).result;
  expect(zone(unsized, 'a').evidence.pathDistance).toBeGreaterThan(zone(sized, 'a').evidence.pathDistance);
  const wrong = attemptOn('track', 'a', { lnShift: -0.2 }, 0, 0).result;
  expect(zone(wrong, 'a').verdict).toBe('miss');
});

// ---- stops ----

test('stop burst at the right place hits; no burst misses', () => {
  const hit = attemptOn('track', 'chain-t-r-a-k').result;
  expect(zone(hit, 't').verdict).toBe('hit');
  expect(zone(hit, 'k').verdict).toBe('hit');
  expect(zone(hit, 'k').evidence.burstDetected).toBe(1);
  expect(zone(hit, 'k').evidence.voicedBefore).toBe(1);
  const none = attemptOn('track', 'chain-t-r-a-k', { dropBursts: ['t', 'k'] }).result;
  expect(zone(none, 't').verdict).toBe('miss');
  expect(zone(none, 't').evidence.burstDetected).toBe(0);
  expect(zone(none, 't').evidence.burstMs).toBe(-1);
  expect(zone(none, 'k').verdict).toBe('miss');
  // The vowel is still judged by its path.
  expect(zone(none, 'a').verdict).toBe('hit');
});

test('onset stop: a burst long after voicing began is a miss; a burst just after is a hit', () => {
  const late = attemptOn('track', 'chain-t-r-a-k', { moveBurst: { t: 330 }, dropBursts: [] }).result;
  expect(zone(late, 't').verdict).toBe('miss');
  const slightly = attemptOn('brain', 'br', { moveBurst: { b: 60 } }).result;
  expect(zone(slightly, 'b').verdict).toBe('hit');
});

test('coda stop: a burst too long after the voice is a miss; a burst early in the vowel is a miss', () => {
  const far = attemptOn('track', 'ack', { moveBurst: { k: 600 } }).result;
  expect(zone(far, 'k').verdict).toBe('miss');
  const early = attemptOn('track', 'ack', { moveBurst: { k: -300 } }).result;
  expect(zone(early, 'k').verdict).toBe('miss');
});

test('a lone stop unit is judged by the burst alone', () => {
  const hit = attemptOn('sheep', 'p').result;
  expect(hit.quality).toBe('usable');
  expect(zone(hit, 'p').verdict).toBe('hit');
  expect(isClose(hit, partUnits(GHOST_WORDS.sheep)[2])).toBe(true);
  const spec = GHOST_WORDS.sheep;
  const silent = new GhostAttempt(spec, ghostModel('sheep'), partUnits(spec)[2], 'a2');
  expect(silent.finish().quality).toBe('unclear');
});

// ---- advisory and cue-only ----

test('fricatives and nasals are skipped and advisory; liquids are advisory but graded', () => {
  const sheep = attemptOn('sheep', 'chain-sh-ee-p').result;
  expect(zone(sheep, 'sh').verdict).toBe('skipped');
  expect(zone(sheep, 'sh').advisory).toBe(true);
  expect(Object.keys(zone(sheep, 'sh').evidence).length).toBe(0);

  const rent = attemptOn('rent', 'rent').result;
  expect(zone(rent, 'n').verdict).toBe('skipped');
  expect(zone(rent, 'n').advisory).toBe(true);
  expect(zone(rent, 'r').advisory).toBe(true);
  expect(zone(rent, 'r').verdict).toBe('hit');
  expect(zone(rent, 'e').advisory).toBe(undefined);
  expect(zone(rent, 't').advisory).toBe(undefined);

  // A bad r does not fail the attempt.
  const spec = GHOST_WORDS.rent;
  const unit = chainUnits(spec).at(-1)!;
  const sized = sizeModel(ghostModel('rent'), 0);
  const attempt = new GhostAttempt(spec, sized, unit, 'a3');
  const frames = learnerStream(spec, sized, unit).map((f): VoiceFrame =>
    f.voiced && f.timestampMs < 1000 + 70 ? { ...f, f1: f.f1! * 2, f2: f.f2! * 0.5 } : f,
  );
  for (const f of frames) attempt.push(f);
  const r = attempt.result!;
  expect(zone(r, 'r').verdict === 'hit').toBe(false);
  expect(zone(r, 'r').advisory).toBe(true);
  expect(isClose(r, unit)).toBe(true);
});

test('zones outside the unit are skipped with no evidence', () => {
  const { result } = attemptOn('track', 'a');
  for (const id of ['t', 'r', 'k']) {
    expect(zone(result, id).verdict, id).toBe('skipped');
    expect(Object.keys(zone(result, id).evidence).length, id).toBe(0);
    expect(zone(result, id).startMs, id).toBe(null);
  }
  expect(zone(result, 'a').verdict).toBe('hit');
  expect(result.zones.length).toBe(4);
  expect(result.word).toBe('track');
  expect(result.attemptId).toBe('a1');
});

// ---- quality and ending ----

test('silence and too little voice are unclear, never a miss', () => {
  const spec = GHOST_WORDS.track;
  const unit = partUnits(spec)[1];
  const model = ghostModel('track');
  const silent = new GhostAttempt(spec, model, unit, 's');
  expect(silent.finish().quality).toBe('unclear');
  expect(silent.result!.qualityReason).toBe('silence');
  expect(silent.result!.zones.every((z) => z.verdict === 'skipped')).toBe(true);

  const blip = new GhostAttempt(spec, model, unit, 'b');
  const frames = learnerStream(spec, model, unit).filter((f) => !f.voiced || f.timestampMs < 1030);
  for (const f of frames) blip.push(f);
  expect((blip.result ?? blip.finish()).quality).toBe('unclear');
  expect(blip.result!.qualityReason).toBe('no-voice');
  expect(blip.result!.zones.every((z) => z.verdict === 'skipped')).toBe(true);

  const clipped = new GhostAttempt(spec, model, unit, 'c');
  for (const f of learnerStream(spec, model, unit)) clipped.push({ ...f, clipped: true });
  expect((clipped.result ?? clipped.finish()).qualityReason).toBe('clipped');
});

test('the attempt ends about 600 ms after the voice stops, and by the cap otherwise', () => {
  const spec = GHOST_WORDS.track;
  const unit = partUnits(spec)[1];
  const attempt = new GhostAttempt(spec, ghostModel('track'), unit, 'e');
  const frames = learnerStream(spec, ghostModel('track'), unit, { tailMs: 2000 });
  let endedAt = -1;
  for (const f of frames) {
    attempt.push(f);
    if (attempt.done && endedAt < 0) endedAt = f.timestampMs;
  }
  const lastVoiced = frames.filter((f) => f.voiced).at(-1)!.timestampMs;
  expect(endedAt - lastVoiced).toBeGreaterThan(590);
  expect(endedAt - lastVoiced).toBeLessThan(650);

  // A long hold ends at 2.5x the natural duration (never below the floor).
  const hold = new GhostAttempt(spec, ghostModel('track'), unit, 'h');
  for (let i = 0; i < 400; i++) {
    hold.push({ timestampMs: 5000 + i * 10, rms: 0.1, periodicity: 0.9, voiced: true, f1: 700, f2: 1900, burst: false, clipped: false });
  }
  expect(hold.done).toBe(true);
  expect(hold.result!.durationMs).toBeLessThan(2000);
  // tick() ends it between frames.
  const waiting = new GhostAttempt(spec, ghostModel('track'), unit, 't');
  waiting.push({ timestampMs: 100, rms: 0.1, periodicity: 0.9, voiced: true, f1: 700, f2: 1900, burst: false, clipped: false });
  waiting.tick(900);
  expect(waiting.done).toBe(true);
});

test('result evidence carries the lip channel only when the camera was usable', () => {
  const spec = GHOST_WORDS.track;
  const unit = partUnits(spec)[1];
  const model = ghostModel('track');
  const attempt = new GhostAttempt(spec, model, unit, 'l');
  const lip = { ok: true, spread: 0.2, rounding: 0.1, lipOpening: 0.5, openness: 0.5 } as never;
  for (const f of learnerStream(spec, model, unit)) attempt.push(f, lip);
  const a = zone(attempt.result!, 'a');
  expect(attempt.result!.lipUsable).toBe(true);
  expect(a.evidence.spreadMean).toBeCloseTo(0.2, 1e-9);
  expect(a.evidence.pathDistance).toBeLessThan(0.3);
  const plain = attemptOn('track', 'a').result;
  expect(plain.lipUsable).toBe(false);
  expect('spreadMean' in zone(plain, 'a').evidence).toBe(false);
});

test('liveCloseness is high on the ghost and low far from it', () => {
  const near = attemptOn('track', 'a');
  expect(near.attempt.liveCloseness).toBeGreaterThan(0.9);
  const far = attemptOn('track', 'a', { lnShift: 0.5 });
  expect(far.attempt.liveCloseness).toBeLessThan(0.1);
});

test('snapshot reports stop circles as bursts land', () => {
  const spec = GHOST_WORDS.track;
  const unit = chainUnits(spec).at(-1)!;
  const model = ghostModel('track');
  const attempt = new GhostAttempt(spec, model, unit, 'snap');
  expect(attempt.snapshot().started).toBe(false);
  let sawT = false;
  for (const f of learnerStream(spec, model, unit)) {
    attempt.push(f);
    const s = attempt.snapshot();
    if (s.stops.t && !s.stops.k) sawT = true;
  }
  expect(sawT).toBe(true);
  expect(attempt.snapshot().stops.k).toBe(true);
});

// ---- voice factor ----

test('voiceFactor: uh + group, ok flag, default', () => {
  const uh = (f1: number, f2: number, n: number): VoiceFrame[] =>
    Array.from({ length: n }, (_, i) => ({ timestampMs: i * 25, rms: 0.1, periodicity: 0.9, voiced: true, f1, f2, burst: false, clipped: false }));
  // The reference "uh" for an adult man-sized voice is e^6.56143, e^7.2397.
  const ref = voiceFactor(uh(Math.exp(6.56143), Math.exp(7.2397), 20), 'woman');
  expect(ref.ok).toBe(true);
  expect(ref.factor).toBeCloseTo(0.0397 / 2, 1e-4);
  const big = voiceFactor(uh(Math.exp(6.56143 + 0.2), Math.exp(7.2397 + 0.2), 20), 'man');
  expect(big.factor).toBeCloseTo((0.2 - 0.13793) / 2, 1e-4);
  const short = voiceFactor(uh(500, 1500, 5), 'girl');
  expect(short.ok).toBe(false);
  expect(short.factor).toBe(DEFAULT_FACTOR);
  expect(typeof short.reason).toBe('string');
});

test('vowelAnchor: ln median in Hz, needs 12 formant frames, ignores frames without formants', () => {
  const frame = (f1?: number, f2?: number): VoiceFrame => ({ timestampMs: 0, rms: 0.1, periodicity: 0.9, voiced: true, f1, f2, burst: false, clipped: false });
  const good = Array.from({ length: 12 }, (_, i) => frame(300 + i, 2000));
  const anchor = vowelAnchor([...good, frame(), frame(undefined, 900)])!;
  expect(anchor.n).toBe(12);
  expect(anchor.f1).toBeCloseTo(Math.exp((Math.log(305) + Math.log(306)) / 2), 1e-6);
  expect(anchor.f2).toBeCloseTo(2000, 1e-6);
  expect(vowelAnchor(good.slice(0, 11))).toBe(null);
  expect(vowelAnchor([...good.slice(0, 11), frame()])).toBe(null);
});

test('anchorsConsistent: good set, swapped set, partial set', () => {
  const i = { f1: 300, f2: 2300, n: 40 };
  const a = { f1: 750, f2: 1200, n: 40 };
  const u = { f1: 320, f2: 800, n: 40 };
  expect(anchorsConsistent({ i, a, u })).toBe(true);
  expect(anchorsConsistent({ i: a, a: i, u })).toBe(false);
  expect(anchorsConsistent({ i, a: u, u: a })).toBe(false);
  expect(anchorsConsistent({ i: a, a: i })).toBe(true);
  expect(anchorsConsistent({})).toBe(true);
});

test('frontAnchorOk: eh and a sit below eee, a in front of ah; absent vowels pass', () => {
  const i = { f1: 300, f2: 2300, n: 40 };
  const a = { f1: 750, f2: 1200, n: 40 };
  const eh = { f1: 550, f2: 1850, n: 40 };
  const ae = { f1: 700, f2: 1650, n: 40 };
  expect(frontAnchorOk('eh', eh, { i, a })).toBe(true);
  expect(frontAnchorOk('ae', ae, { i, a })).toBe(true);
  expect(frontAnchorOk('eh', { f1: 280, f2: 2400, n: 40 }, { i, a })).toBe(false);
  expect(frontAnchorOk('ae', { f1: 700, f2: 1100, n: 40 }, { i, a })).toBe(false);
  expect(frontAnchorOk('eh', { f1: 700, f2: 1100, n: 40 }, { i, a })).toBe(true);
  expect(frontAnchorOk('ae', ae, { i })).toBe(true);
  expect(frontAnchorOk('ae', { f1: 700, f2: 1100, n: 40 }, { i })).toBe(true);
  expect(frontAnchorOk('eh', { f1: 280, f2: 1800, n: 40 }, { a })).toBe(true);
  expect(frontAnchorOk('ae', ae, {})).toBe(true);
});
