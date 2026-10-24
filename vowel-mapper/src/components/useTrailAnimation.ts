import { useEffect, useLayoutEffect, useState } from 'react';
import type { VowelPoint } from '../audio/tracker';
import { sampleArrivalTimes, TRAIL_LIFETIME_MS } from './trail';

/** A bounded presentation clock, independent of worker delivery and audio time. */
export function useTrailAnimation(trace: VowelPoint[], point: VowelPoint | null, live: boolean) {
  const [frame, setFrame] = useState(() => ({ now: performance.now(), arrivals: new Map<string, number>() }));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const now = performance.now();
    setFrame((previous) => ({ now, arrivals: sampleArrivalTimes(previous.arrivals, trace, point, now) }));
  }, [trace, point]);

  const expiresAt = Math.max(-Infinity, ...frame.arrivals.values()) + TRAIL_LIFETIME_MS;
  useEffect(() => {
    if (!live || !Number.isFinite(expiresAt)) return;
    let animation = 0;
    let timer = 0;
    const cancel = () => { cancelAnimationFrame(animation); window.clearTimeout(timer); };
    const tick = () => {
      const now = performance.now();
      setFrame((previous) => ({ ...previous, now }));
      if (now >= expiresAt || document.hidden) return;
      // Reduced motion uses straight strokes and a quiet 10 Hz fade.
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
  }, [live, expiresAt, reducedMotion]);

  return { ...frame, reducedMotion };
}
