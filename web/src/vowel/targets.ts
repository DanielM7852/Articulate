import { SOUND_ORDER, type SoundId } from '../state/types';
import { pullToward } from './pull';

/**
 * Orientation regions for the three practice vowels on the F1/F2 plane.
 *
 * Centres sit between published adult male and female averages for American
 * English (Hillenbrand et al., 1995). Half-widths are in natural-log units so
 * the regions scale with the voice rather than with absolute hertz. They are
 * generic regions for orientation only: not personalised targets, not speaker
 * normalised, and not a pronunciation standard.
 */
export interface VowelTarget {
  f1: number;
  f2: number;
  /** Half-width along F1, natural-log units. */
  rf1: number;
  /** Half-width along F2, natural-log units. */
  rf2: number;
}

export const TARGETS: Record<SoundId, VowelTarget> = {
  i: { f1: 390, f2: 2500, rf1: 0.3, rf2: 0.2 },
  u: { f1: 420, f2: 1050, rf1: 0.3, rf2: 0.25 },
  a: { f1: 850, f2: 1400, rf1: 0.25, rf2: 0.22 },
};

/**
 * The three targets for one learner. The base centre is the fixed one scaled by exp(factor), the same single
 * voice factor the ghost model uses. A stored per-vowel median (their own eee/oo/ah from the warm-up) pulls
 * that centre toward it by at most one radius (pullToward), keeping the generic log half-widths. Structural
 * voice type so this module stays free of component imports.
 */
export function targetsFor(
  voice: { factor?: number; vowels?: Partial<Record<SoundId, { f1: number; f2: number }>> } | null | undefined,
): Record<SoundId, VowelTarget> {
  const scale = Math.exp(voice?.factor ?? 0);
  const out = {} as Record<SoundId, VowelTarget>;
  for (const id of SOUND_ORDER) {
    const base = TARGETS[id];
    const a = voice?.vowels?.[id];
    const sized = { f1: base.f1 * scale, f2: base.f2 * scale };
    out[id] = { ...pullToward(sized, a, base.rf1, base.rf2), rf1: base.rf1, rf2: base.rf2 };
  }
  return out;
}

/** How long a steady hold inside the region fills the hold ring. Matches the on-screen hint. */
export const HOLD_GOAL_SEC = 3;

/** Fixed axes shared with the standalone mapper. F1 grows downward, F2 grows to the left. */
export const AXES = { f1Min: 180, f1Max: 1200, f2Min: 500, f2Max: 3500 } as const;

export function inTarget(p: { f1: number; f2: number }, t: VowelTarget) {
  const d1 = Math.log(p.f1 / t.f1) / t.rf1;
  const d2 = Math.log(p.f2 / t.f2) / t.rf2;
  return d1 * d1 + d2 * d2 <= 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Plot position in percent of the plot area (0 to 100 on both axes). */
export function project(p: { f1: number; f2: number }) {
  const f1 = clamp(p.f1, AXES.f1Min, AXES.f1Max);
  const f2 = clamp(p.f2, AXES.f2Min, AXES.f2Max);
  return {
    x: ((AXES.f2Max - f2) / (AXES.f2Max - AXES.f2Min)) * 100,
    y: ((f1 - AXES.f1Min) / (AXES.f1Max - AXES.f1Min)) * 100,
  };
}

/** Ellipse for drawing a target region, in plot percent. */
export function targetEllipse(t: VowelTarget) {
  const c = project(t);
  const hi = project({ f1: t.f1 * Math.exp(t.rf1), f2: t.f2 * Math.exp(-t.rf2) });
  const lo = project({ f1: t.f1 * Math.exp(-t.rf1), f2: t.f2 * Math.exp(t.rf2) });
  return { cx: c.x, cy: c.y, rx: (hi.x - lo.x) / 2, ry: (hi.y - lo.y) / 2 };
}
