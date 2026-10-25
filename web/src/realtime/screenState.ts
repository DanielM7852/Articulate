import type { MouthCueId } from '@mouth-demo/src/mouth-demo.js';

/**
 * What the learner sees and can do in the word lesson, as one short "On screen: ..." message for Ava
 * (sendAppMessage adds the "[app] " prefix). Pure: WordLesson computes the ScreenState from the same guards the
 * show_demo / lesson_control handlers use, so what she is told she can do is what the handlers will accept.
 */
export interface ScreenState {
  word: string;
  /** stepLabel output, for example "Part 1 of 3 · a" or "Whole word". */
  step: string;
  view: 'front' | 'side';
  cue: MouthCueId | null;
  /** Caption of the last feedback line given, if any. */
  feedback: string | null;
  canMouthCue: boolean;
  canSideView: boolean;
  canGhostPath: boolean;
  canNextPart: boolean;
  canRepeatPart: boolean;
  canTryNow: boolean;
  canNextWord: boolean;
  canFinish: boolean;
}

export const SCREEN_STATE_MAX = 350;
const FEEDBACK_MAX = 70;

const CUE_NAME: Record<MouthCueId, string> = {
  'open-jaw': 'open-jaw mouth shape',
  'spread-lips': 'spread-lips mouth shape',
  'round-lips': 'round-lips mouth shape',
  'tongue-tip': 'tongue-tip side view',
  'tongue-tip-r': 'tongue tip into the r side view',
  'tongue-r': 'r tongue side view',
  'tongue-back': 'back-of-the-tongue side view',
};
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const ORDINAL_WORDS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** Ava never hears digits: small numbers become words, anything else numeric is dropped. */
function noDigits(text: string): string {
  return text
    .replace(/(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) => ORDINAL_WORDS[Number(n)] ?? '')
    .replace(/\d+/g, (m) => NUMBER_WORDS[Number(m)] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function screenStateMessage(s: ScreenState): string {
  const parts = [`On screen: the word "${noDigits(s.word)}", ${noDigits(s.step)}`];
  parts.push(`${s.view} view`);
  parts.push(s.cue ? `showing the ${CUE_NAME[s.cue]}` : 'no mouth cue');
  let fb = s.feedback ? noDigits(s.feedback) : '';
  if (fb.length > FEEDBACK_MAX) fb = '';
  parts.push(fb ? `last feedback "${fb}"` : 'no feedback yet');
  let msg = parts.join('; ') + '.';

  const show: string[] = [];
  if (s.canMouthCue) show.push('mouth cue');
  if (s.canSideView) show.push('side view');
  if (s.canGhostPath) show.push('ghost path');
  const doo: string[] = [];
  if (s.canNextPart) doo.push('next part');
  if (s.canRepeatPart) doo.push('repeat part');
  if (s.canTryNow) doo.push('try now');
  if (s.canNextWord) doo.push('next word');
  if (s.canFinish) doo.push('finish');
  msg += ` You can show: ${show.length ? show.join(', ') : 'nothing right now'}.`;
  msg += ` You can do: ${doo.length ? doo.join(', ') : 'nothing right now'}.`;
  return noDigits(msg).slice(0, SCREEN_STATE_MAX);
}
