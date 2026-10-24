import type { TrackedFrame } from '../audio/tracker';
import type { Step } from './beatmap';
import { inZone, type ZoneSet } from './zones';

/** "unheard" is shown as "not heard clearly" and is never counted as a miss. */
export type Outcome = 'hit' | 'miss' | 'unheard';

/**
 * Self-paced: each note waits for the player, and its window opens at voice onset.
 * Timed: notes arrive at a fixed spacing, with a visual approach ring. Neither uses audio cues.
 */
export type Pacing = { kind: 'self' } | { kind: 'timed'; spacingMs: number };

export interface GameOptions {
  pacing: Pacing;
  /** Time to complete each note once its window opens. */
  windowMs: { glide: number; hold: number };
  /** Extra time at the end of every window for capture, analysis and smoothing delay (estimated 100–200 ms). */
  latencyMs: number;
  /** Timed: the window opens this long before the ring closes. */
  earlyMs: number;
  /** Timed: how long the approach ring takes to close. */
  approachMs: number;
  /** Delay before the first note. */
  leadInMs: number;
  /** Self-paced: pause after each outcome, so the result can be read. */
  restMs: number;
  /** Fewer accepted points than this in a window means "not heard clearly", not a miss. */
  minHeardPoints: number;
  /** Accepted points needed inside a zone to count as reaching it. */
  minZonePoints: number;
  /** Longest gap of rejected frames that still continues a hold. */
  holdGapMs: number;
}

export const GAME_DEFAULTS: GameOptions = {
  pacing: { kind: 'self' },
  windowMs: { glide: 2500, hold: 2500 },
  latencyMs: 250,
  earlyMs: 200,
  approachMs: 2000,
  leadInMs: 600,
  restMs: 900,
  minHeardPoints: 3,
  minZonePoints: 2,
  holdGapMs: 200,
};

export type NoteStatus =
  | 'upcoming' // later in the map
  | 'resting' // self-paced: about to be offered
  | 'waiting' // self-paced: offered, waiting for the player's voice
  | 'approaching' // timed: approach ring closing
  | 'open' // window open, being judged
  | 'resolved';

export interface NoteState {
  index: number;
  status: NoteStatus;
  outcome?: Outcome;
  /** Timed: when the approach ring closes. Self-paced: when the note is offered. */
  targetMs: number;
  windowStartMs: number;
  windowEndMs: number;
  /** Accepted points seen inside the window. */
  heardPoints: number;
  /** Glide: points in the start and end zones. Hold: the current in-zone run. */
  fromPoints: number;
  toPoints: number;
  heldMs: number;
}

export interface GameSnapshot {
  phase: 'ready' | 'playing' | 'finished';
  timeMs: number;
  /** First note without an outcome, or null when finished. */
  current: number | null;
  notes: NoteState[];
  tally: Record<Outcome, number>;
}

/** Note state machine and hit detection over the tracker's frame stream. Pure: no clock of its own. */
export class GameRun {
  readonly options: GameOptions;
  private originMs: number | null = null;
  private timeMs = 0;
  private readonly notes: NoteState[];
  /** Per note: timestamp of the last in-zone point of the current hold run. */
  private readonly lastHoldMs: (number | null)[] = [];

  constructor(readonly steps: Step[], readonly zones: ZoneSet, options: Partial<GameOptions> = {}) {
    this.options = { ...GAME_DEFAULTS, ...options };
    this.notes = steps.map((_, index) => ({
      index, status: 'upcoming', targetMs: NaN, windowStartMs: NaN, windowEndMs: NaN,
      heardPoints: 0, fromPoints: 0, toPoints: 0, heldMs: 0,
    }));
  }

  snapshot(): GameSnapshot {
    const tally: Record<Outcome, number> = { hit: 0, miss: 0, unheard: 0 };
    for (const note of this.notes) if (note.outcome) tally[note.outcome]++;
    const current = this.notes.findIndex((note) => !note.outcome);
    return {
      phase: this.originMs === null ? 'ready' : current < 0 ? 'finished' : 'playing',
      timeMs: this.timeMs,
      current: current < 0 ? null : current,
      notes: this.notes.map((note) => ({ ...note })),
      tally,
    };
  }

  push(frame: TrackedFrame): GameSnapshot {
    const t = frame.timestampMs;
    if (this.originMs === null) this.start(t);
    this.timeMs = t;
    for (const note of this.notes) this.advance(note, frame);
    return this.snapshot();
  }

  private start(t: number) {
    this.originMs = t;
    const { pacing, leadInMs, earlyMs, latencyMs } = this.options;
    if (pacing.kind === 'timed') {
      const lead = Math.max(leadInMs, this.options.approachMs);
      this.notes.forEach((note, i) => {
        note.targetMs = t + lead + i * pacing.spacingMs;
        note.windowStartMs = note.targetMs - earlyMs;
        note.windowEndMs = note.targetMs + this.windowFor(i) + latencyMs;
      });
    } else if (this.notes.length) {
      this.notes[0].status = 'resting';
      this.notes[0].targetMs = t + leadInMs;
    }
  }

  private windowFor(index: number) {
    return this.options.windowMs[this.steps[index].note.kind];
  }

  private advance(note: NoteState, frame: TrackedFrame) {
    const t = frame.timestampMs;
    const { pacing, approachMs, latencyMs } = this.options;
    if (note.status === 'resolved') return;
    if (pacing.kind === 'timed') {
      if (note.status === 'upcoming' && t >= note.targetMs - approachMs) note.status = 'approaching';
      if (note.status !== 'open' && t >= note.windowStartMs) note.status = 'open';
    } else {
      if (note.status === 'resting' && t >= note.targetMs) note.status = 'waiting';
      // The window opens at the first frame with any sound, accepted or not.
      if (note.status === 'waiting' && frame.status !== 'quiet') {
        note.status = 'open';
        note.windowStartMs = t;
        note.windowEndMs = t + this.windowFor(note.index) + latencyMs;
      }
    }
    if (note.status !== 'open') return;
    if (t > note.windowEndMs) {
      this.resolve(note, note.heardPoints < this.options.minHeardPoints ? 'unheard' : 'miss', t);
      return;
    }
    if (frame.status === 'tracking' && frame.point) {
      note.heardPoints++;
      if (this.judge(note, frame.point)) this.resolve(note, 'hit', t);
    }
  }

  private judge(note: NoteState, point: { f1: number; f2: number; timestampMs: number }): boolean {
    const spec = this.steps[note.index].note;
    const { minZonePoints, holdGapMs } = this.options;
    if (spec.kind === 'glide') {
      if (note.fromPoints < minZonePoints) {
        if (inZone(point, this.zones[spec.from])) note.fromPoints++;
        return false;
      }
      if (inZone(point, this.zones[spec.to])) note.toPoints++;
      return note.toPoints >= minZonePoints;
    }
    if (!inZone(point, this.zones[spec.vowel])) {
      note.heldMs = 0;
      this.lastHoldMs[note.index] = null;
      return false;
    }
    const last = this.lastHoldMs[note.index] ?? null;
    if (last !== null && point.timestampMs - last <= holdGapMs) note.heldMs += point.timestampMs - last;
    else note.heldMs = 0;
    this.lastHoldMs[note.index] = point.timestampMs;
    return note.heldMs >= spec.holdMs;
  }

  private resolve(note: NoteState, outcome: Outcome, t: number) {
    note.status = 'resolved';
    note.outcome = outcome;
    const next = this.notes[note.index + 1];
    if (next && this.options.pacing.kind === 'self') {
      next.status = 'resting';
      next.targetMs = t + this.options.restMs;
    }
  }
}
