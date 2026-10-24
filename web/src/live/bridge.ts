/**
 * Code-chosen line the teacher says the moment the learner stops, while the coach call runs.
 * Deterministic, warm, never judgemental, and it only restates what the device measured.
 */
export interface BridgeInput {
  sound: 'i' | 'u' | 'a';
  timeInTargetSec: number | null;
  longestHoldSec: number | null;
  usableVoicedSec: number;
  quality: string;
  lipTracking: boolean;
}

const MAX_WORDS = 14;

const round1 = (n: number | null): string | null =>
  n !== null && Number.isFinite(n) && n > 0 ? (Math.round(n * 10) / 10).toFixed(1) : null;

const words = (s: string) => s.trim().split(/\s+/).length;

export function bridgeLine(input: BridgeInput): string {
  const voiced = round1(input.usableVoicedSec);
  if (input.quality !== 'usable' || !voiced) return 'I couldn’t hear much that time. One moment…';

  const hold = round1(input.longestHoldSec);
  const inTarget = round1(input.timeInTargetSec);
  const voice = voiced;

  const candidates: string[] = [];
  if (hold) {
    if (input.lipTracking) candidates.push(`Got it. You held it for ${hold} seconds. Checking your sound and mouth shape…`);
    candidates.push(`Got it. You held it for ${hold} seconds. Let me look closer…`);
  } else if (inTarget) {
    candidates.push(`Got it. About ${inTarget} seconds in the target area. Let me look closer…`);
  } else {
    candidates.push(`Got it. I heard ${voice} seconds of voice. Let me look closer…`);
  }
  candidates.push('Got it. Let me look at your sound…');

  return candidates.find((c) => words(c) <= MAX_WORDS) ?? 'Got it. Let me look at your sound…';
}
