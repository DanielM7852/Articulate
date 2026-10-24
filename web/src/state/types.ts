export type SoundId = 'i' | 'u' | 'a';

export type Goal = 'conversations' | 'sounds' | 'longer' | 'visual';
export type Routine = 'exploring' | 'occasional' | 'regular' | 'partner';
export type Pace = 'unhurried' | 'steady' | 'flexible';
export type Support = 'mouth' | 'words' | 'hear' | 'self';
export type Guidance = 'guided' | 'explore';
export type Assistance = 'cue-target' | 'target-only' | 'none';

/** Null means not answered yet; the quiz never pre-selects. */
export interface Preferences {
  goals: Goal[];
  routine: Routine | null;
  pace: Pace | null;
  support: Support | null;
  guidance: Guidance | null;
}

export interface Plan {
  pace: Pace;
  assistance: Assistance;
  sound: SoundId;
}

export type AttemptKind = 'baseline' | 'guided' | 'independent';

/**
 * Summary of one attempt. Mirrors the attempt record in the roadmap so the
 * backend can fill the same shape. Fields the browser cannot measure yet
 * (formant-based target metrics) stay null until the measurement service sends them.
 */
export interface Attempt {
  attemptId: string;
  sound: SoundId;
  kind: AttemptKind;
  assistance: Assistance;
  startedAt: number;
  durationSec: number;
  usableVoicedSec: number;
  timeInTargetSec: number | null;
  longestHoldSec: number | null;
  quality: 'usable' | 'unclear';
  qualityReason?: 'silence' | 'clipping' | 'too-short' | 'no-mic';
  recognizedText: string | null;
  feeling?: 'too-hard' | 'okay' | 'ready';
}

export interface SoundInfo {
  id: SoundId;
  ipa: string;
  spelled: string;
  example: string;
  cue: string;
  tongue: string;
  lips: string;
}

export const SOUNDS: Record<SoundId, SoundInfo> = {
  i: {
    id: 'i',
    ipa: '/i/',
    spelled: 'ee',
    example: 'see',
    cue: 'Tongue forward, lips gently spread.',
    tongue: 'Tongue raised at the front',
    lips: 'Lips gently spread, not rounded',
  },
  u: {
    id: 'u',
    ipa: '/u/',
    spelled: 'oo',
    example: 'food',
    cue: 'Tongue back and high, lips rounded.',
    tongue: 'Tongue raised at the back',
    lips: 'Lips rounded and forward',
  },
  a: {
    id: 'a',
    ipa: '/ɑ/',
    spelled: 'ah',
    example: 'father',
    cue: 'Jaw open, tongue low and relaxed.',
    tongue: 'Tongue low in the mouth',
    lips: 'Lips open and relaxed',
  },
};

export const SOUND_ORDER: SoundId[] = ['i', 'u', 'a'];
