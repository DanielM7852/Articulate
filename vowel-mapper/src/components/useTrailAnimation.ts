import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VowelPoint } from '../audio/tracker';
import { advanceHead, headRange, sampleArrivalTimes, TRAIL_LIFETIME_MS } from './trail';

/** A bounded presentation clock, independent of worker delivery and audio time.
 * It also eases a display head (audio ms) toward the newest accepted sample; that head
 * is cosmetic only and never reaches tracking, targets or scoring. */
export function useTrailAnimation(trace: VowelPoint[], point: VowelPoint | null, live: boolean) {
  const [frame, setFrame] = useState(() => ({ now: performance.now(), arrivals: new Map<string, number>(), headMs: null as number | null }));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const range = useMemo(() => headRange(trace, point), [trace, point]);
  const clock = useRef({ headMs: null as number | null, at: 0, running: false, range, reducedMotion });

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const now = performance.now();
    const state = clock.current;
    state.range = range;
    state.reducedMotion = reducedMotion;
    // Only re-validate here (snap on reset or a new stroke); the frame loop does the easing.
    if (!state.running) state.at = now;
    state.headMs = advanceHead(state.headMs, range, 0, reducedMotion);
    const headMs = state.headMs;
    setFrame((previous) => ({ now, arrivals: sampleArrivalTimes(previous.arrivals, trace, point, now), headMs }));
  }, [trace, point, range, reducedMotion]);

  const expiresAt = Math.max(-Infinity, ...frame.arrivals.values()) + TRAIL_LIFETIME_MS;
  const inkAlive = live && Number.isFinite(expiresAt);
  const settled = frame.headMs === (range?.end ?? null);
  useEffect(() => {
    if (!inkAlive && settled) return;
    const state = clock.current;
    let animation = 0;
    let timer = 0;
    const cancel = () => { cancelAnimationFrame(animation); window.clearTimeout(timer); state.running = false; };
    const tick = () => {
      const now = performance.now();
      state.headMs = advanceHead(state.headMs, state.range, now - state.at, state.reducedMotion);
      state.at = now;
      const headMs = state.headMs;
      setFrame((previous) => ({ ...previous, now, headMs }));
      const headDone = headMs === (state.range?.end ?? null);
      state.running = false;
      if ((!inkAlive || now >= expiresAt) && headDone) return;
      if (document.hidden) return;
      state.running = true;
      // Reduced motion snaps the head, uses straight strokes and a quiet 10 Hz fade.
      if (reducedMotion) timer = window.setTimeout(tick, 100);
      else animation = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancel();
      // Absolute elapsed time skips expired ink after background throttling.
      tick();
    };
    document.addEventListener('visibilitychange', visibility);
    tick();
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [inkAlive, expiresAt, reducedMotion, settled]);

  return { ...frame, reducedMotion };
}
