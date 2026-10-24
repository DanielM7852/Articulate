import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RejectionReason } from '../src/audio/estimator';
import type { TrackedFrame } from '../src/audio/tracker';
import { FIRST_BEATMAP, type Step } from '../src/game/beatmap';
import { buildZones, WarmUp, zoneFromPoints } from '../src/game/calibration';
import { GameRun } from '../src/game/run';
import { inZone, zoneDistance, zoneOutline, type Zone, type ZoneSet } from '../src/game/zones';

const HOP = 25;

const heard = (timestampMs: number, f1: number, f2: number): TrackedFrame => ({
  estimate: { valid: true, f1, f2, rms: 0.1, periodicity: 0.95, confidence: 0.85 },
  point: { f1, f2, timestampMs, segment: 0 },
  status: 'tracking',
  timestampMs,
});

const rejected = (timestampMs: number, reason: RejectionReason = 'unvoiced'): TrackedFrame => ({
  estimate: { valid: false, reason, rms: reason === 'quiet' ? 0 : 0.05, periodicity: 0.3 },
  point: null,
  status: reason,
  timestampMs,
});

/** Frames every hop from `from` (inclusive) to `to` (exclusive). */
function* span(from: number, to: number, make: (t: number) => TrackedFrame) {
  for (let t = from; t < to; t += HOP) yield make(t);
}

// A speaker whose vowels sit well away from textbook averages (higher F1 and F2).
const zones: ZoneSet = {
  ee: { vowel: 'ee', f1: 420, f2: 2800, radius: 0.22 },
  ah: { vowel: 'ah', f1: 900, f2: 1450, radius: 0.22 },
  oo: { vowel: 'oo', f1: 430, f2: 1000, radius: 0.22 },
};

const hold: Step = { id: 'ah', word: 'ah', segments: [{ letters: 'ah', sounds: ['ah'] }], note: { kind: 'hold', vowel: 'ah', holdMs: 700 } };
const we: Step = { id: 'we', word: 'we', segments: [{ letters: 'w', sounds: ['oo'] }, { letters: 'e', sounds: ['ee'] }], note: { kind: 'glide', from: 'oo', to: 'ee' } };

describe('zones', () => {
  const zone: Zone = { vowel: 'ee', f1: 400, f2: 2500, radius: 0.2 };

  it('measures distance in log-frequency space', () => {
    expect(zoneDistance({ f1: 400, f2: 2500 }, zone)).toBe(0);
    expect(zoneDistance({ f1: 400 * Math.E ** 0.1, f2: 2500 }, zone)).toBeCloseTo(0.1);
    expect(inZone({ f1: 400, f2: 2500 * 1.1 }, zone)).toBe(true);
    expect(inZone({ f1: 400, f2: 2500 * 1.4 }, zone)).toBe(false);
  });

  it('outlines the zone boundary for drawing on the linear plot', () => {
    const outline = zoneOutline(zone, 24);
    expect(outline).toHaveLength(24);
    for (const point of outline) expect(zoneDistance(point, zone)).toBeCloseTo(0.2);
  });
});

describe('calibration', () => {
  const at = (f1: number, f2: number, i: number) => ({ f1, f2, timestampMs: i * HOP, segment: 0 });

  it('centres a zone on the median of the player’s own points, ignoring a few strays', () => {
    const points = [
      ...Array.from({ length: 30 }, (_, i) => at(450 + (i % 3) * 10, 2900 + (i % 5) * 20, i)),
      at(900, 1200, 31), at(950, 1100, 32), // stray frames from a previous sound
    ];
    const result = zoneFromPoints('ee', points);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.zone.f1).toBeGreaterThan(445);
    expect(result.zone.f1).toBeLessThan(475);
    expect(result.zone.f2).toBeGreaterThan(2890);
    expect(result.zone.f2).toBeLessThan(2990);
    expect(result.zone.radius).toBeGreaterThanOrEqual(0.2);
    expect(result.zone.radius).toBeLessThanOrEqual(0.35);
  });

  it('reports too few points instead of inventing a zone', () => {
    const result = zoneFromPoints('oo', Array.from({ length: 5 }, (_, i) => at(400, 900, i)));
    expect(result).toMatchObject({ ok: false, problem: { kind: 'too-few-points', vowel: 'oo', count: 5 } });
  });

  it('shrinks neighbouring zones so they never overlap, and flags zones that sit on top of each other', () => {
    const steady = (f1: number, f2: number) => Array.from({ length: 30 }, (_, i) => at(f1, f2, i));
    const near = buildZones({ ee: steady(400, 2400), ah: steady(800, 1300), oo: steady(400, 1700) });
    expect(near.ok).toBe(true);
    if (near.ok) {
      const d = zoneDistance(near.zones.ee!, near.zones.oo!);
      expect(near.zones.ee!.radius + near.zones.oo!.radius).toBeLessThan(d);
    }
    const same = buildZones({ ee: steady(400, 2400), ah: steady(800, 1300), oo: steady(410, 2350) });
    expect(same).toMatchObject({ ok: false });
    if (!same.ok) expect(same.problems).toContainEqual({ kind: 'too-close', vowels: ['ee', 'oo'] });
  });
});

describe('warm-up', () => {
  const voice: Record<string, [number, number]> = { ee: [420, 2800], ah: [900, 1450], oo: [430, 1000] };

  it('walks through eee, ah and oo with rests, ignoring the first moments of each phase', () => {
    const warmUp = new WarmUp();
    let t = 0;
    let state = warmUp.push(rejected(t, 'quiet'));
    expect(state).toMatchObject({ kind: 'rest', next: 'ee' });
    const seen: string[] = [];
    while (state.kind !== 'done' && t < 60000) {
      t += HOP;
      // The player is still producing the previous vowel during the first 200 ms of each phase.
      const vowel = state.kind === 'collecting'
        ? (t - state.startedAtMs < 200 && seen.length > 1 ? seen.at(-2)! : state.vowel)
        : null;
      state = warmUp.push(vowel ? heard(t, ...voice[vowel]) : rejected(t, 'quiet'));
      if (state.kind === 'collecting' && seen.at(-1) !== state.vowel) seen.push(state.vowel);
    }
    expect(seen).toEqual(['ee', 'ah', 'oo']);
    expect(state.kind).toBe('done');
    if (state.kind !== 'done' || !state.result.ok) throw new Error('calibration failed');
    expect(state.result.zones.ah!.f1).toBeCloseTo(900);
    expect(state.result.zones.oo!.f2).toBeCloseTo(1000);
  });

  it('collects a separately requested personal zone without inventing the remaining vowels', () => {
    const warmUp = new WarmUp({ vowels: ['aw'], restMs: 0, settleMs: 0 });
    let state = warmUp.push(rejected(0, 'quiet'));
    expect(state).toMatchObject({ kind: 'collecting', vowel: 'aw' });
    for (let t = 25; state.kind !== 'done' && t < 10000; t += 25) state = warmUp.push(heard(t, 650, 1050));
    expect(state.kind).toBe('done');
    if (state.kind !== 'done' || !state.result.ok) throw new Error('personal aw zone not collected');
    expect(state.result.zones.aw?.f1).toBeCloseTo(650);
    expect(state.result.zones.ah).toBeUndefined();
  });

  it('times out a phase that hears too little and asks for a redo', () => {
    const warmUp = new WarmUp();
    let state = warmUp.push(rejected(0, 'quiet'));
    let t = 0;
    while (state.kind !== 'done' && t < 60000) {
      t += HOP;
      // Only ah is ever heard; ee and oo are lost to noise.
      const vowel = state.kind === 'collecting' && state.vowel === 'ah' ? 'ah' : null;
      state = warmUp.push(vowel ? heard(t, ...voice.ah) : rejected(t, 'unvoiced'));
    }
    expect(state.kind).toBe('done');
    if (state.kind !== 'done') return;
    expect(state.result.ok).toBe(false);
    if (state.result.ok) return;
    expect(state.result.problems.map((p) => p.kind === 'too-few-points' && p.vowel)).toEqual(['ee', 'oo']);
  });
});

describe('game run: self-paced (default)', () => {
  const play = (run: GameRun, frames: Iterable<TrackedFrame>) => {
    let snapshot = run.snapshot();
    for (const frame of frames) snapshot = run.push(frame);
    return snapshot;
  };

  it('rejects a run with missing personal zones before listening', () => {
    expect(() => new GameRun([we], { ee: zones.ee })).toThrow('Missing personal zone: oo');
  });

  it('keeps waiting through room noise until an accepted vowel or an explicit attempt', () => {
    const run = new GameRun([we], zones);
    let snapshot = play(run, span(0, 30000, (t) => rejected(t, 'unvoiced')));
    expect(snapshot.notes[0].status).toBe('waiting');
    expect(snapshot.notes[0].outcome).toBeUndefined();
    run.beginAttempt(30000);
    snapshot = play(run, span(30025, 34000, (t) => rejected(t, 'unvoiced')));
    expect(snapshot.notes[0].outcome).toBe('unheard');
  });

  it('never awards a hit before the required amount of accepted audio, even if both endpoints were visited', () => {
    const run = new GameRun([we], zones, { minHeardPoints: 5 });
    const snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      heard(1000, 430, 1000), heard(1025, 430, 1000),
      heard(1050, 420, 2800), heard(1075, 420, 2800),
      ...span(1100, 5000, (t) => rejected(t, 'quiet')),
    ]);
    expect(snapshot.notes[0].outcome).toBe('unheard');
  });

  it('scores a glide that visits the start zone and then the end zone as a hit', () => {
    const run = new GameRun([we], zones);
    const snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      ...span(1000, 1300, (t) => heard(t, 430, 1000)),
      ...span(1300, 1400, (t) => heard(t, 430, 1800)), // in between: not judged
      ...span(1400, 1600, (t) => heard(t, 420, 2800)),
    ]);
    expect(snapshot.notes[0].outcome).toBe('hit');
    expect(snapshot.phase).toBe('finished');
    expect(snapshot.tally).toEqual({ hit: 1, miss: 0, unheard: 0 });
  });

  it('scores a glide in the wrong direction as a miss', () => {
    const run = new GameRun([we], zones);
    const snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      ...span(1000, 1400, (t) => heard(t, 420, 2800)),
      ...span(1400, 1800, (t) => heard(t, 430, 1000)),
      ...span(1800, 6000, (t) => rejected(t, 'quiet')),
    ]);
    expect(snapshot.notes[0].outcome).toBe('miss');
  });

  it('never counts rejected frames as a miss: no accepted points means "not heard clearly"', () => {
    const run = new GameRun([we], zones);
    play(run, span(0, 1000, (t) => rejected(t, 'quiet')));
    run.beginAttempt(1000);
    const snapshot = play(run, span(1000, 8000, (t) => rejected(t, t % 50 ? 'unvoiced' : 'uncertain')));
    expect(snapshot.notes[0].outcome).toBe('unheard');
    expect(snapshot.tally).toEqual({ hit: 0, miss: 0, unheard: 1 });
  });

  it('treats a couple of stray accepted points as "not heard clearly", not a miss', () => {
    const run = new GameRun([we], zones);
    const snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      ...span(1000, 8000, (t) => (t === 1500 || t === 1525 ? heard(t, 700, 2000) : rejected(t))),
    ]);
    expect(snapshot.notes[0].outcome).toBe('unheard');
  });

  it('waits for the player while the room is quiet, then opens the window at voice onset', () => {
    const run = new GameRun([we], zones);
    let snapshot = play(run, span(0, 30000, (t) => rejected(t, 'quiet')));
    expect(snapshot.notes[0].outcome).toBeUndefined();
    expect(snapshot.notes[0].status).toBe('waiting');
    snapshot = play(run, [heard(30000, 430, 1000)]);
    expect(snapshot.notes[0]).toMatchObject({ status: 'open', windowStartMs: 30000 });
    expect(snapshot.notes[0].windowEndMs).toBeGreaterThan(30000 + 2000);
  });

  it('holds: a steady sound in the zone for the hold time is a hit, even with short rejected gaps', () => {
    const run = new GameRun([hold], zones);
    const snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      // Every third frame is rejected, as in a noisy room.
      ...span(1000, 1800, (t) => ((t / HOP) % 3 === 0 ? rejected(t) : heard(t, 900, 1450))),
    ]);
    expect(snapshot.notes[0].outcome).toBe('hit');
  });

  it('holds: leaving the zone restarts the hold, and a hold never completed is a miss', () => {
    const run = new GameRun([hold], zones);
    const frames: TrackedFrame[] = [...span(0, 1000, (t) => rejected(t, 'quiet'))];
    // 500 ms in the zone, a step outside, 500 ms in the zone, repeated until the window ends.
    for (let t = 1000; t < 8000; t += HOP) frames.push((t - 1000) % 525 === 500 ? heard(t, 450, 2600) : heard(t, 900, 1450));
    expect(play(run, frames).notes[0].outcome).toBe('miss');
  });

  it('moves to the next word after a short rest and finishes with a tally', () => {
    const run = new GameRun([hold, we], zones);
    let snapshot = play(run, [
      ...span(0, 1000, (t) => rejected(t, 'quiet')),
      ...span(1000, 1800, (t) => heard(t, 900, 1450)),
    ]);
    expect(snapshot.current).toBe(1);
    expect(snapshot.notes[1].status).toBe('resting');
    play(run, span(1800, 3500, (t) => rejected(t, 'quiet')));
    run.beginAttempt(3500);
    snapshot = play(run, span(3500, 9000, (t) => rejected(t)));
    expect(snapshot.phase).toBe('finished');
    expect(snapshot.tally).toEqual({ hit: 1, miss: 0, unheard: 1 });
  });
});

describe('game run: timed', () => {
  const timed = { pacing: { kind: 'timed', spacingMs: 4000 } } as const;

  it('shows an approach before the window, ignores sound before it, and allows pipeline latency at the end', () => {
    const run = new GameRun([we], zones, timed);
    let snapshot = run.push(rejected(0, 'quiet'));
    const note = snapshot.notes[0];
    expect(note.targetMs).toBeGreaterThan(0);
    expect(note.status).toBe('approaching');
    // A perfect glide well before the window opens does not count.
    for (let t = HOP; t < note.windowStartMs - 100; t += HOP) snapshot = run.push(heard(t, t < note.windowStartMs / 2 ? 430 : 420, t < note.windowStartMs / 2 ? 1000 : 2800));
    expect(snapshot.notes[0].outcome).toBeUndefined();
    // The player starts oo late; ee lands 200 ms after the nominal end, inside the latency allowance.
    const end = note.targetMs + run.options.windowMs.glide;
    for (let t = note.windowStartMs - 100; t < end - 300; t += HOP) snapshot = run.push(rejected(t, 'quiet'));
    for (let t = end - 300; t < end + 150; t += HOP) snapshot = run.push(heard(t, 430, 1000));
    for (let t = end + 150; t < end + 250; t += HOP) snapshot = run.push(heard(t, 420, 2800));
    expect(snapshot.notes[0].outcome).toBe('hit');
  });

  it('always gives the next visible note a full approach, even after a late result at the faster tempo', () => {
    const run = new GameRun([hold, we], zones, { pacing: { kind: 'timed', spacingMs: 3500 } });
    let snapshot = run.push(rejected(0, 'quiet'));
    const end = snapshot.notes[0].windowEndMs;
    for (let t = 25; t <= end + 25; t += 25) snapshot = run.push(rejected(t, 'quiet'));
    expect(snapshot.notes[0].outcome).toBe('unheard');
    expect(snapshot.notes[1].targetMs - snapshot.timeMs).toBeGreaterThanOrEqual(run.options.approachMs);
    expect(snapshot.notes[1].heardPoints).toBe(0);
  });

  it('preserves the chosen minimum spacing after a delayed note followed by an early hit', () => {
    const run = new GameRun([hold, hold, hold], zones, { pacing: { kind: 'timed', spacingMs: 3500 } });
    let snapshot = run.push(rejected(0, 'quiet'));
    const firstEnd = snapshot.notes[0].windowEndMs;
    for (let t = 25; t <= firstEnd + 25; t += 25) snapshot = run.push(rejected(t, 'quiet'));
    const secondStart = snapshot.notes[1].windowStartMs;
    for (let t = firstEnd + 50; t < secondStart; t += 25) snapshot = run.push(rejected(t, 'quiet'));
    for (let t = secondStart; t <= secondStart + 700; t += 25) snapshot = run.push(heard(t, 900, 1450));
    expect(snapshot.notes[1].outcome).toBe('hit');
    expect(snapshot.notes[2].targetMs - snapshot.notes[1].targetMs).toBeGreaterThanOrEqual(3500);
  });

  it('gives each note its own slot at the chosen spacing', () => {
    const run = new GameRun([hold, we], zones, timed);
    const snapshot = run.push(rejected(0, 'quiet'));
    expect(snapshot.notes[1].targetMs - snapshot.notes[0].targetMs).toBe(4000);
  });
});

describe('first beatmap', () => {
  it('judges only vowels and glides, avoids n and m, and has at most one hold', () => {
    expect(FIRST_BEATMAP.map((step) => step.word)).toEqual(expect.arrayContaining(['we', 'hi', 'how']));
    expect(FIRST_BEATMAP.filter((step) => step.note.kind === 'hold').length).toBeLessThanOrEqual(1);
    for (const step of FIRST_BEATMAP) {
      expect(step.word).not.toMatch(/[nm]/i);
      expect(step.segments.map((s) => s.letters).join('')).toBe(step.word);
      for (const segment of step.segments) expect(Boolean(segment.cue) !== Boolean(segment.sounds?.length)).toBe(true);
    }
    const glides = Object.fromEntries(FIRST_BEATMAP.filter((s) => s.note.kind === 'glide').map((s) => [s.word, s.note]));
    expect(glides).toMatchObject({ we: { from: 'oo', to: 'ee' }, hi: { from: 'ah', to: 'ee' }, how: { from: 'ah', to: 'oo' } });
  });
});

describe('product boundaries in game source', () => {
  const dir = new URL('../src/game/', import.meta.url);
  const sources = readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')] as const);

  it('makes no pronunciation, clinical or therapeutic claims', () => {
    for (const [name, text] of sources) expect(text, name).not.toMatch(/pronounc|correct|accura|therap|clinic|diagnos|speech score/i);
  });

  it('makes no network calls and stores nothing', () => {
    for (const [name, text] of sources) expect(text, name).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB|MediaRecorder/);
  });
});
