import type { VoiceFrame } from '../../types';
import { ghostAt, unitWindow } from '../follow';
import type { GhostPathModel, GhostUnit } from '../types';
import type { GhostWordSpec } from '../words';

/** Synthetic learner streams for the ghost tests: 10 ms frames, ghost-shaped voice, bursts at stop markers. */
export const STEP = 10;

export interface StreamOptions {
  /** Added to ln F1 and ln F2 (a voice or a deliberate error). */
  lnShift?: number;
  lnShift2?: number;
  /** Frame-clock time of the first frame. */
  startMs?: number;
  /** Stretch the unit's pace (1 = natural). */
  pace?: number;
  /** Stop zone ids whose burst is dropped. */
  dropBursts?: string[];
  /** Move a stop's burst by this many ms. */
  moveBurst?: Record<string, number>;
  /** Milliseconds of silence appended. */
  tailMs?: number;
  /** Leave out the voiced frames entirely (burst-only). */
  noVoice?: boolean;
}

const base = { periodicity: 0.1, voiced: false, burst: false, clipped: false };

export function learnerStream(
  spec: GhostWordSpec,
  sized: GhostPathModel,
  unit: GhostUnit,
  opts: StreamOptions = {},
): VoiceFrame[] {
  const { lnShift = 0, lnShift2 = lnShift, startMs = 1000, pace = 1, dropBursts = [], moveBurst = {}, tailMs = 1000, noVoice = false } = opts;
  const [t0, t1] = unitWindow(sized, unit);
  const bursts = spec.zones
    .filter((z) => z.kind === 'stop' && unit.zoneIds.includes(z.id) && !dropBursts.includes(z.id))
    .map((z) => ({ id: z.id, t: sized.markers.find((m) => m.zoneId === z.id)!.t }));
  const frames: VoiceFrame[] = [];
  const total = (t1 - t0) * sized.durationMs * pace;
  const burstAt = new Map(
    bursts.map((b) => [Math.round((((b.t - t0) * sized.durationMs * pace + (moveBurst[b.id] ?? 0)) / STEP)), b.id]),
  );
  const n = Math.ceil(total / STEP) + 1;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((i * STEP) / pace / sized.durationMs);
    const g = ghostAt(sized, t);
    const ts = startMs + i * STEP;
    if (burstAt.has(i)) {
      frames.push({ ...base, timestampMs: ts, rms: 0.08, burst: true });
    } else if (g.voiced && !noVoice) {
      frames.push({
        timestampMs: ts,
        rms: 0.12,
        periodicity: 0.9,
        voiced: true,
        f1: g.f1 * Math.exp(lnShift),
        f2: g.f2 * Math.exp(lnShift2),
        burst: false,
        clipped: false,
      });
    } else {
      frames.push({ ...base, timestampMs: ts, rms: 0.001 });
    }
  }
  const end = startMs + n * STEP;
  for (let ms = 0; ms < tailMs; ms += STEP) frames.push({ ...base, timestampMs: end + ms, rms: 0.001 });
  return frames;
}
