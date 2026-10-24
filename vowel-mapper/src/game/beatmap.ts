import type { VowelId } from './zones';

/** The only judged notes: a glide between two zones, or a steady hold in one. */
export type NoteSpec =
  | { kind: 'glide'; from: VowelId; to: VowelId }
  | { kind: 'hold'; vowel: VowelId; holdMs: number };

/**
 * Part of the written word. A segment either maps to vowel sounds (judged as part of the note)
 * or carries a visual cue for a consonant, which is shown and never scored.
 */
export interface Segment {
  letters: string;
  sounds?: VowelId[];
  cue?: string;
}

export interface Step {
  id: string;
  word: string;
  segments: Segment[];
  note: NoteSpec;
}

/**
 * First beatmap. Words avoid n and m: a voiced nasal hum is tracked as a vowel near "eh" and
 * would land in or between zones. "h" is breath only, so the tracker hears nothing there.
 */
export const FIRST_BEATMAP: Step[] = [
  { id: 'ah', word: 'ah', segments: [{ letters: 'ah', sounds: ['ah'] }], note: { kind: 'hold', vowel: 'ah', holdMs: 700 } },
  { id: 'hi', word: 'hi', segments: [{ letters: 'h', cue: 'breath only' }, { letters: 'i', sounds: ['ah', 'ee'] }], note: { kind: 'glide', from: 'ah', to: 'ee' } },
  { id: 'how', word: 'how', segments: [{ letters: 'h', cue: 'breath only' }, { letters: 'ow', sounds: ['ah', 'oo'] }], note: { kind: 'glide', from: 'ah', to: 'oo' } },
  { id: 'we', word: 'we', segments: [{ letters: 'w', sounds: ['oo'] }, { letters: 'e', sounds: ['ee'] }], note: { kind: 'glide', from: 'oo', to: 'ee' } },
];
