import type { LipFrame } from '../../vision/lipTelemetry';
import { LipAccumulator, clamp, lipOk, round4 } from '../scoring';
import type { VoiceFrame, WordAttemptResult, ZoneKind, ZoneResult, ZoneVerdict } from '../types';
import type { GhostPathModel, GhostSegment, GhostUnit } from './types';
import type { GhostWordSpec, GhostZoneSpec } from './words';

/**
 * Ghost-path following. Pure and clock-free: every decision uses VoiceFrame timestamps, so a
 * synthetic frame stream replays deterministically (see GhostAttempt).
 *
 * Judging, per the product rules:
 *  - vowels and liquids: how closely the learner's F1/F2 path follows the sized ghost; liquids advisory
 *  - stops: a detected release burst at the right place in the word, never place of articulation
 *  - fricatives and nasals: cue-only, skipped and advisory
 */

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

export const FOLLOW = {
  /** Points the learner path and the ghost sub-path are both resampled to (Karsten's PATH_POINTS in head.ts; see voice.ts for why it is not imported). */
  pathPoints: 12,
  /** Mean path distance, in close-zone units, that still counts as inside / close. */
  hitDistance: 1,
  partialDistance: 1.5,
  /** The attempt ends this long after the last voiced frame or burst, once the learner has been heard. */
  endSilenceMs: 600,
  /** Hard cap as a multiple of the unit's natural duration, never below the floor. */
  maxDurationFactor: 2.5,
  maxDurationFloorMs: 1200,
  /** Onset stop: a burst up to this long after the first voiced frame still counts. */
  onsetBurstAfterVoiceMs: 150,
  /** Coda stop: the burst must follow the last voiced frame within this long (and not precede it by more than the slack). */
  codaBurstWithinMs: 400,
  codaBurstSlackMs: 50,
  /** Live stop circles fill for a coda burst only once voicing has stayed off for this long. */
  codaLiveConfirmMs: 100,
  /** A liquid owns this much of the word each side of its marker. */
  liquidHalfMs: 45,
  /** Fewer valid voiced frames than this cannot be compared with a path. */
  minValidFrames: 5,
  minVoicedSpanMs: 80,
  maxClippedFraction: 0.2,
  /** liveCloseness: 1 at or inside the close zone, fading to 0 at this many close-zone units. */
  closenessFarDistance: 2.5,
  closenessTauFrames: 4,
} as const;

const ADVISORY: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['liquid', 'fricative', 'nasal']);
const PATH_KINDS: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['vowel', 'liquid']);

// ---------------------------------------------------------------------------------------------
// Sizing and geometry
// ---------------------------------------------------------------------------------------------

/** The model drawn for a learner: one log shift by the difference between the two voice factors. */
export function sizeModel(model: GhostPathModel, learnerFactor: number): GhostPathModel {
  const scale = Math.exp(learnerFactor - model.factor);
  return {
    ...model,
    factor: learnerFactor,
    segments: model.segments.map((segment) => ({
      points: segment.points.map((p) => ({ t: p.t, f1: p.f1 * scale, f2: p.f2 * scale })),
      spread: [...segment.spread],
    })),
  };
}

export interface GhostSample {
  f1: number;
  f2: number;
  /** Close-zone radius, ln units. */
  spread: number;
  /** False in the gaps between voiced segments (the dot rests at the nearest segment end). */
  voiced: boolean;
}

/** The ghost at word time t: linear in log Hz inside a segment, clamped to the nearest segment end in a gap. */
export function ghostAt(model: GhostPathModel, t: number): GhostSample {
  let nearest: { seg: GhostSegment; index: number; gap: number } | null = null;
  for (const seg of model.segments) {
    const first = seg.points[0];
    const last = seg.points[seg.points.length - 1];
    if (t >= first.t && t <= last.t) {
      let i = 0;
      while (i < seg.points.length - 2 && seg.points[i + 1].t < t) i++;
      const a = seg.points[i];
      const b = seg.points[i + 1];
      const w = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
      return {
        f1: Math.exp(Math.log(a.f1) + w * Math.log(b.f1 / a.f1)),
        f2: Math.exp(Math.log(a.f2) + w * Math.log(b.f2 / a.f2)),
        spread: seg.spread[i] + w * (seg.spread[i + 1] - seg.spread[i]),
        voiced: true,
      };
    }
    const atStart = Math.abs(t - first.t);
    const atEnd = Math.abs(t - last.t);
    const gap = Math.min(atStart, atEnd);
    if (!nearest || gap < nearest.gap) nearest = { seg, index: atStart <= atEnd ? 0 : seg.points.length - 1, gap };
  }
  const p = nearest!.seg.points[nearest!.index];
  return { f1: p.f1, f2: p.f2, spread: nearest!.seg.spread[nearest!.index], voiced: false };
}

function markerOf(model: GhostPathModel, zoneId: string) {
  return model.markers.find((m) => m.zoneId === zoneId);
}

/** [t0, t1] of a unit in word time. Part-aligned units use the part edges; a unit that starts mid-part starts where voicing resumes. */
export function unitWindow(model: GhostPathModel, unit: GhostUnit): [number, number] {
  const part = (zoneId: string) => model.parts.find((p) => p.zoneIds.includes(zoneId));
  const firstId = unit.zoneIds[0];
  const lastId = unit.zoneIds[unit.zoneIds.length - 1];
  const firstPart = part(firstId);
  const lastPart = part(lastId);
  if (!firstPart || !lastPart) return [0, 1];
  let t0 = firstPart.t0;
  const excluded = firstPart.zoneIds.slice(0, firstPart.zoneIds.indexOf(firstId)).filter((id) => !unit.zoneIds.includes(id));
  if (excluded.length) {
    const cut = markerOf(model, excluded[excluded.length - 1])?.t;
    if (cut !== undefined) {
      const resumes = model.segments.map((s) => s.points[0].t).filter((t) => t >= cut - 1e-6).sort((a, b) => a - b)[0];
      t0 = Math.min(firstPart.t1, resumes ?? cut);
    }
  }
  return [t0, lastPart.t1];
}

export function unitDurationMs(model: GhostPathModel, unit: GhostUnit): number {
  const [t0, t1] = unitWindow(model, unit);
  return (t1 - t0) * model.durationMs;
}

/** The voiced pieces of the ghost inside the unit, for drawing the highlighted stretch. */
export function unitSegments(model: GhostPathModel, unit: GhostUnit): GhostSegment[] {
  const [t0, t1] = unitWindow(model, unit);
  return model.segments.flatMap((seg) => {
    const keep = seg.points.map((_, i) => i).filter((i) => seg.points[i].t >= t0 - 1e-6 && seg.points[i].t <= t1 + 1e-6);
    return keep.length >= 1 ? [{ points: keep.map((i) => seg.points[i]), spread: keep.map((i) => seg.spread[i]) }] : [];
  });
}

/** Window of a vowel or liquid zone inside a unit, in word time, clipped to the voiced ghost. */
export function pathZoneWindows(model: GhostPathModel, spec: GhostWordSpec, unit: GhostUnit): Map<string, [number, number]> {
  const [w0, w1] = unitWindow(model, unit);
  const half = FOLLOW.liquidHalfMs / model.durationMs;
  const inUnit = spec.zones.filter((z) => unit.zoneIds.includes(z.id));
  const voiced = model.segments.flatMap((s) => s.points.map((p) => p.t));
  const windows = new Map<string, [number, number]>();
  inUnit.forEach((zone, k) => {
    if (!PATH_KINDS.has(zone.kind)) return;
    let lo = w0;
    let hi = w1;
    const own = markerOf(model, zone.id)?.t;
    if (zone.kind === 'liquid' && own !== undefined) {
      lo = own - half;
      hi = own + half;
    } else {
      const prev = inUnit[k - 1];
      const next = inUnit[k + 1];
      const pm = prev && markerOf(model, prev.id)?.t;
      const nm = next && markerOf(model, next.id)?.t;
      if (prev && pm !== undefined) lo = prev.kind === 'liquid' ? pm + half : pm;
      if (next && nm !== undefined) hi = next.kind === 'liquid' ? nm - half : nm;
    }
    lo = Math.max(lo, w0);
    hi = Math.min(hi, w1);
    const inside = voiced.filter((t) => t >= lo - 1e-6 && t <= hi + 1e-6);
    windows.set(zone.id, inside.length ? [Math.min(...inside), Math.max(...inside)] : [lo, Math.max(lo, hi)]);
  });
  return windows;
}

/** Position of a stop zone relative to the word's vowel: before it is an onset, after it a coda. */
function stopRole(spec: GhostWordSpec, zone: GhostZoneSpec): 'onset' | 'coda' {
  const nucleus = spec.zones.findIndex((z) => z.kind === 'vowel');
  return nucleus < 0 || spec.zones.indexOf(zone) < nucleus ? 'onset' : 'coda';
}

/** First and last time of the sounds the learner's start and end are anchored to (voiced stretch plus bursts of the unit's stops). */
function ghostEventSpan(model: GhostPathModel, spec: GhostWordSpec, unit: GhostUnit): [number, number] {
  const [w0, w1] = unitWindow(model, unit);
  const times = model.segments.flatMap((s) => s.points.map((p) => p.t)).filter((t) => t >= w0 - 1e-6 && t <= w1 + 1e-6);
  for (const zone of spec.zones) {
    if (zone.kind !== 'stop' || !unit.zoneIds.includes(zone.id)) continue;
    const t = markerOf(model, zone.id)?.t;
    if (t !== undefined) times.push(t);
  }
  return times.length ? [Math.min(...times), Math.max(...times)] : [w0, w1];
}

/** 0..1 closeness for a distance in close-zone units: 1 inside the zone, 0 at closenessFarDistance. */
export function closenessFromDistance(d: number): number {
  return clamp(1 - (d - FOLLOW.hitDistance) / (FOLLOW.closenessFarDistance - FOLLOW.hitDistance), 0, 1);
}

export function verdictForDistance(d: number): ZoneVerdict {
  return d <= FOLLOW.hitDistance ? 'hit' : d <= FOLLOW.partialDistance ? 'partial' : 'miss';
}

// ---------------------------------------------------------------------------------------------
// Attempt
// ---------------------------------------------------------------------------------------------

interface Sample {
  ts: number;
  ln1: number;
  ln2: number;
}

export interface GhostSnapshot {
  started: boolean;
  done: boolean;
  /** Per stop zone in the unit: a release burst has landed in the right place. */
  stops: Record<string, boolean>;
  /** 0..1, smoothed: how near the learner's latest voiced frame is to the unit's ghost. 0 before voice. */
  closeness: number;
}

/**
 * Frame-driven attempt at one unit of a word.
 *
 *   const attempt = new GhostAttempt(spec, sizeModel(model, factor), unit, 'a1');
 *   attempt.push(frame, lip);   // every analysis frame
 *   attempt.tick(nowMs);        // optional, frame clock, lets silence end it between frames
 *   attempt.result;             // WordAttemptResult once done
 *
 * Starts on the first voiced frame or burst. Ends 600 ms after the last voiced frame or burst once the
 * learner was heard, or at 2.5x the unit's natural duration. `model` must already be sized to the learner.
 */
export class GhostAttempt {
  result: WordAttemptResult | null = null;

  private readonly windows: Map<string, [number, number]>;
  private readonly eventSpan: [number, number];
  private readonly unitGhost: { f1: number; f2: number; spread: number }[];
  private readonly hasPathZone: boolean;
  private readonly maxMs: number;

  private startMs: number | null = null;
  private lastEventMs = 0;
  private lastFrameMs = 0;
  private armedAt: number | null = null;
  private samples: Sample[] = [];
  private voicedTimes: number[] = [];
  private bursts: number[] = [];
  private totalFrames = 0;
  private clippedFrames = 0;
  private readonly lipAll = new LipAccumulator();
  private readonly lipFrames: { ts: number; lip: LipFrame | null }[] = [];
  private close = 0;

  constructor(
    readonly spec: GhostWordSpec,
    readonly model: GhostPathModel,
    readonly unit: GhostUnit,
    readonly attemptId: string,
  ) {
    this.windows = pathZoneWindows(model, spec, unit);
    this.eventSpan = ghostEventSpan(model, spec, unit);
    const inUnit = spec.zones.filter((z) => unit.zoneIds.includes(z.id));
    this.hasPathZone = inUnit.some((z) => PATH_KINDS.has(z.kind));
    this.maxMs = Math.max(FOLLOW.maxDurationFloorMs, FOLLOW.maxDurationFactor * unitDurationMs(model, unit));
    this.unitGhost = unitSegments(model, unit).flatMap((s) => s.points.map((p, i) => ({ f1: p.f1, f2: p.f2, spread: s.spread[i] })));
  }

  get started() {
    return this.startMs !== null;
  }

  get done() {
    return this.result !== null;
  }

  /** Frame-clock time the attempt started, or null before it does. */
  get startedAt() {
    return this.startMs;
  }

  get liveCloseness() {
    return this.close;
  }

  snapshot(): GhostSnapshot {
    const stops: Record<string, boolean> = {};
    const found = this.matchStops(false);
    for (const zone of this.spec.zones) {
      if (zone.kind === 'stop' && this.unit.zoneIds.includes(zone.id)) stops[zone.id] = found.get(zone.id) !== undefined;
    }
    return { started: this.started, done: this.done, stops, closeness: this.close };
  }

  push(frame: VoiceFrame, lip: LipFrame | null = null) {
    if (this.done) return;
    const ts = frame.timestampMs;
    this.lastFrameMs = ts;
    this.armedAt ??= ts;
    if (this.startMs === null) {
      if (!frame.voiced && !frame.burst) return;
      this.startMs = ts;
      this.lastEventMs = ts;
    }
    if (ts - this.startMs > this.maxMs) {
      this.end();
      return;
    }
    this.totalFrames++;
    if (frame.clipped) this.clippedFrames++;
    const usableLip = lipOk(lip) ? lip : null;
    this.lipAll.add(usableLip);
    this.lipFrames.push({ ts, lip: usableLip });
    if (frame.burst) {
      this.bursts.push(ts);
      this.lastEventMs = ts;
    }
    if (frame.voiced) {
      this.voicedTimes.push(ts);
      this.lastEventMs = ts;
      if (frame.f1 !== undefined && frame.f2 !== undefined && frame.f1 > 0 && frame.f2 > 0) {
        this.samples.push({ ts, ln1: Math.log(frame.f1), ln2: Math.log(frame.f2) });
        this.updateCloseness(frame.f1, frame.f2);
      }
    }
    this.checkEnd(ts);
  }

  /** Let silence and the cap end the attempt without a new frame. `nowMs` is in the frame clock. */
  tick(nowMs: number) {
    if (!this.done) this.checkEnd(nowMs);
  }

  /** End now (e.g. no frames arrived). */
  finish(nowMs?: number): WordAttemptResult {
    if (nowMs !== undefined) this.lastFrameMs = Math.max(this.lastFrameMs, nowMs);
    return this.end();
  }

  private checkEnd(ts: number) {
    if (this.done) return;
    if (this.startMs === null) return;
    if (ts - this.startMs >= this.maxMs) {
      this.end();
      return;
    }
    const heard = this.voicedTimes.length > 0 || (!this.hasPathZone && this.bursts.length > 0);
    if (heard && ts - this.lastEventMs >= FOLLOW.endSilenceMs) this.end();
  }

  private updateCloseness(f1: number, f2: number) {
    if (!this.unitGhost.length) return;
    let best = Infinity;
    for (const g of this.unitGhost) {
      const d = Math.hypot(Math.log(f1 / g.f1), Math.log(f2 / g.f2)) / g.spread;
      if (d < best) best = d;
    }
    const target = closenessFromDistance(best);
    this.close += (target - this.close) / FOLLOW.closenessTauFrames;
  }

  /** Which burst (frame time) satisfies each stop zone; `final` also accepts bursts that may still be followed by voicing. */
  private matchStops(final: boolean): Map<string, number> {
    const found = new Map<string, number>();
    const firstVoiced = this.voicedTimes[0] ?? null;
    const lastVoiced = this.voicedTimes.length ? this.voicedTimes[this.voicedTimes.length - 1] : null;
    const used = new Set<number>();
    const stops = this.spec.zones.filter((z) => z.kind === 'stop' && this.unit.zoneIds.includes(z.id));
    for (const zone of stops.filter((z) => stopRole(this.spec, z) === 'onset')) {
      const hit = this.bursts.find((b) => !used.has(b) && (firstVoiced === null || b <= firstVoiced + FOLLOW.onsetBurstAfterVoiceMs));
      if (hit !== undefined) {
        found.set(zone.id, hit);
        used.add(hit);
      }
    }
    for (const zone of stops.filter((z) => stopRole(this.spec, z) === 'coda')) {
      const hit = [...this.bursts].reverse().find((b) => {
        if (used.has(b)) return false;
        if (lastVoiced === null) return true;
        if (b < lastVoiced - FOLLOW.codaBurstSlackMs || b > lastVoiced + FOLLOW.codaBurstWithinMs) return false;
        return final || this.lastFrameMs - b >= FOLLOW.codaLiveConfirmMs;
      });
      if (hit !== undefined) {
        found.set(zone.id, hit);
        used.add(hit);
      }
    }
    return found;
  }

  private end(): WordAttemptResult {
    if (this.result) return this.result;
    const start = this.startMs;
    const durationMs = start === null ? 0 : Math.max(0, Math.round(this.lastEventMs - start));
    const quality = this.assessQuality(durationMs);
    const usable = quality.quality === 'usable';
    const stopHits = usable ? this.matchStops(true) : new Map<string, number>();
    const zones = this.spec.zones.map((zone) => this.zoneResult(zone, usable, stopHits));
    this.result = {
      word: this.spec.word,
      attemptId: this.attemptId,
      durationMs,
      zones,
      ...quality,
      lipUsable: this.lipAll.usable,
    };
    return this.result;
  }

  private assessQuality(durationMs: number): Pick<WordAttemptResult, 'quality' | 'qualityReason'> {
    if (this.startMs === null) return { quality: 'unclear', qualityReason: 'silence' };
    if (this.totalFrames > 0 && this.clippedFrames / this.totalFrames > FOLLOW.maxClippedFraction) return { quality: 'unclear', qualityReason: 'clipped' };
    if (this.hasPathZone) {
      if (this.samples.length < FOLLOW.minValidFrames) return { quality: 'unclear', qualityReason: 'no-voice' };
      const span = this.samples[this.samples.length - 1].ts - this.samples[0].ts;
      if (span < FOLLOW.minVoicedSpanMs || durationMs < FOLLOW.minVoicedSpanMs) return { quality: 'unclear', qualityReason: 'too-short' };
    }
    return { quality: 'usable' };
  }

  private rel(ts: number) {
    return Math.round(ts - this.startMs!);
  }

  /** The learner's path at frame time ts: linear in log Hz between voiced samples, held at the ends. */
  private learnerAt(ts: number): { f1: number; f2: number } {
    const s = this.samples;
    if (ts <= s[0].ts) return { f1: Math.exp(s[0].ln1), f2: Math.exp(s[0].ln2) };
    const last = s[s.length - 1];
    if (ts >= last.ts) return { f1: Math.exp(last.ln1), f2: Math.exp(last.ln2) };
    let j = 0;
    while (j < s.length - 2 && s[j + 1].ts < ts) j++;
    const a = s[j];
    const b = s[j + 1];
    const w = b.ts > a.ts ? clamp((ts - a.ts) / (b.ts - a.ts), 0, 1) : 0;
    return { f1: Math.exp(a.ln1 + w * (b.ln1 - a.ln1)), f2: Math.exp(a.ln2 + w * (b.ln2 - a.ln2)) };
  }

  /** Frame time the learner reaches the ghost's word time t, with the learner's own start and end mapped onto the ghost's. */
  private learnerTime(t: number, from: number, to: number): number {
    const [es, ee] = this.eventSpan;
    const u = ee > es ? clamp((t - es) / (ee - es), 0, 1) : 0.5;
    return from + u * (to - from);
  }

  /** The learner's own first and last sound of the kinds the ghost's span is anchored to. */
  private learnerSpan(): [number, number] {
    const anchors: number[] = [];
    const first: number[] = [];
    const last: number[] = [];
    if (this.voicedTimes.length) {
      first.push(this.voicedTimes[0]);
      last.push(this.voicedTimes[this.voicedTimes.length - 1]);
    }
    const found = this.matchStops(true);
    for (const zone of this.spec.zones) {
      const burst = found.get(zone.id);
      if (burst === undefined) continue;
      (stopRole(this.spec, zone) === 'onset' ? first : last).push(burst);
    }
    anchors.push(Math.min(...first), Math.max(...last));
    return [anchors[0], Math.max(anchors[0], anchors[1])];
  }

  private zoneResult(zone: GhostZoneSpec, usable: boolean, stopHits: Map<string, number>): ZoneResult {
    const advisory = ADVISORY.has(zone.kind);
    const base = { zoneId: zone.id, phoneme: zone.phoneme, kind: zone.kind, ...(advisory ? { advisory: true } : {}) };
    const skipped: ZoneResult = { ...base, verdict: 'skipped', dwellMs: 0, startMs: null, endMs: null, evidence: {} };
    if (!usable || !this.unit.zoneIds.includes(zone.id)) return skipped;

    if (zone.kind === 'stop') {
      const burst = stopHits.get(zone.id);
      const voicedBefore = burst !== undefined && this.voicedTimes.some((t) => t < burst) ? 1 : 0;
      const at = burst === undefined ? null : this.rel(burst);
      return {
        ...base,
        verdict: burst === undefined ? 'miss' : 'hit',
        dwellMs: 0,
        startMs: at,
        endMs: at,
        evidence: { burstDetected: burst === undefined ? 0 : 1, burstMs: at ?? -1, voicedBefore },
      };
    }

    if (PATH_KINDS.has(zone.kind)) {
      const window = this.windows.get(zone.id);
      if (!window) return skipped;
      const [from, to] = this.learnerSpan();
      const K = FOLLOW.pathPoints;
      let sum = 0;
      let close = 0;
      for (let j = 0; j < K; j++) {
        const t = window[0] + ((window[1] - window[0]) * j) / (K - 1);
        const g = ghostAt(this.model, t);
        const l = this.learnerAt(this.learnerTime(t, from, to));
        const d = Math.hypot(Math.log(l.f1 / g.f1), Math.log(l.f2 / g.f2)) / g.spread;
        sum += d;
        if (d <= FOLLOW.hitDistance) close++;
      }
      const pathDistance = sum / K;
      const closeFraction = close / K;
      const startTs = this.learnerTime(window[0], from, to);
      const endTs = this.learnerTime(window[1], from, to);
      const lip = new LipAccumulator();
      for (const f of this.lipFrames) if (f.ts >= startTs && f.ts <= endTs) lip.add(f.lip);
      return {
        ...base,
        verdict: verdictForDistance(pathDistance),
        dwellMs: Math.round(closeFraction * Math.max(0, endTs - startTs)),
        startMs: this.rel(startTs),
        endMs: this.rel(endTs),
        evidence: { pathDistance: round4(pathDistance), closeFraction: round4(closeFraction), ...lip.evidence() },
      };
    }

    // Fricatives and nasals are cue-only.
    return skipped;
  }
}

/**
 * True when the attempt was usable and every scored (non-advisory) zone of the unit was a hit.
 * A unit with only advisory zones (a lone r) is close whenever the attempt was usable.
 */
export function isClose(result: WordAttemptResult, unit: GhostUnit): boolean {
  if (result.quality !== 'usable') return false;
  return result.zones.every((zone) => !unit.zoneIds.includes(zone.zoneId) || zone.advisory || zone.verdict === 'hit');
}
