import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LipFrame } from '../vision/lipTelemetry';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame, WordAttemptResult, ZoneVerdict } from '../game/types';
import { SCORING, clamp, lipOk, lipShape, loudnessFromRms, smoothToward } from '../game/scoring';
import { GhostAttempt, ghostAt, sizeModel, unitDurationMs, unitSegments, unitWindow } from '../game/ghost/follow';
import type { GhostPathModel, GhostUnit } from '../game/ghost/types';
import type { GhostWordSpec } from '../game/ghost/words';
import { SOUND_ORDER, type SoundId } from '../state/types';
import { AXES, project, type VowelTarget } from '../vowel/targets';
import { InkTrail } from './board/ink';
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
  /** The learner's vowel targets (targetsFor): only the backdrop outline uses them; ghost sizing stays on the factor. */
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
  /** The zone Ava is coaching: emphasised on the path. */
  focusZoneId?: string | null;
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
/** The learner counts as on the ghost for the cursor colour above this closeness. */
const INSIDE_CLOSENESS = 0.6;

interface BoardView {
  done: boolean;
  stops: Record<string, boolean>;
  verdicts: Record<string, ZoneVerdict>;
  /** Watch mode: markers the dot has passed. */
  passed: string[];
}

const emptyView = (): BoardView => ({ done: false, stops: {}, verdicts: {}, passed: [] });
const viewKey = (v: BoardView) =>
  `${v.done}|${Object.entries(v.stops).filter(([, hit]) => hit).map(([id]) => id).join()}|${Object.entries(v.verdicts).map(([k, x]) => `${k}:${x}`).join()}|${v.passed.join()}`;

const VERDICT_WORD: Record<ZoneVerdict, string> = {
  hit: 'landed',
  partial: 'close',
  miss: 'not yet',
  skipped: 'not scored',
};

/** Soft grid and the dashed vowel-space outline, in plot percent (same projection as VowelGraph). */
const PlotBackdrop = memo(function PlotBackdrop({ targets }: { targets: Record<SoundId, VowelTarget> }) {
  return (
    <svg className="wb-backdrop" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[25, 50, 75].map((g) => (
        <g key={g}>
          <line x1={g} y1={0} x2={g} y2={100} className="wb-grid" />
          <line x1={0} y1={g} x2={100} y2={g} className="wb-grid" />
        </g>
      ))}
      <polygon
        className="wb-space"
        points={SOUND_ORDER.map((id) => {
          const c = project(targets[id]);
          return `${c.x},${c.y}`;
        }).join(' ')}
      />
    </svg>
  );
});

interface Px {
  x: number;
  y: number;
}

export function GhostBoard({
  spec,
  model,
  learnerFactor,
  targets,
  unit,
  mode,
  speed,
  frames,
  lip,
  attemptId,
  onWatchEnd,
  onAttemptEnd,
  focusZoneId = null,
}: GhostBoardProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const lipRingRef = useRef<SVGEllipseElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const livePathRefs = useRef<(SVGPathElement | null)[]>([]);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  const [view, setView] = useState<BoardView>(emptyView);
  const viewRef = useRef(view);

  // The ghost drawn for this learner. Everything below reads this one sized copy.
  const sized = useMemo(() => sizeModel(model, learnerFactor), [model, learnerFactor]);

  const lipRef = useRef(lip);
  lipRef.current = lip;
  const props = useRef({ spec, sized, unit, mode, speed, onWatchEnd, onAttemptEnd });
  props.current = { spec, sized, unit, mode, speed, onWatchEnd, onAttemptEnd };

  const attemptRef = useRef<GhostAttempt | null>(null);
  const reportedRef = useRef<string | null>(null);
  const armedPerfRef = useRef(0);
  const liveInk = useRef(new InkTrail());
  const watchRef = useRef({ elapsed: 0, ended: false, passed: new Set<string>() });
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
    if (attempt.result && attempt.result.quality === 'usable') {
      for (const z of attempt.result.zones) if (attempt.unit.zoneIds.includes(z.zoneId)) verdicts[z.zoneId] = z.verdict;
    }
    publish({ done: snap.done, stops: snap.stops, verdicts, passed: [] });
    if (attempt.result && reportedRef.current !== attempt.attemptId) {
      reportedRef.current = attempt.attemptId;
      props.current.onAttemptEnd?.(attempt.result);
    }
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
        armedPerfRef.current = performance.now();
        liveInk.current.clear();
      }
      syncAttempt();
      return;
    }
    // Leaving live before the attempt resolved abandons it without a callback.
    if (attemptRef.current && !attemptRef.current.done) attemptRef.current = null;
    if (mode === 'watch') {
      watchRef.current = { elapsed: 0, ended: false, passed: new Set() };
      publish(emptyView());
    } else if (!attemptRef.current) {
      publish(emptyView());
    }
    // `sized`, `unit` and `spec` are read when an attempt starts (keyed by id): re-sizing mid-attempt would move the target under the learner.
  }, [mode, attemptId, unit.id, spec.word, publish, syncAttempt]);

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
        if (frame.f1 !== undefined && frame.f2 !== undefined && props.current.mode === 'live') {
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
      const { sized: model, unit: u, mode: md, speed: sp } = props.current;
      const smooth = !s.reducedMotion;
      const board = boardRef.current;

      // Learner cursor and ink: only while live.
      s.loud = smooth ? smoothToward(s.loud, s.loudTarget, dt, LOUDNESS_TAU_MS) : s.loudTarget;
      const live = liveInk.current.step(now, dt, toPx, smooth, INK_WIDTH);
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
        setData(cursor, 'voiced', String(s.voiced));
      }
      setData(board, 'cursor', String(showCursor));
      const diameter = DOT_MIN + (DOT_MAX - DOT_MIN) * s.loud;
      if (dotRef.current) dotRef.current.style.transform = `scale(${(diameter / DOT_BASE).toFixed(3)})`;

      const attempt = md === 'live' ? attemptRef.current : null;
      const inside = Boolean(attempt && !attempt.done && s.voiced && attempt.liveCloseness >= INSIDE_CLOSENESS);
      setData(board, 'inside', String(inside));

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

      // Watch: the dot travels the unit's ghost at speed, pausing in the lead-in and the tail.
      const ghost = ghostRef.current;
      if (md === 'watch') {
        const w = watchRef.current;
        const [t0, t1] = unitWindow(model, u);
        const unitMs = Math.max(1, unitDurationMs(model, u));
        const travelMs = unitMs / Math.max(0.1, sp);
        if (!w.ended) w.elapsed += dt;
        const progress = clamp((w.elapsed - WATCH_LEAD_MS) / travelMs, 0, 1);
        const t = t0 + progress * (t1 - t0);
        const g = ghostAt(model, t);
        const at = toPx(g);
        if (ghost) {
          ghost.style.transform = `translate(${at.x}px, ${at.y}px)`;
          setData(ghost, 'shown', 'true');
          setData(ghost, 'voiced', String(g.voiced));
        }
        // Markers light as the dot passes them.
        let passedNow = false;
        if (progress > 0) {
          for (const m of model.markers) {
            if (u.zoneIds.includes(m.zoneId) && m.t >= t0 - 1e-6 && m.t <= t && !w.passed.has(m.zoneId)) {
              w.passed.add(m.zoneId);
              passedNow = true;
            }
          }
        }
        if (passedNow) publish({ done: false, stops: {}, verdicts: {}, passed: [...w.passed] });
        setData(board, 'passing', String(model.markers.some((m) => u.zoneIds.includes(m.zoneId) && Math.abs(m.t - t) * model.durationMs < 60)));
        if (!w.ended && w.elapsed >= WATCH_LEAD_MS + travelMs + WATCH_TAIL_MS) {
          w.ended = true;
          props.current.onWatchEnd?.();
        }
      } else if (ghost) {
        setData(ghost, 'shown', 'false');
        setData(board, 'passing', 'false');
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
    const active = unitSegments(sized, unit);
    const activeSet = new Set(active.flatMap((s) => s.points.map((p) => p.t)));
    const all = sized.segments.map((seg) => ({
      d: line(seg.points),
      width: bandWidth(seg.points, seg.spread),
      active: seg.points.some((p) => activeSet.has(p.t)),
    }));
    const activeLines = active.map((seg) => ({ d: line(seg.points), width: bandWidth(seg.points, seg.spread) }));
    const zoneById = new Map(spec.zones.map((z) => [z.id, z]));
    const markers = sized.markers.map((m) => {
      const zone = zoneById.get(m.zoneId);
      const at = toPx(ghostAt(sized, m.t));
      return { marker: m, zone, at };
    });
    const labels = sized.parts.flatMap((part) => {
      const pts = sized.segments.flatMap((s) => s.points).filter((p) => p.t >= part.t0 && p.t <= part.t1);
      if (!pts.length) return [];
      const mid = pts[pts.length >> 1];
      const at = toPx(mid);
      return [{ part, at }];
    });
    return { all, activeLines, markers, labels };
  }, [size.w, size.h, sized, unit, spec]);

  const unitZones = spec.zones.filter((z) => unit.zoneIds.includes(z.id));
  const focusZone = focusZoneId ? spec.zones.find((z) => z.id === focusZoneId) ?? null : null;
  const modeText = mode === 'watch' ? 'Model playing' : mode === 'live' ? (view.done ? 'Attempt finished' : 'Your turn') : 'Waiting';
  const how = unitZones.map((z) => `${z.label}: ${z.hint}`).join(' ');
  const resultText =
    mode === 'live' && view.done
      ? ` ${unitZones.map((z) => `${z.label} ${VERDICT_WORD[view.verdicts[z.id] ?? 'skipped']}`).join(', ')}.`
      : '';
  const focusText = focusZone && !unit.zoneIds.includes(focusZone.id) ? ` Look at ${focusZone.label}: ${focusZone.hint}` : '';
  const label = `Tongue board for “${spec.word}”, practising “${unit.label}”. ${modeText}. ${how}${resultText}${focusText}`;
  const status = mode === 'watch' ? 'Watch the model' : mode === 'live' ? (view.done ? 'Done' : 'Your turn') : 'Ready';

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
        data-passing="false"
      >
        <div className="wb-plot" ref={plotRef}>
          <PlotBackdrop targets={targets} />
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

              {geometry.labels.map(({ part, at }) => (
                <text
                  key={part.id}
                  className="gb-part-label"
                  data-active={unit.partIds.includes(part.id)}
                  x={at.x}
                  y={at.y - 22}
                >
                  {part.label}
                </text>
              ))}

              {geometry.markers.map(({ marker, zone, at }) => {
                if (!zone) return null;
                const active = unit.zoneIds.includes(zone.id);
                const focus = zone.id === focusZoneId;
                const lit = mode === 'watch' && view.passed.includes(zone.id);
                if (marker.kind === 'stop') {
                  const hit = active && view.stops[zone.id] === true;
                  const verdict = view.verdicts[zone.id];
                  const state = hit || verdict === 'hit' ? 'hit' : verdict === 'miss' ? 'miss' : lit ? 'hit' : 'open';
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
                    transform={`translate(${at.x} ${at.y + 26})`}
                  >
                    <rect className="gb-cue-box" x={-w / 2} y={-12} width={w} height={24} rx={12} />
                    <text className="gb-cue-text">{zone.label}</text>
                  </g>
                );
              })}

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
      </div>
      <p className="sr-only" aria-live="polite">
        {mode === 'live' && view.done ? `Attempt finished.${resultText}` : ''}
      </p>
    </div>
  );
}
