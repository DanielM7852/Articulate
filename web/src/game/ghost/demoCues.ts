import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';

/**
 * Presentation-only mapping from zone ids to the mouth-demo cue that shows the target. It is separate from
 * the backend ZONE_CUE (liveCoach CueId), which stays the coaching contract. A demo shows the target and
 * never claims what the learner did.
 */
const TIP_ZONES = new Set(['t', 'n', 'd']);

/** The cue for one lesson part (a unit of zones), or null when it has none. */
export function unitDemoCue(zoneIds: readonly string[]): MouthCueId | null {
  if (zoneIds.length === 2 && zoneIds[0] === 't' && zoneIds[1] === 'r') return 'tongue-tip-r';
  if (zoneIds.length > 0 && zoneIds.every((z) => TIP_ZONES.has(z))) return 'tongue-tip';
  if (zoneIds.length === 1) return zoneDemoCue(zoneIds[0]);
  return null;
}

/** The cue for a single coaching focus zone, or null. */
export function zoneDemoCue(zoneId: string | null): MouthCueId | null {
  switch (zoneId) {
    case 't':
    case 'n':
    case 'd':
      return 'tongue-tip';
    case 'r':
      return 'tongue-r';
    case 'k':
    case 'g':
      return 'tongue-back';
    case 'a':
      return 'open-jaw';
    case 'ee':
      return 'spread-lips';
    default:
      return null;
  }
}
