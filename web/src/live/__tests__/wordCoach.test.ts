import { expect, test } from '../../game/__tests__/harness';
import type { WordAttemptResult } from '../../game/types';
import { wordFallbackLine } from '../wordCoach';

const spec = {
  zones: [
    { id: 't', label: 't' },
    { id: 'r', label: 'r' },
    { id: 'a', label: 'a' },
    { id: 'ck', label: 'ck' },
  ],
};
const bad = (qualityReason: WordAttemptResult['qualityReason']): WordAttemptResult => ({
  word: 'track',
  attemptId: 'x',
  durationMs: 500,
  zones: [],
  quality: 'unclear',
  qualityReason,
  lipUsable: false,
});

test('wordFallbackLine: a part practice names the part', () => {
  expect(wordFallbackLine(spec, bad('no-voice'), ['t', 'r']).caption).toBe(
    "I couldn't catch the tr in track that time. Say it once more, clear and steady.",
  );
  expect(wordFallbackLine(spec, bad('clipped'), ['ck']).caption).toBe('That was a bit loud for me. Say the ck in track once more, a little softer.');
  expect(wordFallbackLine(spec, bad('too-short'), ['a']).caption).toBe('That went by quickly. Say the a in track once more, at an easy pace.');
});

test('wordFallbackLine: no practice or full coverage names the word', () => {
  const line = "I couldn't catch track that time. Say it once more, clear and steady.";
  expect(wordFallbackLine(spec, bad('no-voice')).caption).toBe(line);
  expect(wordFallbackLine(spec, bad('no-voice'), ['t', 'r', 'a', 'ck']).caption).toBe(line);
  expect(wordFallbackLine(spec, bad('clipped')).caption).toBe('That was a bit loud for me. Say track once more, a little softer.');
  expect(wordFallbackLine(spec, bad('too-short')).caption).toBe('That went by quickly. Say track once more, at an easy pace.');
});
