/** Vowels the warm-up sets; the only sounds the game judges. */
export type VowelId = 'ee' | 'ah' | 'oo';
export const VOWELS: readonly VowelId[] = ['ee', 'ah', 'oo'];

export const VOWEL_LABEL: Record<VowelId, { sound: string; example: string }> = {
  ee: { sound: 'eee', example: 'sheep' },
  ah: { sound: 'ah', example: 'father' },
  oo: { sound: 'oo', example: 'boot' },
};

type Formants = { f1: number; f2: number };

/** A personal target: a circle in log-frequency space around the player's own median. */
export interface Zone extends Formants {
  vowel: VowelId;
  /** Radius in natural-log units, applied to both ln F1 and ln F2. */
  radius: number;
}

export type ZoneSet = Record<VowelId, Zone>;

export function zoneDistance(point: Formants, zone: Formants): number {
  return Math.hypot(Math.log(point.f1 / zone.f1), Math.log(point.f2 / zone.f2));
}

export function inZone(point: Formants, zone: Zone): boolean {
  return zoneDistance(point, zone) <= zone.radius;
}

/** Boundary points in Hz; draw them with `projectVowel` so the plot geometry stays in one place. */
export function zoneOutline(zone: Zone, steps = 48): Formants[] {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * 2 * Math.PI;
    return { f1: zone.f1 * Math.exp(zone.radius * Math.sin(angle)), f2: zone.f2 * Math.exp(zone.radius * Math.cos(angle)) };
  });
}
