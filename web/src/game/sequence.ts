import type { LipFrame } from '../vision/lipTelemetry';
import type { VoiceFrame, WordAttemptResult, WordSpec, WordZone, ZoneResult, ZoneVerdict } from './types';
import {
  LipAccumulator,
  SCORING,
  assessQuality,
  clamp,
  f3gap,
  inBand,
  insideVowel,
  median,
  round4,
  smoothToward,
  tunerVerdict,
  vowelVerdict,
} from './scoring';

/**
 * Live sequencing for one word attempt. Pure and clock-free: every decision uses
 * VoiceFrame timestamps, so a synthetic frame stream replays deterministically.
 *
 *   const attempt = new WordAttempt(TRACK, 'a1');
 *   attempt.push(frame, lip);   // every analysis frame, voiced or not
 *   attempt.tick(nowMs);        // optional, frame clock: lets silence and timeouts end it between frames
 *   attempt.result;             // WordAttemptResult once done, else null
 *
 * Zones run strictly in order. A zone can hand the frames it buffered to the next zone
 * when it resolves (a stop that waited for a late burst, a tuner that saw the vowel
 * start), so a short or flat sound never eats the sound after it.
 * ZoneResult.startMs / endMs and the stop burstMs are relative to the attempt start.
 */
export type ZoneStatus = 'upcoming' | 'active' | ZoneVerdict;

export interface AttemptSnapshot {
  started: boolean;
  done: boolean;
  /** The zone the learner is on; 0 before the attempt starts; -1 once done. */
  activeIndex: number;
  statuses: ZoneStatus[];
  /** Release bursts credited to each zone (a stop chip flashes when its count changes). */
  bursts: number[];
}

interface Item {
  frame: VoiceFrame;
  lip: LipFrame | null;
  /** Dwell credit of this frame (capped gap to the previous frame). */
  dt: number;
  /** First voiced frame after unvoiced frames, or the attempt's first frame when voiced. */
  onset: boolean;
}

interface Handoff {
  verdict: ZoneVerdict;
  /** Items the next zone should see, in order. */
  replay: Item[];
}

class ZoneRun {
  status: ZoneStatus = 'upcoming';
  startMs: number | null = null;
  endMs: number | null = null;
  dwellMs = 0;
  readonly lip = new LipAccumulator();
  hadVoice = false;
  lastVoicedMs: number | null = null;
  // vowel
  f1s: number[] = [];
  f2s: number[] = [];
  formantFrames = 0;
  insideFrames = 0;
  // tuner
  /** Every f3 frame the tuner saw; frames later handed to the next zone are excluded from its evidence. */
  samples: { item: Item; value: number; needle: number; inBand: boolean }[] = [];
  handedOff = new Set<Item>();
  needle: number | null = null;
  needleMs: number | null = null;
  windowStart: number | null = null;
  entered = false;
  outSince: number | null = null;
  outBuf: Item[] = [];
  lookStart: number | null = null;
  lookBuf: Item[] = [];
  // stop
  bursts = 0;
  burstMs = -1;
  voicedBefore = false;
  graceStart: number | null = null;
  graceBuf: Item[] = [];

  constructor(readonly zone: WordZone) {}
}

export class WordAttempt {
  private readonly runs: ZoneRun[];
  private active = -1;
  private armedAt: number | null = null;
  private startMs: number | null = null;
  private prevTs: number | null = null;
  private prevVoiced = false;
  private lastVoicedMs: number | null = null;
  private lastBurstMs: number | null = null;
  private totalFrames = 0;
  private voicedFrames = 0;
  private clippedFrames = 0;
  private readonly lip = new LipAccumulator();
  result: WordAttemptResult | null = null;

  constructor(readonly spec: WordSpec, readonly attemptId: string) {
    this.runs = spec.zones.map((zone) => new ZoneRun(zone));
  }

  get started() {
    return this.startMs !== null;
  }

  get done() {
    return this.result !== null;
  }

  /** Frame-clock time of the attempt start, or null before it starts. */
  get startedAt() {
    return this.startMs;
  }

  snapshot(): AttemptSnapshot {
    const statuses = this.runs.map((run) => run.status);
    if (!this.started && !this.done && statuses.length) statuses[0] = 'active';
    return {
      started: this.started,
      done: this.done,
      activeIndex: this.done ? -1 : Math.max(0, this.active),
      statuses,
      bursts: this.runs.map((run) => run.bursts),
    };
  }

  /** 0..1 hold progress of the active vowel or tuner zone. */
  progress() {
    const run = this.runs[this.active];
    if (!run || this.done || run.zone.holdMs <= 0) return 0;
    return clamp(run.dwellMs / run.zone.holdMs, 0, 1);
  }

  /** Smoothed tuner value (Hz) of the active tuner zone, or null. */
  needle() {
    const run = this.runs[this.active];
    return run && run.zone.kind === 'tuner' && !this.done ? run.needle : null;
  }

  push(frame: VoiceFrame, lip: LipFrame | null = null) {
    if (this.done) return;
    const ts = frame.timestampMs;
    if (this.armedAt === null) this.armedAt = ts;
    const dt = this.prevTs === null ? 0 : clamp(ts - this.prevTs, 0, SCORING.maxFrameDtMs);
    this.prevTs = ts;

    let first = false;
    if (!this.started) {
      if (!frame.voiced && !frame.burst) {
        this.prevVoiced = false;
        this.checkEnd(ts);
        return;
      }
      this.startMs = ts;
      first = true;
      this.activate(0, ts);
    }

    this.totalFrames++;
    if (frame.voiced) {
      this.voicedFrames++;
      this.lastVoicedMs = ts;
    }
    if (frame.clipped) this.clippedFrames++;
    this.lip.add(lip);
    const onset = frame.voiced && (first || !this.prevVoiced);
    this.prevVoiced = frame.voiced;

    this.feed({ frame, lip, dt, onset });
    this.checkEnd(ts);
  }

  /** Let time-based endings fire without a new frame. `nowMs` is in the frame clock. */
  tick(nowMs: number) {
    if (!this.done) this.checkEnd(nowMs);
  }

  /** Force the attempt to end now (e.g. no frames arrived at all). */
  finish(nowMs?: number): WordAttemptResult {
    return this.end(nowMs ?? this.prevTs ?? this.startMs ?? 0);
  }

  private activate(index: number, ts: number) {
    this.active = index;
    const run = this.runs[index];
    if (!run) return;
    run.status = 'active';
    run.startMs = ts;
  }

  private feed(item: Item) {
    const queue: Item[] = [item];
    while (queue.length && !this.done) {
      const run = this.runs[this.active];
      if (!run) return;
      const next = queue.shift()!;
      run.lip.add(next.lip);
      const out = this.handle(run, next);
      if (!out) continue;
      // Hand-offs move the boundary back to the first frame the next zone takes over.
      const ts = out.replay.length ? out.replay[0].frame.timestampMs : next.frame.timestampMs;
      this.resolve(run, out.verdict, ts);
      for (const handed of out.replay) run.handedOff.add(handed);
      if (this.active + 1 >= this.runs.length) {
        this.end(ts);
        return;
      }
      this.activate(this.active + 1, ts);
      queue.unshift(...out.replay);
    }
  }

  private resolve(run: ZoneRun, verdict: ZoneVerdict, ts: number) {
    run.status = verdict;
    run.endMs = ts;
  }

  private nextZone(): WordZone | undefined {
    return this.runs[this.active + 1]?.zone;
  }

  /** A burst ends a vowel/tuner zone (and passes on to the stop after it), unless it echoes one just consumed. */
  private burstEnds(item: Item) {
    if (!item.frame.burst) return false;
    const echo = this.lastBurstMs !== null && item.frame.timestampMs - this.lastBurstMs < SCORING.burstMinZoneMs;
    return !echo && this.nextZone()?.kind === 'stop';
  }

  private handle(run: ZoneRun, item: Item): Handoff | null {
    switch (run.zone.kind) {
      case 'stop':
        return this.handleStop(run, item);
      case 'tuner':
        return this.handleTuner(run, item);
      case 'vowel':
        return this.handleVowel(run, item);
      default:
        // liquid / fricative / nasal zones belong to the ghost-path engine, never to this sequencer.
        return null;
    }
  }

  private handleStop(run: ZoneRun, item: Item): Handoff | null {
    const { frame } = item;
    const ts = frame.timestampMs;
    if (frame.burst) {
      run.bursts++;
      run.burstMs = Math.round(ts - this.startMs!);
      this.lastBurstMs = ts;
      return { verdict: 'hit', replay: [] };
    }
    if (run.graceStart !== null) {
      run.graceBuf.push(item);
      if (ts - run.graceStart > SCORING.stopGraceMs) return { verdict: 'miss', replay: run.graceBuf };
      return null;
    }
    if (frame.voiced) {
      run.voicedBefore = true;
      // Voicing begins without a release: wait a short grace for a late burst, then move on.
      if (item.onset) {
        run.graceStart = ts;
        run.graceBuf = [item];
      }
    }
    return null;
  }

  private markVoice(run: ZoneRun, item: Item) {
    if (!item.frame.voiced) return;
    run.hadVoice = true;
    run.lastVoicedMs = item.frame.timestampMs;
  }

  private gapEnds(run: ZoneRun, item: Item) {
    return !item.frame.voiced && run.hadVoice && run.lastVoicedMs !== null
      && item.frame.timestampMs - run.lastVoicedMs >= SCORING.voiceGapMs;
  }

  private tunerVerdict(run: ZoneRun) {
    return tunerVerdict({ dwellMs: run.dwellMs, holdMs: run.zone.holdMs, enteredBand: run.entered });
  }

  private handleTuner(run: ZoneRun, item: Item): Handoff | null {
    const { frame } = item;
    const ts = frame.timestampMs;
    const target = run.zone.tuner!;
    if (this.burstEnds(item)) return { verdict: this.tunerVerdict(run), replay: [item] };
    this.markVoice(run, item);
    if (frame.voiced && run.windowStart === null) run.windowStart = ts;

    const value = f3gap(frame);
    if (value !== null) {
      run.needle = smoothToward(run.needle, value, run.needleMs === null ? 0 : ts - run.needleMs, SCORING.needleTauMs);
      run.needleMs = ts;
      const needle = run.needle;
      const inside = inBand(needle, target);
      run.samples.push({ item, value, needle, inBand: inside });
      if (inside) {
        run.dwellMs += item.dt;
        run.entered = true;
        run.outSince = null;
        run.outBuf = [];
      } else if (run.entered) {
        run.outSince ??= ts;
        run.outBuf.push(item);
      }
      if (run.dwellMs >= run.zone.holdMs) return { verdict: 'hit', replay: [] };

      // The next vowel has started: hand over the frames that already sit in its target.
      const next = this.nextZone();
      if (next?.kind === 'vowel' && !inside && frame.f1 !== undefined && frame.f2 !== undefined
        && insideVowel({ f1: frame.f1, f2: frame.f2 }, next.vowel!)) {
        run.lookStart ??= ts;
        run.lookBuf.push(item);
        if (ts - run.lookStart >= SCORING.lookaheadMs) return { verdict: this.tunerVerdict(run), replay: run.lookBuf };
      } else {
        run.lookStart = null;
        run.lookBuf = [];
      }
      // Entered the band, then left it for good: the sound has moved on.
      if (run.outSince !== null && ts - run.outSince >= SCORING.tunerExitMs) {
        return { verdict: this.tunerVerdict(run), replay: run.outBuf };
      }
    }
    if (run.windowStart !== null && ts - run.windowStart >= SCORING.tunerWindowMs) return { verdict: this.tunerVerdict(run), replay: [] };
    if (this.gapEnds(run, item)) return { verdict: this.tunerVerdict(run), replay: [item] };
    return null;
  }

  private vowelVerdict(run: ZoneRun) {
    return vowelVerdict({
      dwellMs: run.dwellMs,
      holdMs: run.zone.holdMs,
      f1Median: median(run.f1s),
      f2Median: median(run.f2s),
      target: run.zone.vowel!,
    });
  }

  private handleVowel(run: ZoneRun, item: Item): Handoff | null {
    const { frame } = item;
    if (this.burstEnds(item)) return { verdict: this.vowelVerdict(run), replay: [item] };
    this.markVoice(run, item);
    if (frame.voiced && frame.f1 !== undefined && frame.f2 !== undefined) {
      run.f1s.push(frame.f1);
      run.f2s.push(frame.f2);
      run.formantFrames++;
      if (insideVowel({ f1: frame.f1, f2: frame.f2 }, run.zone.vowel!)) {
        run.insideFrames++;
        run.dwellMs += item.dt;
      }
      if (run.dwellMs >= run.zone.holdMs) return { verdict: 'hit', replay: [] };
    }
    if (this.gapEnds(run, item)) return { verdict: this.vowelVerdict(run), replay: [item] };
    return null;
  }

  private checkEnd(ts: number) {
    if (this.done) return;
    if (!this.started) {
      if (this.armedAt !== null && ts - this.armedAt >= SCORING.startTimeoutMs) this.end(ts);
      return;
    }
    const start = this.startMs!;
    const maxMs = SCORING.maxDurationFactor * this.spec.paceMs;
    if (ts - start >= maxMs) {
      this.end(start + maxMs);
      return;
    }
    const resolved = this.runs.filter((run) => run.status !== 'upcoming' && run.status !== 'active').length;
    if (resolved >= SCORING.endSilenceMinResolved && this.lastVoicedMs !== null && ts - this.lastVoicedMs >= SCORING.endSilenceMs) {
      this.end(ts);
    }
  }

  private end(ts: number): WordAttemptResult {
    if (this.result) return this.result;
    for (const run of this.runs) {
      if (run.status === 'active' && this.started) {
        // The zone the learner was on when time ran out: score what it saw.
        const verdict = run.zone.kind === 'vowel' ? this.vowelVerdict(run) : run.zone.kind === 'tuner' ? this.tunerVerdict(run) : 'miss';
        this.resolve(run, verdict, ts);
      } else if (run.status === 'upcoming' || run.status === 'active') {
        run.status = 'skipped';
        run.startMs = null;
        run.endMs = null;
      }
    }
    this.active = -1;
    const durationMs = this.started ? Math.max(0, Math.round(ts - this.startMs!)) : 0;
    this.result = {
      word: this.spec.word,
      attemptId: this.attemptId,
      durationMs,
      zones: this.runs.map((run) => this.zoneResult(run)),
      ...assessQuality({
        started: this.started,
        totalFrames: this.totalFrames,
        voicedFrames: this.voicedFrames,
        clippedFrames: this.clippedFrames,
        durationMs,
      }),
      lipUsable: this.lip.usable,
    };
    return this.result;
  }

  private rel(ms: number | null) {
    return ms === null || this.startMs === null ? null : Math.round(ms - this.startMs);
  }

  private zoneResult(run: ZoneRun): ZoneResult {
    const { zone } = run;
    const evidence: Record<string, number> = {};
    if (zone.kind === 'vowel') {
      const f1 = median(run.f1s);
      const f2 = median(run.f2s);
      if (f1 !== null && f2 !== null) {
        evidence.f1Median = Math.round(f1);
        evidence.f2Median = Math.round(f2);
        evidence.f1Offset = round4(Math.log(f1 / zone.vowel!.f1));
        evidence.f2Offset = round4(Math.log(f2 / zone.vowel!.f2));
      }
      evidence.inTargetFraction = run.formantFrames ? round4(run.insideFrames / run.formantFrames) : 0;
    } else if (zone.kind === 'tuner') {
      const own = run.samples.filter((sample) => !run.handedOff.has(sample.item));
      const value = median(own.map((sample) => sample.value));
      if (value !== null) evidence.valueMedian = Math.round(value);
      if (own.length) {
        const needles = own.map((sample) => sample.needle);
        evidence.valueBest = Math.round(zone.tuner!.pushTo === 'low' ? Math.min(...needles) : Math.max(...needles));
      }
      evidence.inBandFraction = own.length ? round4(own.filter((sample) => sample.inBand).length / own.length) : 0;
    } else {
      evidence.burstDetected = run.burstMs >= 0 ? 1 : 0;
      evidence.burstMs = run.burstMs;
      evidence.voicedBefore = run.voicedBefore ? 1 : 0;
    }
    if (run.status !== 'skipped') Object.assign(evidence, run.lip.evidence());
    return {
      zoneId: zone.id,
      phoneme: zone.phoneme,
      kind: zone.kind,
      verdict: run.status as ZoneVerdict,
      dwellMs: zone.kind === 'stop' ? 0 : Math.round(run.dwellMs),
      startMs: this.rel(run.startMs),
      endMs: this.rel(run.endMs),
      evidence,
    };
  }
}
