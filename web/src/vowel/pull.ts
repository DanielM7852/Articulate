/**
 * Capped personal calibration. A reference target moves toward the learner's own held vowel by at most
 * one close-zone radius (log-Hz, normalised per axis). Voice and dialect differences inside that budget
 * are absorbed; anything further is still shown as a gap, so a learner who cannot yet make the sound is
 * never told their current vowel is the target.
 */
export interface Formant2 {
  f1: number;
  f2: number;
}

/** How far a target may move, in radii. */
export const PULL_RADII = 1;

/** Normalised ln distance from `ref` to `anchor`: hypot(Δln F1 / r1, Δln F2 / r2). */
export function anchorDistance(ref: Formant2, anchor: Formant2, r1: number, r2 = r1): number {
  return Math.hypot(Math.log(anchor.f1 / ref.f1) / r1, Math.log(anchor.f2 / ref.f2) / r2);
}

/** `ref` moved toward `anchor` by at most PULL_RADII radii; `ref` unchanged when there is no anchor. Hz in, Hz out. */
export function pullToward(ref: Formant2, anchor: Formant2 | null | undefined, r1: number, r2 = r1): Formant2 {
  if (!anchor) return { f1: ref.f1, f2: ref.f2 };
  const d = anchorDistance(ref, anchor, r1, r2);
  const k = d <= PULL_RADII ? 1 : PULL_RADII / d;
  return {
    f1: ref.f1 * Math.pow(anchor.f1 / ref.f1, k),
    f2: ref.f2 * Math.pow(anchor.f2 / ref.f2, k),
  };
}
