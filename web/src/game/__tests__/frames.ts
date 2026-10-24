import type { VoiceFrame } from '../types';

/** Synthetic VoiceFrame streams: a tiny script of segments rendered at a fixed frame step. */
export type Segment =
  | { kind: 'silence'; ms: number }
  | { kind: 'burst' }
  | { kind: 'noise'; ms: number }
  | { kind: 'voice'; ms: number; f1: number; f2: number; f3?: number; clipped?: boolean };

export const STEP_MS = 10;

export function render(segments: Segment[], startMs = 1000, stepMs = STEP_MS): VoiceFrame[] {
  const frames: VoiceFrame[] = [];
  let t = startMs;
  const base = { periodicity: 0.1, voiced: false, burst: false, clipped: false };
  for (const seg of segments) {
    if (seg.kind === 'burst') {
      frames.push({ ...base, timestampMs: t, rms: 0.08, burst: true });
      t += stepMs;
      continue;
    }
    const n = Math.round(seg.ms / stepMs);
    for (let i = 0; i < n; i++, t += stepMs) {
      if (seg.kind === 'silence') frames.push({ ...base, timestampMs: t, rms: 0.001 });
      else if (seg.kind === 'noise') frames.push({ ...base, timestampMs: t, rms: 0.02 });
      else {
        frames.push({
          timestampMs: t,
          rms: 0.12,
          periodicity: 0.9,
          voiced: true,
          f1: seg.f1,
          f2: seg.f2,
          ...(seg.f3 !== undefined ? { f3: seg.f3 } : {}),
          burst: false,
          clipped: Boolean(seg.clipped),
        });
      }
    }
  }
  return frames;
}

/** r with a low F3 (gap 350 Hz: in the band). */
export const R_GOOD = { f1: 450, f2: 1300, f3: 1650 };
/** Flat r: gap 900 Hz, never in the band. */
export const R_FLAT = { f1: 450, f2: 1300, f3: 2200 };
/** /ae/ inside the "track" target; F3 high so the gap is out of the r band. */
export const AE = { f1: 720, f2: 1850, f3: 2650 };

export const goodTrack = (): Segment[] => [
  { kind: 'silence', ms: 200 },
  { kind: 'burst' },
  { kind: 'noise', ms: 40 },
  { kind: 'voice', ms: 280, ...R_GOOD },
  { kind: 'voice', ms: 320, ...AE },
  { kind: 'silence', ms: 80 },
  { kind: 'burst' },
  { kind: 'silence', ms: 900 },
];
