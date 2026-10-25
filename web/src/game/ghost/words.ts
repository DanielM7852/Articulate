import type { ZoneKind } from '../types';

/**
 * The four ghost-path words. Zones, phonemes and parts are a fixed contract shared with the backend:
 * do not rename ids. Hints are body instructions only; they never describe what the learner did.
 */
export interface GhostZoneSpec {
  id: string;
  /** Phoneme label for the backend, e.g. "ae". */
  phoneme: string;
  /** What the learner sees, e.g. "ck". */
  label: string;
  kind: ZoneKind;
  hint: string;
}

export interface GhostPartSpec {
  id: string;
  label: string;
  zoneIds: string[];
}

export interface GhostWordSpec {
  word: string;
  zones: GhostZoneSpec[];
  parts: GhostPartSpec[];
}

const R_HINT = 'Curl the tongue tip back, or bunch it up. Lips a little round.';
const N_HINT = 'Tongue tip on the ridge behind the teeth, voice through the nose.';

const TRACK: GhostWordSpec = {
  word: 'track',
  zones: [
    { id: 't', phoneme: 't', label: 't', kind: 'stop', hint: 'Tongue tip up behind the teeth, then let go.' },
    { id: 'r', phoneme: 'r', label: 'r', kind: 'liquid', hint: R_HINT },
    { id: 'a', phoneme: 'ae', label: 'a', kind: 'vowel', hint: 'Jaw open, tongue low and forward.' },
    { id: 'k', phoneme: 'k', label: 'ck', kind: 'stop', hint: 'Back of the tongue up, then release.' },
  ],
  parts: [
    { id: 'tr', label: 'tr', zoneIds: ['t', 'r'] },
    { id: 'a', label: 'a', zoneIds: ['a'] },
    { id: 'ck', label: 'ck', zoneIds: ['k'] },
  ],
};

const SHEEP: GhostWordSpec = {
  word: 'sheep',
  zones: [
    { id: 'sh', phoneme: 'sh', label: 'sh', kind: 'fricative', hint: 'Lips pushed forward, a wide soft hiss.' },
    { id: 'ee', phoneme: 'iy', label: 'ee', kind: 'vowel', hint: 'Lips spread, tongue high and forward.' },
    { id: 'p', phoneme: 'p', label: 'p', kind: 'stop', hint: 'Close both lips, then pop them open.' },
  ],
  parts: [
    { id: 'sh', label: 'sh', zoneIds: ['sh'] },
    { id: 'ee', label: 'ee', zoneIds: ['ee'] },
    { id: 'p', label: 'p', zoneIds: ['p'] },
  ],
};

const RENT: GhostWordSpec = {
  word: 'rent',
  zones: [
    { id: 'r', phoneme: 'r', label: 'r', kind: 'liquid', hint: R_HINT },
    { id: 'e', phoneme: 'eh', label: 'e', kind: 'vowel', hint: 'Jaw half open, tongue mid and forward.' },
    { id: 'n', phoneme: 'n', label: 'n', kind: 'nasal', hint: N_HINT },
    { id: 't', phoneme: 't', label: 't', kind: 'stop', hint: 'Tongue tip up behind the teeth, then let go.' },
  ],
  parts: [
    { id: 'r', label: 'r', zoneIds: ['r'] },
    { id: 'e', label: 'e', zoneIds: ['e'] },
    { id: 'nt', label: 'nt', zoneIds: ['n', 't'] },
  ],
};

const BRAIN: GhostWordSpec = {
  word: 'brain',
  zones: [
    { id: 'b', phoneme: 'b', label: 'b', kind: 'stop', hint: 'Close both lips with voice on, then open them.' },
    { id: 'r', phoneme: 'r', label: 'r', kind: 'liquid', hint: R_HINT },
    { id: 'ai', phoneme: 'ey', label: 'ai', kind: 'vowel', hint: 'Start mid, then glide the tongue up and forward.' },
    { id: 'n', phoneme: 'n', label: 'n', kind: 'nasal', hint: N_HINT },
  ],
  parts: [
    { id: 'br', label: 'br', zoneIds: ['b', 'r'] },
    { id: 'ai', label: 'ai', zoneIds: ['ai'] },
    { id: 'n', label: 'n', zoneIds: ['n'] },
  ],
};

export const GHOST_WORDS: Record<string, GhostWordSpec> = {
  track: TRACK,
  sheep: SHEEP,
  rent: RENT,
  brain: BRAIN,
};
