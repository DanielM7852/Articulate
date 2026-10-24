import type { WordSpec } from './types';

/**
 * Demo word: "track" = t, r, a, ck.
 * The vowel target is the /ae/ region for an average adult speaker. The r tuner reads
 * the F3-F2 gap: a good English r pulls F3 down toward F2. Stops are scored on a
 * detected release burst, not on position. Values are starting points, not clinical norms.
 */
export const TRACK: WordSpec = {
  word: 'track',
  paceMs: 1400,
  zones: [
    {
      id: 't',
      phoneme: 't',
      label: 't',
      kind: 'stop',
      stop: { place: 'alveolar' },
      holdMs: 0,
      hint: 'Tongue tip up behind the teeth, then let go.',
    },
    {
      id: 'r',
      phoneme: 'r',
      label: 'r',
      kind: 'tuner',
      tuner: { quantity: 'f3gap', lowHz: 0, highHz: 600, minHz: 0, maxHz: 1600, pushTo: 'low' },
      holdMs: 250,
      hint: 'Curl the tongue tip back, or bunch it up. Pull the needle down.',
    },
    {
      id: 'a',
      phoneme: 'ae',
      label: 'a',
      kind: 'vowel',
      vowel: { f1: 720, f2: 1850, rx: 320, ry: 170 },
      holdMs: 220,
      hint: 'Jaw open, tongue low and forward.',
    },
    {
      id: 'k',
      phoneme: 'k',
      label: 'ck',
      kind: 'stop',
      stop: { place: 'velar' },
      holdMs: 0,
      hint: 'Back of the tongue up, then release.',
    },
  ],
};

export const WORDS: Record<string, WordSpec> = { track: TRACK };
