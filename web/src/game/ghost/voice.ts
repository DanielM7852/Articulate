import { VOICE_SIZE_V1 } from '@vowel-mapper/reference/data';
import type { VoiceFrame } from '../types';
import type { GhostVoiceGroup } from './types';

/** Karsten's ln voice factor when the voice group is unknown: the reference size. */
export const DEFAULT_FACTOR = 0;

/**
 * Tracked points a held "uh" needs (about 300 ms at the 25 ms hop). Mirrors MIN_POINTS in
 * vowel-mapper/src/reference/check.ts.
 *
 * Karsten's check.ts / targets.ts / head.ts are not imported because web's tsconfig does not set
 * allowImportingTsExtensions (check.ts imports './data.ts'), so tsc rejects them. The rule below is
 * the same arithmetic as holdValue() and uhFactor() there, fed by his data.ts constants through the
 * alias. If web/tsconfig.json gains allowImportingTsExtensions, swap these for the real imports.
 */
export const MIN_UH_POINTS = 12;

const GROUP: Record<GhostVoiceGroup, keyof typeof VOICE_SIZE_V1.groupFactor> = {
  man: 'men',
  woman: 'women',
  boy: 'boys',
  girl: 'girls',
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * "uh" + voice group: the mean of the factor read from a held "uh" (log-median F1 and F2 against the
 * reference "uh") and the chosen group's mean factor.
 */
export function voiceFactor(
  uhFrames: VoiceFrame[],
  group: GhostVoiceGroup,
): { factor: number; ok: boolean; reason?: string } {
  const points = uhFrames.flatMap((frame) =>
    frame.voiced && frame.f1 !== undefined && frame.f2 !== undefined && frame.f1 > 0 && frame.f2 > 0
      ? [{ ln1: Math.log(frame.f1), ln2: Math.log(frame.f2) }]
      : [],
  );
  if (points.length < MIN_UH_POINTS) {
    return { factor: DEFAULT_FACTOR, ok: false, reason: 'Hold "uh" a little longer so it can be measured.' };
  }
  const fromUh = (median(points.map((p) => p.ln1)) - VOICE_SIZE_V1.uh[0] + median(points.map((p) => p.ln2)) - VOICE_SIZE_V1.uh[1]) / 2;
  return { factor: (fromUh + VOICE_SIZE_V1.groupFactor[GROUP[group]]) / 2, ok: true };
}
