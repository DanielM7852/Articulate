import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LipFrame } from '../vision/lipTelemetry';
import type { VoiceFrames } from '../audio/useVoiceFrames';
import type { VoiceFrame, VowelZoneTarget, WordAttemptResult, WordSpec } from '../game/types';
import { WordAttempt, type ZoneStatus } from '../game/sequence';
import { demoAt } from '../game/demo';
import { SCORING, clamp, f3gap, inBand, insideVowel, lipOk, lipShape, loudnessFromRms, needlePosition, smoothToward } from '../game/scoring';
import { SOUND_ORDER } from '../state/types';
import { AXES, TARGETS, project } from '../vowel/targets';
import { InkTrail } from './board/ink';
import { TunerStrip } from './board/TunerStrip';
import { ZoneSequence } from './board/ZoneSequence';
import '../styles/word-board.css';

/**
 * The word game board: a tongue-space plot (front/back by high/low, no Hz shown to the
 * learner), the zone sequence for `spec.zones`, a tuner strip for tuner zones, stop
 * markers, and a cursor whose size is loudness, fill is voicing, ring is lip shape.
 */
export interface WordBoardProps {
  spec: WordSpec;
  frames: VoiceFrames;
  /** Latest camera lip frame, or null when the camera is off or unusable. */
  lip: LipFrame | null;
  /** idle: zones dimmed. demo: play the zone sequence as Ava's example. live: score the learner. */
  mode: 'idle' | 'demo' | 'live';
  /** Attempt id for the result; a new value starts a new live attempt. */
  attemptId: string;
  /** Fires once per live attempt when the sequence completes or times out. */
  onAttemptEnd?: (result: WordAttemptResult) => void;
  /** Which zone to emphasise (the one Ava is coaching), or null. */
  focusZoneId?: string | null;
}

/** Ribbon width in CSS px and the bounded number of ink paths per cursor. */
const INK_WIDTH = 5;
const LIVE_PATHS = 6;
const GHOST_PATHS = 3;
/** Unvoiced this long: the cursor goes hollow and the ink stroke ends (debounces single-frame dropouts). */
const HOLLOW_AFTER_MS = 50;
/** The needle parks (fades) when no f3 frame arrived for this long. */
const NEEDLE_STALE_MS = 400;
const LOUDNESS_TAU_MS = 70;
/** Cursor dot diameter in px, from silent to loud. */
const DOT_MIN = 14;
const DOT_MAX = 30;
const DOT_BASE = 30;

interface BoardView {
  source: 'idle' | 'demo' | 'live';
  statuses: ZoneStatus[];
  activeIndex: number;
  /** Per zone: changes when that stop's release should flash. */
  flash: string[];
  done: boolean;
}

const restView = (spec: WordSpec, source: BoardView['source'] = 'idle'): BoardView => ({
  source,
  statuses: spec.zones.map(() => 'upcoming'),
  activeIndex: -1,
  flash: spec.zones.map(() => ''),
  done: false,
});

const viewKey = (v: BoardView) => `${v.source}|${v.statuses.join(',')}|${v.activeIndex}|${v.flash.join(',')}|${v.done}`;

function ellipsePx(t: VowelZoneTarget, w: number, h: number) {
  const c = project(t);
  return {
    cx: (c.x / 100) * w,
    cy: (c.y / 100) * h,
    rx: (t.rx / (AXES.f2Max - AXES.f2Min)) * w,
    ry: (t.ry / (AXES.f1Max - AXES.f1Min)) * h,
  };
}

const STATE_WORD: Record<ZoneStatus, string> = {
  upcoming: 'next',
  active: 'now',
  hit: 'landed',
  partial: 'close',
  miss: 'not yet',
  skipped: 'skipped',
};

/** Soft grid and the dashed vowel-space outline, in plot percent (same projection as VowelGraph). */
const PlotBackdrop = memo(function PlotBackdrop() {
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
          const c = project(TARGETS[id]);
          return `${c.x},${c.y}`;
        }).join(' ')}
      />
    </svg>
  );
});

export function WordBoard({ spec, frames, lip, mode, attemptId, onAttemptEnd, focusZoneId = null }: WordBoardProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const lipRingRef = useRef<SVGEllipseElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const livePathRefs = useRef<(SVGPathElement | null)[]>([]);
  const ghostPathRefs = useRef<(SVGPathElement | null)[]>([]);
  const fillRefs = useRef<(SVGPathElement | null)[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<HTMLDivElement>(null);
  const bandFillRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  const [view, setView] = useState<BoardView>(() => restView(spec));
  const viewRef = useRef(view);

  // Everything the frame listener and the rAF loop read lives in refs: no React state per frame.
  const lipRef = useRef(lip);
  lipRef.current = lip;
  const props = useRef({ spec, mode, focusZoneId, onAttemptEnd });
  props.current = { spec, mode, focusZoneId, onAttemptEnd };

  const attemptRef = useRef<WordAttempt | null>(null);
  const reportedRef = useRef<string | null>(null);
  const armedPerfRef = useRef(0);
  const demoStartRef = useRef(0);
  const demoFlashRef = useRef<{ released: number; loop: number }>({ released: -1, loop: -1 });
  const liveInk = useRef(new InkTrail());
  const ghostInk = useRef(new InkTrail());
  const sig = useRef({
    lastFrameTs: 0,
    lastFramePerf: -Infinity,
    loudTarget: 0,
    loud: 0,
    voiced: false,
    seen: false,
    unvoicedSince: null as number | null,
    needle: null as number | null,
    needleTs: null as number | null,
    needlePerf: -Infinity,
    ghostLoop: -1,
    ghostVoiced: false,
    reducedMotion: typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });

  const publish = useCallback((next: BoardView) => {
    if (viewKey(next) === viewKey(viewRef.current)) return;
    viewRef.current = next;
    setView(next);
  }, []);

  /** Mirror the live attempt into the chips, and report its result exactly once. */
  const syncAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    const snap = attempt.snapshot();
    publish({
      source: 'live',
      statuses: snap.statuses,
      activeIndex: snap.activeIndex,
      flash: snap.bursts.map((n) => (n > 0 ? `l${n}` : '')),
      done: snap.done,
    });
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
      if (reportedRef.current !== attemptId && (!current || current.attemptId !== attemptId || current.spec !== spec)) {
        attemptRef.current = new WordAttempt(spec, attemptId);
        armedPerfRef.current = performance.now();
      }
      syncAttempt();
      return;
    }
    // Leaving live before the attempt resolved abandons it without a callback.
    if (attemptRef.current && !attemptRef.current.done) attemptRef.current = null;
    if (mode === 'demo') {
      demoStartRef.current = performance.now();
      demoFlashRef.current = { released: -1, loop: -1 };
      ghostInk.current.clear();
      sig.current.ghostLoop = -1;
      publish(restView(spec, 'demo'));
    } else if (viewRef.current.source !== 'live') {
      publish(restView(spec));
    }
  }, [mode, attemptId, spec, publish, syncAttempt]);

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
        if (frame.f1 !== undefined && frame.f2 !== undefined) {
          liveInk.current.add(frame.f1, frame.f2, ts, now);
          s.seen = true;
        }
        const gap = f3gap(frame);
        if (gap !== null) {
          const fresh = now - s.needlePerf < NEEDLE_STALE_MS && s.needleTs !== null;
          s.needle = smoothToward(fresh ? s.needle : null, gap, fresh ? ts - s.needleTs! : 0, SCORING.needleTauMs);
          s.needleTs = ts;
          s.needlePerf = now;
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

  // The draw loop: cursor, ink, lip ring, ghost, needle and hold fills. Writes the DOM directly.
  useEffect(() => {
    const s = sig.current;
    let raf = 0;
    let last = performance.now();
    const toPx = (p: { f1: number; f2: number }) => {
      const c = project(p);
      return { x: (c.x / 100) * sizeRef.current.w, y: (c.y / 100) * sizeRef.current.h };
    };
    const writePaths = (refs: (SVGPathElement | null)[], ribbons: { d: string }[]) => {
      const start = Math.max(0, ribbons.length - refs.length);
      refs.forEach((path, i) => {
        if (!path) return;
        const ribbon = ribbons[start + i];
        const d = ribbon ? ribbon.d : '';
        if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      });
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
      const { spec: sp, mode: md, focusZoneId: focus } = props.current;
      const smooth = !s.reducedMotion;
      const board = boardRef.current;

      // Live cursor: eased along the ink, size from loudness, solid when voiced.
      s.loud = smooth ? smoothToward(s.loud, s.loudTarget, dt, LOUDNESS_TAU_MS) : s.loudTarget;
      const live = liveInk.current.step(now, dt, toPx, smooth, INK_WIDTH);
      writePaths(livePathRefs.current, live.ribbons);
      const cursor = cursorRef.current;
      if (cursor) {
        if (live.cursor) cursor.style.transform = `translate(${live.cursor.x}px, ${live.cursor.y}px)`;
        setData(cursor, 'shown', String(Boolean(live.cursor)));
        setData(cursor, 'voiced', String(s.voiced));
      }
      setData(board, 'cursor', String(Boolean(live.cursor)));
      const diameter = DOT_MIN + (DOT_MAX - DOT_MIN) * s.loud;
      if (dotRef.current) dotRef.current.style.transform = `scale(${(diameter / DOT_BASE).toFixed(3)})`;

      // Lip ring: wide and flat when spread, small and round when rounded; hidden without a usable camera.
      const ring = lipRingRef.current;
      if (ring) {
        const shape = lipShape(lipRef.current);
        if (shape === null || !live.cursor) {
          if (ring.style.opacity !== '0') ring.style.opacity = '0';
        } else {
          const open = clamp(lipRef.current!.openness, 0, 1);
          const r = diameter / 2 + 9;
          const spread = Math.max(0, -shape);
          const round = Math.max(0, shape);
          const rx = r * (1 + 0.55 * spread) * (1 - 0.22 * round);
          const ry = r * (1 - 0.32 * spread) * (1 - 0.22 * round) * (0.86 + 0.28 * open);
          ring.setAttribute('rx', rx.toFixed(2));
          ring.setAttribute('ry', ry.toFixed(2));
          ring.style.strokeWidth = (2 + 1.5 * round).toFixed(2);
          ring.style.opacity = '1';
        }
      }

      // Mode-specific: demo script, live attempt, or a plain live needle.
      let needle: number | null = now - s.needlePerf < NEEDLE_STALE_MS ? s.needle : null;
      let progress = 0;
      let progressIndex = -1;
      const ghost = ghostRef.current;
      if (md === 'demo') {
        const d = demoAt(sp, now - demoStartRef.current);
        if (d.loop !== s.ghostLoop || (!d.ghostVoiced && s.ghostVoiced)) ghostInk.current.breakStroke();
        s.ghostLoop = d.loop;
        s.ghostVoiced = d.ghostVoiced;
        if (d.ghost && d.ghostVoiced) ghostInk.current.add(d.ghost.f1, d.ghost.f2, now - demoStartRef.current, now);
        const g = ghostInk.current.step(now, dt, toPx, smooth, INK_WIDTH * 0.8);
        writePaths(ghostPathRefs.current, g.ribbons);
        const at = d.ghost ? toPx(d.ghost) : null;
        if (ghost) {
          if (at) ghost.style.transform = `translate(${at.x}px, ${at.y}px)`;
          setData(ghost, 'shown', String(Boolean(at)));
          setData(ghost, 'voiced', String(d.ghostVoiced));
        }
        needle = d.needle;
        progress = d.progress;
        progressIndex = d.activeIndex;
        const flash = demoFlashRef.current;
        const prev = viewRef.current;
        let flashes = prev.source === 'demo' ? prev.flash : sp.zones.map(() => '');
        if (d.releasedIndex !== -1 && (d.releasedIndex !== flash.released || d.loop !== flash.loop)) {
          flashes = flashes.map((key, i) => (i === d.releasedIndex ? `d${d.loop}-${i}` : key));
          demoFlashRef.current = { released: d.releasedIndex, loop: d.loop };
        }
        publish({ source: 'demo', statuses: d.statuses, activeIndex: d.activeIndex, flash: flashes, done: false });
      } else {
        if (ghost) setData(ghost, 'shown', 'false');
        writePaths(ghostPathRefs.current, []);
        const attempt = md === 'live' ? attemptRef.current : null;
        if (attempt && !attempt.done) {
          progress = attempt.progress();
          progressIndex = attempt.snapshot().activeIndex;
          needle = attempt.needle() ?? needle;
        }
      }

      // Vowel targets: hold fill on the active one, success colour while the cursor sits inside.
      const target = sp.zones[progressIndex]?.kind === 'vowel' ? progressIndex : sp.zones.findIndex((z) => z.id === focus && z.kind === 'vowel');
      fillRefs.current.forEach((el, i) => {
        if (!el) return;
        const p = i === progressIndex && sp.zones[i]?.kind === 'vowel' ? progress : 0;
        const offset = (100 - p * 100).toFixed(1);
        if (el.style.strokeDashoffset !== offset) el.style.strokeDashoffset = offset;
      });
      const lastPoint = liveInk.current.last;
      const zone = sp.zones[target];
      const inside = Boolean(zone?.vowel && lastPoint && s.voiced && insideVowel(lastPoint, zone.vowel));
      setData(board, 'inside', String(inside));

      // Tuner needle and band fill.
      const strip = stripRef.current;
      const tunerZone = sp.zones.find((z, i) => z.kind === 'tuner' && (z.id === focus || i === viewRef.current.activeIndex));
      if (strip && tunerZone?.tuner) {
        setData(strip, 'live', String(needle !== null));
        if (needle !== null) {
          const pos = needlePosition(needle, tunerZone.tuner);
          if (needleRef.current) needleRef.current.style.transform = `translateY(${(-pos * 100).toFixed(2)}%)`;
          setData(strip, 'inband', String(inBand(needle, tunerZone.tuner)));
        } else {
          setData(strip, 'inband', 'false');
        }
        const tunerIndex = sp.zones.indexOf(tunerZone);
        const fill = tunerIndex === progressIndex ? progress : 0;
        if (bandFillRef.current) bandFillRef.current.style.transform = `scaleY(${fill.toFixed(3)})`;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [publish]);

  const vowelEllipses = useMemo(
    () => spec.zones.map((zone) => (zone.vowel && size.w > 0 ? ellipsePx(zone.vowel, size.w, size.h) : null)),
    [spec, size.w, size.h],
  );

  const activeZone = view.activeIndex >= 0 ? spec.zones[view.activeIndex] : null;
  const focusZone = focusZoneId ? spec.zones.find((z) => z.id === focusZoneId) ?? null : null;
  const tunerZone = focusZone?.kind === 'tuner' ? focusZone : activeZone?.kind === 'tuner' && mode !== 'idle' ? activeZone : null;
  const tunerIndex = tunerZone ? spec.zones.indexOf(tunerZone) : -1;
  // Keep the last tuner's content while the strip slides closed.
  const anyTuner = spec.zones.find((z) => z.kind === 'tuner') ?? null;

  const spelled = spec.zones.map((z) => z.label).join(' ');
  const modeText =
    mode === 'demo' ? 'Example playing' : mode === 'live' ? (view.done ? 'Attempt finished' : 'Your turn') : 'Waiting';
  const zoneText = activeZone ? ` Now: ${activeZone.label}. ${activeZone.hint}` : '';
  const resultText =
    view.source === 'live' && view.done
      ? ` ${spec.zones.map((z, i) => `${z.label} ${STATE_WORD[view.statuses[i]]}`).join(', ')}.`
      : '';
  const focusText = focusZone && focusZone !== activeZone ? ` Look at ${focusZone.label}: ${focusZone.hint}` : '';
  const label = `Tongue board for “${spec.word}” (${spelled}). ${modeText}.${zoneText}${resultText}${focusText}`;
  const status = mode === 'demo' ? 'Watch the example' : mode === 'live' ? (view.done ? 'Done' : 'Your turn') : 'Ready';

  return (
    <div className="wb" data-mode={mode}>
      <ZoneSequence
        word={spec.word}
        zones={spec.zones}
        statuses={view.statuses}
        activeIndex={view.activeIndex}
        focusZoneId={focusZoneId}
        flash={view.flash}
        announce={mode === 'live'}
      />
      <div className="wb-board" ref={boardRef} role="img" aria-label={label} data-cursor="false" data-inside="false">
        <div className="wb-plot" ref={plotRef}>
          <PlotBackdrop />
          {size.w > 0 && size.h > 0 && (
            <svg className="wb-layer" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
              {spec.zones.map((zone, i) => {
                const e = vowelEllipses[i];
                if (!e) return null;
                const state = view.statuses[i] ?? 'upcoming';
                const isActive = i === view.activeIndex;
                const isFocus = zone.id === focusZoneId;
                return (
                  <g
                    key={zone.id}
                    className="wb-target"
                    data-state={state}
                    data-active={isActive}
                    data-focus={isFocus}
                  >
                    {isActive && (
                      <ellipse key={`${view.source}-approach`} className="wb-approach" cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} />
                    )}
                    <ellipse className="wb-target-area" cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} />
                    {/* Hold fill: the outline drawn clockwise from 12 o'clock as the dwell grows. */}
                    <path
                      className="wb-target-fill"
                      ref={(el) => {
                        fillRefs.current[i] = el;
                      }}
                      d={`M${e.cx},${e.cy - e.ry} A${e.rx},${e.ry} 0 1 1 ${e.cx},${e.cy + e.ry} A${e.rx},${e.ry} 0 1 1 ${e.cx},${e.cy - e.ry}`}
                      pathLength={100}
                    />
                    {state === 'hit' && (
                      <ellipse key={`${view.source}-burst`} className="wb-burst" cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} />
                    )}
                    <text className="wb-target-label" x={e.cx} y={e.cy - e.ry - 10}>
                      {zone.label}
                    </text>
                  </g>
                );
              })}
              <g className="wb-ink wb-ink--ghost">
                {Array.from({ length: GHOST_PATHS }, (_, i) => (
                  <path
                    key={i}
                    ref={(el) => {
                      ghostPathRefs.current[i] = el;
                    }}
                  />
                ))}
              </g>
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

          <div className="wb-empty" aria-hidden="true">
            <p className="ob-label">Your voice moves the dot</p>
            <p className="ob-fine">Bigger when louder, solid while your voice is on.</p>
          </div>
        </div>

        <TunerStrip
          zone={tunerZone ?? anyTuner}
          open={Boolean(tunerZone)}
          focus={Boolean(tunerZone && tunerZone.id === focusZoneId)}
          status={tunerIndex >= 0 ? view.statuses[tunerIndex] : null}
          stripRef={stripRef}
          needleRef={needleRef}
          fillRef={bandFillRef}
        />

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
    </div>
  );
}
