import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';
import type { GhostPartSpec, GhostWordSpec } from './words';
import { partSound, type PartSound } from './partSounds';

/**
 * Presentation-only mapping from zone ids to the mouth-demo cue that shows the target. It is separate from
 * the backend ZONE_CUE (liveCoach CueId), which stays the coaching contract. A demo shows the target and
 * never claims what the learner did.
 */
const TIP_ZONES = new Set(['t', 'n', 'd']);

/** The cue for one lesson part (a unit of zones), or null when it has none. */
export function unitDemoCue(zoneIds: readonly string[]): MouthCueId | null {
  if (zoneIds.length === 1) return zoneDemoCue(zoneIds[0]);
  if (zoneIds.length === 2 && zoneIds[0] === 't' && zoneIds[1] === 'r') return 'tongue-tip-r';
  if (zoneIds.length === 2 && zoneIds[0] === 'b' && zoneIds[1] === 'r') return 'lips-close-r';
  if (zoneIds.length > 0 && zoneIds.every((z) => TIP_ZONES.has(z))) return 'tongue-tip';
  return null;
}

/** The cue for a single coaching focus zone, or null. */
export function zoneDemoCue(zoneId: string | null): MouthCueId | null {
  switch (zoneId) {
    case 't':
    case 'd':
      return 'tongue-tip';
    case 'n':
      return 'tongue-tip-n';
    case 'r':
      return 'tongue-r';
    case 'k':
    case 'g':
      return 'tongue-back';
    case 'a':
      return 'open-jaw';
    case 'ee':
      return 'spread-lips';
    case 'e':
      return 'mid-jaw';
    case 'ai':
      return 'glide-ey';
    case 'sh':
      return 'tongue-sh';
    case 'p':
      return 'lips-close';
    case 'b':
      return 'lips-close-voiced';
    default:
      return null;
  }
}

/** The lesson part that contains a zone (a coaching focus zone), or null. */
export function partForZone(spec: GhostWordSpec, zoneId: string | null): GhostPartSpec | null {
  if (!zoneId) return null;
  return spec.parts.find((p) => p.zoneIds.includes(zoneId)) ?? null;
}

/** What Ava pronounces for one lesson part: its prebaked sound and the side cue that shows it. */
export interface PartPronounce {
  part: GhostPartSpec;
  sound: PartSound;
  cueId: MouthCueId | null;
}

/** The part's pronunciation (sound plus cue), or null when the part has no sound. */
export function partPronounce(spec: GhostWordSpec, part: GhostPartSpec | null): PartPronounce | null {
  if (!part) return null;
  const sound = partSound(spec.word, part.id);
  return sound ? { part, sound, cueId: unitDemoCue(part.zoneIds) } : null;
}

/**
 * The pronunciation for a lesson unit: a part step (single part id) uses that part; a whole-word step maps the
 * focus zone to the part containing it. Null when there is nothing to pronounce.
 */
export function stepPronounce(
  spec: GhostWordSpec,
  unit: { id: string; partIds: readonly string[] },
  focusZoneId: string | null,
): PartPronounce | null {
  const id = unit.partIds.length === 1 ? unit.partIds[0] : unit.id;
  const own = spec.parts.find((p) => p.id === id);
  if (own) return partPronounce(spec, own);
  return partPronounce(spec, partForZone(spec, focusZoneId));
}
