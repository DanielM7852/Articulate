export const PLOT = { left: 86, top: 64, width: 624, height: 340 };

/** Acoustic convention: high F2 on the left, low F1 at the top. */
export function projectVowel(point: { f1: number; f2: number }) {
  return {
    x: PLOT.left + (3500 - point.f2) / 3000 * PLOT.width,
    y: PLOT.top + (point.f1 - 180) / 1020 * PLOT.height,
  };
}
