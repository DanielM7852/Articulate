import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LipFrame } from '../vision/lipTelemetry';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame, WordAttemptResult, ZoneVerdict } from '../game/types';
import { SCORING, clamp, lipOk, lipShape, loudnessFromRms, smoothToward } from '../game/scoring';
import { GhostAttempt, ghostAt, sizeModel, unitDurationMs, unitSegments, unitWindow } from '../game/ghost/follow';
import type { GhostPathModel, GhostUnit } from '../game/ghost/types';
import type { GhostWordSpec } from '../game/ghost/words';
import type { SoundId } from '../state/types';
import { AXES, project, type VowelTarget } from '../vowel/targets';
import { GhostInk } from '../game/ghost/ghostInk';
import { phoneCursorState } from '../live/phoneCursor';
import { ZONE_PHONES, canPhoneRescue, isPhoneJudged, unitPhoneZones } from '../live/phoneJudge';
import { easePlace, latestPhonePlace, pathCentroid } from '../live/phoneCentroid';
import { OFF_PATH_MAP_DIST, distanceToPolylines, formantsToMap, mapSymbols, mapToFormants, phoneMapModel, phonePlace, type PhonePlace } from '../game/ghost/phoneMap';
import type { PhoneCursorInput } from '../live/usePhoneCursor';
import '../styles/word-board.css';
import '../styles/ghost-board.css';

/**
 * The ghost-path board: the vowel space (same axes and projection as WordBoard), the model
 * pronunciation sized to the learner's voice, and the learner's own path drawn over it.
 *
 *  idle   the ghost, still
 *  watch  a dot travels the active unit's ghost over unitDuration / speed, then onWatchEnd
 *  live   a GhostAttempt (keyed by attemptId) scores the learner's path; onAttemptEnd fires once
 */
export interface GhostBoardProps {
  spec: GhostWordSpec;
  model: GhostPathModel;
  /** The learner's ln voice factor (Karsten's single multiplier). */
  learnerFactor: number;
  /** The learner's vowel targets (targetsFor). Kept for the caller; the board no longer draws the outline. */
  targets: Record<SoundId, VowelTarget>;
  unit: GhostUnit;
  mode: 'idle' | 'watch' | 'live';
  /** Playback speed for watch mode: 1 = natural. */
  speed: number;
  frames: VoiceFrames;
  /** Latest camera lip frame, or null when the camera is off or unusable. */
  lip: LipFrame | null;
  /**
   * A new value starts a new live attempt (live) or replays the ghost (watch). The same value keeps
   * the current one, and a finished attempt is reported only once.
   */
  attemptId: string;
  onWatchEnd?: () => void;
  onAttemptEnd?: (result: WordAttemptResult) => void;
  /**
   * Optional second opinion on a usable result (the phone judge): the board shows "Scoring…" while it runs, then shows
   * and reports the returned result. Must resolve (reject = the formant result stands). A new attempt discards a late answer.
   */
  judge?: (result: WordAttemptResult) => Promise<WordAttemptResult>;
  /**
   * Phone-recognizer cursor input (phone-judged words). When its state is 'ready' the board becomes a phone map: the path is
   * drawn through the fixed places of the word's phones (phoneMapModel) and the cursor sits at the probability-weighted
   * centroid of the phones the model hears, turning warm when it strays from the path. Any other state, or no prop, keeps
   * today's sized formant ghost and F1/F2 cursor. Scoring (GhostAttempt) and judging always use the formant model.
   */
  phoneCursor?: PhoneCursorInput;
  /** The zone Ava is coaching: emphasised on the path. */
  focusZoneId?: string | null;
  /**
   * A new non-zero value runs one "sound draw" in any mode: over demoMs the active line fills in from its start while the ghost dot
   * travels it (no lead-in, so it lines up with an audio onset), holds, fades and parks. A new value mid-draw restarts it.
   * It never calls onWatchEnd or onAttemptEnd.
   */
  demoRun?: number;
  /** Duration of the sound draw in ms (default 650, at least 400). */
  demoMs?: number;
  /** The attempt was judged correct: the line stays fully drawn and a checkmark circle sits at the end of the path. */
  success?: boolean;
}

const INK_WIDTH = 5;
const LIVE_PATHS = 6;
const HOLLOW_AFTER_MS = 50;
const LOUDNESS_TAU_MS = 70;
const DOT_MIN = 14;
const DOT_MAX = 30;
const DOT_BASE = 30;
/** Watch mode: a short lead-in and tail so the dot is seen setting off and arriving. */
const WATCH_LEAD_MS = 400;
const WATCH_TAIL_MS = 350;
const STOP_RADIUS = 17;
/** Sound draw: default duration, floor, then the hold and fade of the finished line. */
const DEMO_MS = 650;
const DEMO_MIN_MS = 400;
const DEMO_HOLD_MS = 350;
const DEMO_FADE_MS = 250;
/** A liquid-ended line is only trimmed back to the dot while that leaves at least this much line (px). */
const MIN_TRIM_PX = 40;
const CUE_DY = 26;
const CUE_H = 24;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const boxHit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const centred = (x: number, y: number, hw: number, hh: number): Box => ({ x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh });
/** Box of a centred serif text label drawn with its baseline at y. */
const textBox = (x: number, y: number, chars: number, size: number): Box => {
  const hw = (chars * size * 0.55 + 4) / 2;
  return { x0: x - hw, x1: x + hw, y0: y - size * 0.85, y1: y + size * 0.25 };
};
/** The learner counts as on the ghost for the cursor colour above this closeness. */
const INSIDE_CLOSENESS = 0.6;
/** Phone map: off-target hysteresis (back on target below this fraction of OFF_PATH_MAP_DIST). */
const OFF_RETURN = 0.85;

interface BoardView {
  done: boolean;
  stops: Record<string, boolean>;
  verdicts: Record<string, ZoneVerdict>;
  /** True when the verdicts come from the judge (a stop's verdict then replaces its formant burst circle). */
  judged: boolean;
  /** Watch mode: markers the dot has passed. */
  passed: string[];
}

const emptyView = (): BoardView => ({ done: false, stops: {}, verdicts: {}, judged: false, passed: [] });
const viewKey = (v: BoardView) =>
  `${v.done}|${v.judged}|${Object.entries(v.stops).filter(([, hit]) => hit).map(([id]) => id).join()}|${Object.entries(v.verdicts).map(([k, x]) => `${k}:${x}`).join()}|${v.passed.join()}`;

const VERDICT_WORD: Record<ZoneVerdict, string> = {
  hit: 'landed',
  partial: 'close',
  miss: 'not yet',
  skipped: 'not scored',
};

/** Soft grid in plot percent (same projection as VowelGraph). */
const PlotBackdrop = memo(function PlotBackdrop() {
  return (
    <svg className="wb-backdrop" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[25, 50, 75].map((g) => (
        <g key={g}>
          <line x1={g} y1={0} x2={g} y2={100} className="wb-grid" />
          <line x1={0} y1={g} x2={100} y2={g} className="wb-grid" />
        </g>
      ))}
    </svg>
  );
});

interface Px {
  x: number;
  y: number;
}

/** How far along a segment the line is drawn at word time t: ts are the point times, fs the length fraction at each point. */
function fillFraction(ts: number[], fs: number[], t: number): number {
  const last = ts.length - 1;
  if (t <= ts[0]) return 0;
  if (t >= ts[last]) return 1;
  let k = 0;
  while (k < last - 1 && ts[k + 1] < t) k++;
  const span = ts[k + 1] - ts[k];
  const w = span > 0 ? clamp((t - ts[k]) / span, 0, 1) : 0;
  return fs[k] + w * (fs[k + 1] - fs[k]);
}

export function GhostBoard({
  spec,
  model,
  learnerFactor,
  unit,
  mode,
  speed,
  frames,
  lip,
  attemptId,
  onWatchEnd,
  onAttemptEnd,
  judge,
  phoneCursor,
  focusZoneId = null,
  demoRun = 0,
  demoMs = DEMO_MS,
  success = false,
}: GhostBoardProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const lipRingRef = useRef<SVGEllipseElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const livePathRefs = useRef<(SVGPathElement | null)[]>([]);
  const fillLayerRef = useRef<SVGGElement>(null);
  const fillRefs = useRef<(SVGPathElement | null)[]>([]);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  const [view, setView] = useState<BoardView>(emptyView);
  const viewRef = useRef(view);

  // The ghost drawn for this learner. Everything below reads this one sized copy.
  const sized = useMemo(() => sizeModel(model, learnerFactor), [model, learnerFactor]);
  // The model that is DRAWN. For a phone-judged word with the phone stream ready it is the phone map's fixed-place path;
  // sized stays the JUDGING model (GhostAttempt: try start/end, quality, formant fallback).
  const phoneReady = phoneCursor?.state === 'ready' && isPhoneJudged(spec.word);
  const displayModel = useMemo(() => {
    if (!phoneReady) return null;
    try {
      return phoneMapModel(spec.word);
    } catch {
      return null;
    }
  }, [phoneReady, spec.word]);
  const shown = displayModel ?? sized;

  const lipRef = useRef(lip);
  lipRef.current = lip;
  const props = useRef({ spec, sized, shown, unit, mode, speed, onWatchEnd, onAttemptEnd, judge, success });
  props.current = { spec, sized, shown, unit, mode, speed, onWatchEnd, onAttemptEnd, judge, success };

  // Phone-map cursor: the unit's target phones, the start of its path and the path itself in map space.
  const phoneCfg = useMemo(() => {
    const zones = unitPhoneZones(spec.word, unit);
    if (zones.length === 0 || !displayModel) return null;
    const [t0] = unitWindow(displayModel, unit);
    const g = ghostAt(displayModel, t0);
    const lines: PhonePlace[][] = unitSegments(displayModel, unit).map((seg) => seg.points.map((p) => formantsToMap(p.f1, p.f2)));
    return { targets: zones.map((z) => z.phone), start: formantsToMap(g.f1, g.f2), lines };
  }, [displayModel, unit, spec.word]);
  const phoneState = phoneCursor?.state === 'ready' && phoneCfg ? phoneCursorState(phoneCfg.targets, phoneCursor.phones) : null;
  const phoneInput = { cfg: phoneCfg, st: phoneState, resetAt: phoneCursor?.resetAt ?? 0, attemptId, frames: phoneCursor?.frames ?? [], phones: phoneCursor?.phones ?? [] };
  const phoneRef = useRef(phoneInput);
  phoneRef.current = phoneInput;
  const debug = useMemo(() => {
    try {
      return new URLSearchParams(location.search).has('debug');
    } catch {
      return false;
    }
  }, []);

  const attemptRef = useRef<GhostAttempt | null>(null);
  const reportedRef = useRef<string | null>(null);
  /** The attempt id whose judge call is in flight, and the judged result once it is back. */
  const judgingRef = useRef<string | null>(null);
  const judgedRef = useRef<WordAttemptResult | null>(null);
  const [scoring, setScoring] = useState(false);
  const armedPerfRef = useRef(0);
  const liveInk = useRef(new GhostInk());
  /** Which space the ink points are in ('px' = phone cursor, 'f' = F1/F2), so switching clears it. */
  const inkSpace = useRef<'px' | 'f'>('f');
  const phoneRt = useRef({
    sig: '',
    lastN: -1,
    cur: { x: 0, y: 0 } as PhonePlace,
    target: { x: 0, y: 0 } as PhonePlace,
    heard: false,
    off: false,
    lastX: NaN,
    lastY: NaN,
  });
  const watchRef = useRef({ elapsed: 0, ended: false, passed: new Set<string>() });
  /** The sound draw: start is a performance.now() stamp (-1 = not running). */
  const demoRef = useRef({ start: -1, ms: DEMO_MS, passed: new Set<string>() });
  const lastDemoRun = useRef(demoRun);
  /** Per active segment, the point times and the fraction of the line's pixel length reached at each (rebuilt with the geometry). */
  const fillGeomRef = useRef<{ ts: number[]; fs: number[] }[]>([]);
  // Model time where a trimmed unit's line ends (the r dot); the travelling dot holds there. Null when untrimmed.
  const drawEndTRef = useRef<number | null>(null);
  const sig = useRef({
    lastFrameTs: 0,
    lastFramePerf: -Infinity,
    loudTarget: 0,
    loud: 0,
    voiced: false,
    unvoicedSince: null as number | null,
    reducedMotion: typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });

  const publish = useCallback((next: BoardView) => {
    if (viewKey(next) === viewKey(viewRef.current)) return;
    viewRef.current = next;
    setView(next);
  }, []);

  /** Mirror the live attempt into the stop circles, and report its result exactly once. */
  const syncAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    const snap = attempt.snapshot();
    const verdicts: Record<string, ZoneVerdict> = {};
    const judgedResult = judgedRef.current?.attemptId === attempt.attemptId ? judgedRef.current : null;
    const shown = judgedResult ?? (judgingRef.current === attempt.attemptId ? null : attempt.result); // no verdicts while scoring
    if (shown && shown.quality === 'usable') {
      for (const z of shown.zones) if (attempt.unit.zoneIds.includes(z.zoneId)) verdicts[z.zoneId] = z.verdict;
    }
    publish({ done: snap.done, stops: snap.stops, verdicts, judged: judgedResult !== null, passed: [] });
    const raw = attempt.result;
    if (!raw || reportedRef.current === attempt.attemptId || judgingRef.current === attempt.attemptId) return;
    const id = attempt.attemptId;
    const judgeFn = props.current.judge;
    if (judgeFn && (raw.quality === 'usable' || canPhoneRescue(raw))) {
      judgingRef.current = id;
      setScoring(true);
      publish({ done: snap.done, stops: snap.stops, verdicts: {}, judged: false, passed: [] });
      const finish = (final: WordAttemptResult) => {
        // A new attempt (or leaving live) replaced this one while it was being scored: drop the late answer.
        if (attemptRef.current?.attemptId !== id || reportedRef.current === id) return;
        judgingRef.current = null;
        setScoring(false);
        if (final !== raw) judgedRef.current = final;
        reportedRef.current = id;
        syncAttempt();
        props.current.onAttemptEnd?.(final);
      };
      judgeFn(raw).then(finish, () => finish(raw));
      return;
    }
    reportedRef.current = id;
    props.current.onAttemptEnd?.(raw);
  }, [publish]);

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      sizeRef.current = next;
      setSize(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      sig.current.reducedMotion = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Mode and attempt lifecycle.
  useEffect(() => {
    if (mode === 'live') {
      const current = attemptRef.current;
      const stale = !current || current.attemptId !== attemptId || current.unit.id !== unit.id || current.spec !== spec;
      if (reportedRef.current !== attemptId && stale) {
        attemptRef.current = new GhostAttempt(spec, sized, unit, attemptId);
        judgingRef.current = null;
        judgedRef.current = null;
        setScoring(false);
        armedPerfRef.current = performance.now();
        liveInk.current.clear();
      }
      syncAttempt();
      return;
    }
    // Leaving live before the attempt resolved abandons it without a callback.
    if (attemptRef.current && !attemptRef.current.done) {
      attemptRef.current = null;
      judgingRef.current = null;
      setScoring(false);
    }
    if (mode === 'watch') {
      watchRef.current = { elapsed: 0, ended: false, passed: new Set() };
      publish(emptyView());
    } else if (!attemptRef.current) {
      publish(emptyView());
    }
    // `sized`, `unit` and `spec` are read when an attempt starts (keyed by id): re-sizing mid-attempt would move the target under the learner.
  }, [mode, attemptId, unit.id, spec.word, publish, syncAttempt]);

  // Sound draw: a new non-zero demoRun restarts it from empty; the rAF loop does the drawing.
  useEffect(() => {
    if (demoRun === lastDemoRun.current) return;
    lastDemoRun.current = demoRun;
    if (!demoRun) return;
    demoRef.current = { start: performance.now(), ms: Math.max(DEMO_MIN_MS, demoMs), passed: new Set() };
  }, [demoRun, demoMs]);

  // Frames: scoring and cursor inputs update synchronously; drawing happens in the rAF loop.
  const subscribe = frames.subscribe;
  useEffect(() => {
    const s = sig.current;
    const onFrame = (frame: VoiceFrame) => {
      const now = performance.now();
      const ts = frame.timestampMs;
      s.lastFrameTs = ts;
      s.lastFramePerf = now;
      s.loudTarget = loudnessFromRms(frame.rms);
      if (frame.voiced) {
        s.unvoicedSince = null;
        s.voiced = true;
        if (frame.f1 !== undefined && frame.f2 !== undefined && props.current.mode === 'live' && !phoneRef.current.st) {
          liveInk.current.add(frame.f1, frame.f2, ts, now);
        }
      } else {
        s.unvoicedSince ??= ts;
        if (s.voiced && ts - s.unvoicedSince >= HOLLOW_AFTER_MS) {
          s.voiced = false;
          liveInk.current.breakStroke();
        }
      }
      const attempt = attemptRef.current;
      if (attempt && !attempt.done && props.current.mode === 'live') {
        attempt.push(frame, lipOk(lipRef.current) ? lipRef.current : null);
        syncAttempt();
      }
    };
    return subscribe(onFrame);
  }, [subscribe, syncAttempt]);

  // Live timeouts between frames (silence, cap), and the no-frames-at-all start timeout.
  useEffect(() => {
    if (mode !== 'live') return;
    const timer = window.setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || attempt.done) return;
      const s = sig.current;
      const now = performance.now();
      if (s.lastFramePerf >= armedPerfRef.current) attempt.tick(s.lastFrameTs + (now - s.lastFramePerf));
      else if (now - armedPerfRef.current >= SCORING.startTimeoutMs) attempt.finish();
      syncAttempt();
    }, 100);
    return () => window.clearInterval(timer);
  }, [mode, attemptId, syncAttempt]);

  // The draw loop: learner ink and cursor, lip ring, closeness colour and the watch dot. Writes the DOM directly.
  useEffect(() => {
    const s = sig.current;
    let raf = 0;
    let last = performance.now();
    const toPx = (p: { f1: number; f2: number }): Px => {
      const c = project(p);
      return { x: (c.x / 100) * sizeRef.current.w, y: (c.y / 100) * sizeRef.current.h };
    };
    const setData = (el: HTMLElement | null, key: string, value: string) => {
      if (el && el.dataset[key] !== value) el.dataset[key] = value;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(64, now - last);
      last = now;
      if (sizeRef.current.w === 0) return;
      const { shown: model, unit: u, mode: md, speed: sp } = props.current;
      const smooth = !s.reducedMotion;
      const board = boardRef.current;

      // Learner cursor and ink: only while live.
      s.loud = smooth ? smoothToward(s.loud, s.loudTarget, dt, LOUDNESS_TAU_MS) : s.loudTarget;
      // Phone-map cursor: eases (exponential) toward where the model's heard phones sit (on the path while it hears the
      // unit's targets, see pathCentroid) and holds through silence.
      const ph = phoneRef.current;
      const phoneOn = md === 'live' && ph.st !== null && ph.cfg !== null;
      const rt = phoneRt.current;
      const space = phoneOn ? 'px' : 'f';
      if (inkSpace.current !== space) {
        inkSpace.current = space;
        liveInk.current.clear();
        rt.sig = '';
      }
      if (phoneOn && ph.cfg) {
        const sig = `${ph.attemptId}|${ph.resetAt}|${u.id}`;
        if (rt.sig !== sig) {
          // Frames present now belong to before this attempt: skip them (numbers only grow, so new ones are always newer).
          const lastN = ph.frames.length ? ph.frames[ph.frames.length - 1].n : rt.lastN;
          Object.assign(rt, { sig, lastN, cur: { ...ph.cfg.start }, target: { ...ph.cfg.start }, heard: false, off: false, lastX: NaN, lastY: NaN });
          liveInk.current.clear();
        }
        for (const f of ph.frames) {
          if (f.n <= rt.lastN) continue;
          rt.lastN = f.n;
          const c = pathCentroid(f, ph.cfg.targets);
          if (c) {
            rt.target = c;
            rt.heard = true;
          }
        }
        if (ph.frames.length === 0) {
          // Old server (no frames): sit at the place of the latest heard phone.
          const c = latestPhonePlace(ph.phones);
          if (c) {
            rt.target = c;
            rt.heard = true;
          }
        }
        rt.cur = smooth ? easePlace(rt.cur, rt.target, dt) : { ...rt.target };
        const away = distanceToPolylines(rt.cur, ph.cfg.lines);
        rt.off = rt.heard && (rt.off ? away > OFF_PATH_MAP_DIST * OFF_RETURN : away > OFF_PATH_MAP_DIST);
        const at = toPx(mapToFormants(rt.cur.x, rt.cur.y));
        if (!liveInk.current.hasPoint || Math.hypot(at.x - rt.lastX, at.y - rt.lastY) > 0.4) {
          liveInk.current.add(at.x, at.y, now, now);
          rt.lastX = at.x;
          rt.lastY = at.y;
        }
      } else {
        rt.sig = '';
      }
      const pxToPx = (p: { f1: number; f2: number }): Px => ({ x: p.f1, y: p.f2 });
      const live = liveInk.current.step(now, dt, phoneOn ? pxToPx : toPx, smooth, INK_WIDTH);
      const phoneVoiced = Boolean(phoneOn && rt.heard);
      const ribbons = md === 'live' ? live.ribbons : [];
      const refs = livePathRefs.current;
      const start = Math.max(0, ribbons.length - refs.length);
      refs.forEach((path, i) => {
        if (!path) return;
        const d = ribbons[start + i]?.d ?? '';
        if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      });
      const cursor = cursorRef.current;
      const showCursor = md === 'live' && Boolean(live.cursor);
      if (cursor) {
        if (live.cursor) cursor.style.transform = `translate(${live.cursor.x}px, ${live.cursor.y}px)`;
        setData(cursor, 'shown', String(showCursor));
        setData(cursor, 'voiced', String(phoneOn ? phoneVoiced : s.voiced));
      }
      setData(board, 'cursor', String(showCursor));
      const diameter = DOT_MIN + (DOT_MAX - DOT_MIN) * s.loud;
      if (dotRef.current) dotRef.current.style.transform = `scale(${(diameter / DOT_BASE).toFixed(3)})`;

      const attempt = md === 'live' ? attemptRef.current : null;
      const inside = phoneOn
        ? Boolean(attempt && !attempt.done && rt.heard && !rt.off)
        : Boolean(attempt && !attempt.done && s.voiced && attempt.liveCloseness >= INSIDE_CLOSENESS);
      setData(board, 'inside', String(inside));
      setData(board, 'veer', String(Boolean(phoneOn && rt.off)));

      // Lip ring: wide and flat when spread, small and round when rounded; hidden without a usable camera.
      const ring = lipRingRef.current;
      if (ring) {
        const shape = lipShape(lipRef.current);
        if (shape === null || !showCursor) {
          if (ring.style.opacity !== '0') ring.style.opacity = '0';
        } else {
          const open = clamp(lipRef.current!.openness, 0, 1);
          const r = diameter / 2 + 9;
          const spread = Math.max(0, -shape);
          const round = Math.max(0, shape);
          ring.setAttribute('rx', (r * (1 + 0.55 * spread) * (1 - 0.22 * round)).toFixed(2));
          ring.setAttribute('ry', (r * (1 - 0.32 * spread) * (1 - 0.22 * round) * (0.86 + 0.28 * open)).toFixed(2));
          ring.style.strokeWidth = (2 + 1.5 * round).toFixed(2);
          ring.style.opacity = '1';
        }
      }

      // Watch and sound draw: the dot travels the unit's ghost and the line fills in behind it. Watch runs at speed, pausing in
      // the lead-in and the tail; the sound draw starts at once. Markers light as the dot passes them.
      const ghost = ghostRef.current;
      const [t0, t1] = unitWindow(model, u);
      const demo = demoRef.current;
      const demoElapsed = demo.start < 0 ? -1 : now - demo.start;
      const demoOn = md !== 'watch' && demoElapsed >= 0 && demoElapsed < demo.ms + DEMO_HOLD_MS + DEMO_FADE_MS;
      if (demo.start >= 0 && md !== 'watch' && !demoOn) {
        // Finished: park the dot and clear the lit markers.
        demo.start = -1;
        if (demo.passed.size && md !== 'live') publish(emptyView());
        demo.passed.clear();
      }
      let drawT: number | null = null;
      let fillOpacity = 0;
      if (md === 'watch') {
        const w = watchRef.current;
        const unitMs = Math.max(1, unitDurationMs(model, u));
        const travelMs = unitMs / Math.max(0.1, sp);
        if (!w.ended) w.elapsed += dt;
        const progress = clamp((w.elapsed - WATCH_LEAD_MS) / travelMs, 0, 1);
        drawT = t0 + progress * (t1 - t0);
        fillOpacity = 1;
        let passedNow = false;
        if (progress > 0) {
          for (const m of model.markers) {
            if (u.zoneIds.includes(m.zoneId) && m.t >= t0 - 1e-6 && m.t <= drawT && !w.passed.has(m.zoneId)) {
              w.passed.add(m.zoneId);
              passedNow = true;
            }
          }
        }
        if (passedNow) publish({ done: false, stops: {}, verdicts: {}, judged: false, passed: [...w.passed] });
        if (!w.ended && w.elapsed >= WATCH_LEAD_MS + travelMs + WATCH_TAIL_MS) {
          w.ended = true;
          props.current.onWatchEnd?.();
        }
      } else if (demoOn) {
        const progress = s.reducedMotion ? 1 : clamp(demoElapsed / demo.ms, 0, 1);
        drawT = t0 + progress * (t1 - t0);
        fillOpacity = 1 - clamp((demoElapsed - demo.ms - DEMO_HOLD_MS) / DEMO_FADE_MS, 0, 1);
        if (md !== 'live') {
          let passedNow = false;
          for (const m of model.markers) {
            if (u.zoneIds.includes(m.zoneId) && m.t >= t0 - 1e-6 && m.t <= drawT && !demo.passed.has(m.zoneId)) {
              demo.passed.add(m.zoneId);
              passedNow = true;
            }
          }
          if (passedNow) publish({ done: false, stops: {}, verdicts: {}, judged: false, passed: [...demo.passed] });
        }
      }
      if (ghost) {
        if (drawT !== null) {
          const g = ghostAt(model, Math.min(drawT, drawEndTRef.current ?? Infinity));
          const at = toPx(g);
          ghost.style.transform = `translate(${at.x}px, ${at.y}px)`;
          setData(ghost, 'shown', String(fillOpacity > 0));
          setData(ghost, 'voiced', String(g.voiced));
        } else {
          setData(ghost, 'shown', 'false');
        }
      }
      const t = drawT;
      setData(board, 'passing', String(t !== null && model.markers.some((m) => u.zoneIds.includes(m.zoneId) && Math.abs(m.t - t) * model.durationMs < 60)));

      // The progressive line: each active segment is filled to the dot's place along it; success shows it whole.
      const whole = props.current.success && md !== 'live';
      const layer = fillLayerRef.current;
      if (layer) {
        const opacity = whole ? '1' : fillOpacity.toFixed(3);
        if (layer.style.opacity !== opacity) layer.style.opacity = opacity;
        fillGeomRef.current.forEach((seg, i) => {
          const path = fillRefs.current[i];
          if (!path) return;
          const offset = (1 - (whole ? 1 : t === null ? 0 : fillFraction(seg.ts, seg.fs, t))).toFixed(4);
          if (path.style.strokeDashoffset !== offset) path.style.strokeDashoffset = offset;
        });
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [publish]);

  // ---- static geometry (rebuilt only on resize, model, unit) ----

  const geometry = useMemo(() => {
    if (size.w === 0 || size.h === 0) return null;
    const toPx = (p: { f1: number; f2: number }): Px => {
      const c = project(p);
      return { x: (c.x / 100) * size.w, y: (c.y / 100) * size.h };
    };
    const line = (points: { f1: number; f2: number }[]) =>
      points.map((p, i) => {
        const q = toPx(p);
        return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      }).join(' ');
    // Close-zone band width: the spread in ln units, as pixels along each axis, averaged.
    const bandWidth = (points: { f1: number; f2: number }[], spread: number[]) => {
      let sum = 0;
      points.forEach((p, i) => {
        const px = (p.f2 / (AXES.f2Max - AXES.f2Min)) * size.w;
        const py = (p.f1 / (AXES.f1Max - AXES.f1Min)) * size.h;
        sum += spread[i] * (px + py);
      });
      return Math.max(8, sum / Math.max(1, points.length));
    };
    const active = unitSegments(shown, unit);
    const activeSet = new Set(active.flatMap((s) => s.points.map((p) => p.t)));
    const all = shown.segments.map((seg) => ({
      d: line(seg.points),
      width: bandWidth(seg.points, seg.spread),
      active: seg.points.some((p) => activeSet.has(p.t)),
    }));
    const zoneById = new Map(spec.zones.map((z) => [z.id, z]));
    const markers = shown.markers.map((m) => {
      const zone = zoneById.get(m.zoneId);
      const at = toPx(ghostAt(shown, m.t));
      return { marker: m, zone, at };
    });
    // The unit's target: the last marker inside its window. It takes the check and, when a liquid, ends the drawn line.
    const [winT0, endT] = unitWindow(shown, unit);
    const target = shown.markers
      .filter((m) => unit.zoneIds.includes(m.zoneId) && m.t >= winT0 - 1e-6 && m.t <= endT + 1e-6)
      .sort((a, b) => a.t - b.t)
      .pop();
    let drawn = active;
    drawEndTRef.current = null;
    if (target && target.kind === 'liquid') {
      const cut = target.t;
      const trimmed = active.flatMap((seg) => {
        const keep = seg.points.map((_, i) => i).filter((i) => seg.points[i].t <= cut + 1e-6);
        if (!keep.length) return [];
        const points = keep.map((i) => seg.points[i]);
        const spread = keep.map((i) => seg.spread[i]);
        const last = points[points.length - 1];
        const next = seg.points[keep[keep.length - 1] + 1];
        if (last.t < cut - 1e-6 && next && next.t > cut) {
          const g = ghostAt(shown, cut);
          points.push({ ...last, t: cut, f1: g.f1, f2: g.f2 });
          spread.push(g.spread);
        }
        return [{ points, spread }];
      });
      let px = 0;
      trimmed.forEach((seg) =>
        seg.points.forEach((p, i) => {
          if (!i) return;
          const a = toPx(seg.points[i - 1]);
          const b = toPx(p);
          px += Math.hypot(b.x - a.x, b.y - a.y);
        }),
      );
      if (px >= MIN_TRIM_PX) {
        drawn = trimmed;
        drawEndTRef.current = cut;
      }
    }
    const activeLines = drawn.map((seg) => ({ d: line(seg.points), width: bandWidth(seg.points, seg.spread) }));
    // Fraction of each active segment's pixel length reached at each point: the fill follows the dot along the drawn line.
    fillGeomRef.current = drawn.map((seg) => {
      const lens = [0];
      seg.points.forEach((p, i) => {
        if (i === 0) return;
        const a = toPx(seg.points[i - 1]);
        const b = toPx(p);
        lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
      });
      const total = lens[lens.length - 1];
      return { ts: seg.points.map((p) => p.t), fs: lens.map((l, i) => (total > 0 ? l / total : i === 0 ? 0 : 1)) };
    });
    // Check position: a target marker takes it (cue badges at their centre); no marker leaves a ring at the window end.
    const targetPx = target ? markers.find((m) => m.marker === target)!.at : null;
    const end = {
      at: target && targetPx ? (target.kind === 'stop' || target.kind === 'liquid' ? targetPx : { x: targetPx.x, y: targetPx.y + CUE_DY }) : toPx(ghostAt(shown, endT)),
      ring: !target,
    };
    // Phone labels sit at the phone-map place, except for cue badges: just below the badge.
    const phoneLabels = displayModel
      ? spec.zones.flatMap((z) => {
          const sym = ZONE_PHONES[spec.word]?.[z.id];
          const place = sym ? phonePlace(sym) : null;
          if (!sym || !place) return [];
          const mk = markers.find((m) => m.marker.zoneId === z.id);
          const cue = !!mk && mk.marker.kind !== 'stop' && mk.marker.kind !== 'liquid';
          const at = cue && mk ? { x: mk.at.x, y: mk.at.y + CUE_DY + CUE_H / 2 + 14 } : { ...toPx(mapToFormants(place.x, place.y)), y: toPx(mapToFormants(place.x, place.y)).y + STOP_RADIUS + 16 };
          return [{ id: z.id, sym, active: unit.zoneIds.includes(z.id), at }];
        })
      : [];
    // Part labels: skip one that repeats its lone stop; lift the rest clear of markers, phone labels and each other.
    const obstacles: Box[] = [];
    markers.forEach(({ marker, at }) => {
      if (marker.kind === 'stop') obstacles.push(centred(at.x, at.y, STOP_RADIUS + 2, STOP_RADIUS + 2));
      else if (marker.kind === 'liquid') obstacles.push(centred(at.x, at.y, 8, 8));
      else {
        const z = zoneById.get(marker.zoneId);
        obstacles.push(centred(at.x, at.y + CUE_DY, (18 + (z?.label.length ?? 1) * 9) / 2, CUE_H / 2));
      }
    });
    phoneLabels.forEach((p) => obstacles.push(textBox(p.at.x, p.at.y, p.sym.length, 15)));
    const labels: { part: GhostPathModel['parts'][number]; at: Px }[] = [];
    shown.parts.forEach((part) => {
      const zs = part.zoneIds.map((id) => zoneById.get(id));
      if (zs.length === 1 && zs[0]?.kind === 'stop' && zs[0].label === part.label) return;
      const pts = shown.segments.flatMap((s) => s.points).filter((p) => p.t >= part.t0 && p.t <= part.t1);
      if (!pts.length) return;
      const at = toPx(pts[pts.length >> 1]);
      let best = { y: at.y - 22, hits: Infinity };
      for (const off of [22, 28, 34, 40, 46, 52, 58, -26, -34, -42, -50]) {
        const y = at.y - off;
        const box = textBox(at.x, y, part.label.length, 20);
        const hits = obstacles.filter((o) => boxHit(box, o)).length;
        if (hits < best.hits) best = { y, hits };
        if (!hits) break;
      }
      obstacles.push(textBox(at.x, best.y, part.label.length, 20));
      labels.push({ part, at: { x: at.x, y: best.y } });
    });
    const mapLabels =
      displayModel && debug
        ? mapSymbols().map((sym) => {
            const place = phonePlace(sym)!;
            return { sym, at: toPx(mapToFormants(place.x, place.y)) };
          })
        : [];
    return { all, activeLines, end, markers, labels, phoneLabels, mapLabels };
  }, [size.w, size.h, shown, displayModel, unit, spec, debug]);

  const unitZones = spec.zones.filter((z) => unit.zoneIds.includes(z.id));
  const focusZone = focusZoneId ? spec.zones.find((z) => z.id === focusZoneId) ?? null : null;
  const modeText = mode === 'watch' ? 'Model playing' : mode === 'live' ? (view.done ? 'Attempt finished' : 'Your turn') : 'Waiting';
  const how = unitZones.map((z) => `${z.label}: ${z.hint}`).join(' ');
  const resultText =
    mode === 'live' && view.done
      ? ` ${unitZones.map((z) => `${z.label} ${VERDICT_WORD[view.verdicts[z.id] ?? 'skipped']}`).join(', ')}.`
      : '';
  const focusText = focusZone && !unit.zoneIds.includes(focusZone.id) ? ` Look at ${focusZone.label}: ${focusZone.hint}` : '';
  const heard = debug && phoneCursor?.state === 'ready' ? ` Heard: ${phoneCursor.phones.map((x) => x.p).join(' ') || 'nothing yet'}.` : '';
  const label = `Tongue board for “${spec.word}”, practising “${unit.label}”. ${modeText}. ${how}${resultText}${focusText}${heard}`;
  const phoneOffline = (phoneCursor?.state === 'error' || phoneCursor?.state === 'closed') && isPhoneJudged(spec.word);
  const status = mode === 'watch' ? 'Watch the model' : mode === 'live' ? (scoring ? 'Scoring…' : view.done ? 'Done' : 'Your turn') : 'Ready';

  return (
    <div className="gb" data-mode={mode}>
      <div
        className="wb-board gb-board"
        ref={boardRef}
        role="img"
        aria-label={label}
        data-mode={mode}
        data-cursor="false"
        data-inside="false"
        data-veer="false"
        data-passing="false"
        data-scoring={scoring}
      >
        <div className="wb-plot" ref={plotRef}>
          <PlotBackdrop />
          {geometry && (
            <svg className="wb-layer" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
              {/* Close-zone band, then the model line: dim everywhere, solid on the active unit. */}
              {geometry.all.map((seg, i) => (
                <path key={`band-${i}`} className="gb-band" data-active={seg.active} d={seg.d} strokeWidth={seg.width} />
              ))}
              {geometry.all.map((seg, i) => (
                <path key={`line-${i}`} className="gb-line" data-active={false} d={seg.d} />
              ))}
              {geometry.activeLines.map((seg, i) => (
                <path key={`active-${i}`} className="gb-line" data-active d={seg.d} />
              ))}
              {/* The line drawn in as the dot travels (watch, sound draw) or whole on success. */}
              <g className="gb-fill-layer" ref={fillLayerRef} data-success={success} style={{ opacity: 0 }}>
                {geometry.activeLines.map((seg, i) => (
                  <path
                    key={`fill-${i}`}
                    ref={(el) => {
                      fillRefs.current[i] = el;
                    }}
                    className="gb-fill"
                    d={seg.d}
                    pathLength={1}
                    strokeDasharray={1}
                    style={{ strokeDashoffset: 1 }}
                  />
                ))}
              </g>

              {geometry.labels.map(({ part, at }) => (
                <text
                  key={part.id}
                  className="gb-part-label"
                  data-active={unit.partIds.includes(part.id)}
                  x={at.x}
                  y={at.y}
                >
                  {part.label}
                </text>
              ))}

              {geometry.markers.map(({ marker, zone, at }) => {
                if (!zone) return null;
                const active = unit.zoneIds.includes(zone.id);
                const focus = zone.id === focusZoneId;
                const lit = mode !== 'live' && view.passed.includes(zone.id);
                if (marker.kind === 'stop') {
                  const hit = active && view.stops[zone.id] === true;
                  const verdict = view.verdicts[zone.id];
                  const state = view.judged && verdict ? (verdict === 'hit' ? 'hit' : verdict === 'miss' ? 'miss' : 'open') : hit || verdict === 'hit' ? 'hit' : verdict === 'miss' ? 'miss' : lit ? 'hit' : 'open';
                  return (
                    <g
                      key={zone.id}
                      className="gb-stop"
                      data-active={active}
                      data-focus={focus}
                      data-state={state}
                      transform={`translate(${at.x} ${at.y})`}
                    >
                      {active && state === 'open' && mode !== 'idle' && <circle className="gb-stop-approach" r={STOP_RADIUS + 3} />}
                      <circle className="gb-stop-ring" r={STOP_RADIUS} />
                      {state === 'hit' && <circle key={`${attemptId}-burst`} className="gb-stop-burst" r={STOP_RADIUS} />}
                      <text className="gb-stop-letter">{zone.label}</text>
                    </g>
                  );
                }
                if (marker.kind === 'liquid') {
                  return (
                    <g key={zone.id} className="gb-liquid" data-active={active} data-focus={focus} transform={`translate(${at.x} ${at.y})`}>
                      <circle className="gb-liquid-dot" r={6} />
                    </g>
                  );
                }
                // Fricative and nasal: a labelled cue badge beside the path.
                const w = 18 + zone.label.length * 9;
                return (
                  <g
                    key={zone.id}
                    className="gb-cue"
                    data-kind={marker.kind}
                    data-active={active}
                    data-focus={focus}
                    data-lit={lit}
                    transform={`translate(${at.x} ${at.y + CUE_DY})`}
                  >
                    <rect className="gb-cue-box" x={-w / 2} y={-12} width={w} height={24} rx={12} />
                    <text className="gb-cue-text">{zone.label}</text>
                  </g>
                );
              })}

              {/* End of the path: an open ring, or the success check (on the stop when one ends the path). */}
              <g className="gb-end" data-success={success} transform={`translate(${geometry.end.at.x} ${geometry.end.at.y})`}>
                {success ? (
                  <>
                    <circle className="gb-end-disc" r={STOP_RADIUS + 2} />
                    <path className="gb-end-check" d="M-7,0.5 L-2,5.5 L7.5,-5" pathLength={1} />
                  </>
                ) : (
                  geometry.end.ring && <circle className="gb-end-ring" r={STOP_RADIUS} />
                )}
              </g>

              {geometry.mapLabels.map(({ sym, at }) => (
                <text key={`map-${sym}`} className="gb-map-label" x={at.x} y={at.y}>
                  {sym}
                </text>
              ))}
              {geometry.phoneLabels.map(({ id, sym, active, at }) => (
                <text key={`phone-${id}`} className="gb-phone-label" data-active={active} x={at.x} y={at.y}>
                  {sym}
                </text>
              ))}

              <g className="wb-ink">
                {Array.from({ length: LIVE_PATHS }, (_, i) => (
                  <path
                    key={i}
                    ref={(el) => {
                      livePathRefs.current[i] = el;
                    }}
                  />
                ))}
              </g>
            </svg>
          )}

          <div className="wb-ghost" ref={ghostRef} data-shown="false" data-voiced="false" aria-hidden="true">
            <span className="wb-ghost-dot" />
          </div>
          <div className="wb-cursor" ref={cursorRef} data-shown="false" data-voiced="false" aria-hidden="true">
            <svg className="wb-lip" viewBox="-40 -40 80 80">
              <ellipse ref={lipRingRef} cx={0} cy={0} rx={20} ry={20} style={{ opacity: 0 }} />
            </svg>
            <span className="wb-dot" ref={dotRef} />
          </div>
        </div>

        <span className="wb-axis wb-axis--x" aria-hidden="true">
          ← tongue forward · tongue back →
        </span>
        <span className="wb-axis wb-axis--y" aria-hidden="true">
          jaw open ↓
        </span>
        <span className="wb-status" aria-hidden="true">
          {status}
        </span>
        {phoneOffline && (
          <span className="gb-offline" title={`Phone model unavailable: ${phoneCursor?.reason ?? phoneCursor?.state}`}>
            Phone model offline · basic view
          </span>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {mode === 'live' && view.done ? `Attempt finished.${resultText}` : ''}
      </p>
    </div>
  );
}
