import type { VowelPoint } from '../audio/tracker';
import { projectVowel } from './plot';

export const TRAIL_LIFETIME_MS = 3000;
export const sampleKey = (point: VowelPoint) => `${point.segment}:${point.timestampMs}`;

/** AudioContext time can pause. Remember arrival times so old ink never revives
 * when capture resumes, and backdate batched history using its audio timestamps. */
export function sampleArrivalTimes(previous: ReadonlyMap<string, number>, trace: readonly VowelPoint[], point: VowelPoint | null, now: number) {
  const samples = point ? [...trace, point] : trace;
  const latest = Math.max(...samples.map((sample) => sample.timestampMs));
  return new Map(samples.map((sample) => {
    const key = sampleKey(sample);
    return [key, previous.get(key) ?? now - Math.max(0, latest - sample.timestampMs)];
  }));
}

export function trailOpacity(ageMs: number) {
  return Math.pow(Math.max(0, Math.min(1, 1 - ageMs / TRAIL_LIFETIME_MS)), 1.6);
}

// Monotone Hermite tangents: no overshoot on either axis, including tight turns.
function tangent(before: number, after: number) {
  return before * after <= 0 ? 0 : 2 * before * after / (before + after);
}

/** Cosmetic geometry only. Never returns measurements to tracking or scoring.
 * Every curve ends at the accepted point: no buffering or head smoothing delay. */
export function buildTrail(trace: readonly VowelPoint[], point: VowelPoint | null, smooth = true) {
  const samples = [...trace];
  if (point && (!samples.length || point.timestampMs > samples.at(-1)!.timestampMs)) samples.push(point);
  const projected = samples.map(projectVowel);
  return samples.flatMap((sample, index) => {
    if (index === 0) return [];
    const previous = samples[index - 1];
    if (sample.segment !== previous.segment || sample.timestampMs <= previous.timestampMs) return [];
    const start = projected[index - 1];
    const end = projected[index];
    const before = index > 1 && samples[index - 2].segment === sample.segment ? projected[index - 2] : start;
    const after = index + 1 < samples.length && samples[index + 1].segment === sample.segment ? projected[index + 1] : end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const d = smooth
      ? `M${start.x},${start.y} C${start.x + tangent(start.x - before.x, dx) / 3},${start.y + tangent(start.y - before.y, dy) / 3} ${end.x - tangent(dx, after.x - end.x) / 3},${end.y - tangent(dy, after.y - end.y) / 3} ${end.x},${end.y}`
      : `M${start.x},${start.y} L${end.x},${end.y}`;
    return [{ key: `${sampleKey(previous)}-${sampleKey(sample)}`, from: previous, to: sample, start, end, d }];
  });
}
