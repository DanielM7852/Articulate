import { expect, test } from '../../game/__tests__/harness';
import { THINKING_FILLERS } from '../../realtime/fillers';
import { BAKED_LINES, GREETING, QUIZ_LINES, WELCOME_BACK } from '../bakedLines';
import { lookupBaked, phonemesFromBlock, wordsFromBlock, type BakedManifest } from '../bakedVoice';

const entry = { file: '/voice/x.wav', durationS: 1, words: [{ text: 'hi', start: 0, end: 0.5 }], phonemes: [{ p: 'h', start: 0, end: 0.1 }] };
const m: BakedManifest = { 'Hello there.': entry };

test('baked lookup: exact hit', () => {
  expect(lookupBaked(m, 'Hello there.')?.file).toBe('/voice/x.wav');
  expect(lookupBaked(m, 'Hello there.', 1)?.file).toBe('/voice/x.wav');
  expect(lookupBaked(m, 'Hello there.', null)?.file).toBe('/voice/x.wav');
});

test('baked lookup: miss and no manifest', () => {
  expect(lookupBaked(m, 'Hello there')).toBe(null);
  expect(lookupBaked(m, 'toString')).toBe(null);
  expect(lookupBaked(null, 'Hello there.')).toBe(null);
});

test('baked lookup: speed other than 1 goes live', () => {
  expect(lookupBaked(m, 'Hello there.', 0.8)).toBe(null);
  expect(lookupBaked(m, 'Hello there.', 1.2)).toBe(null);
});

test('baked lines: all distinct lines', () => {
  const total = GREETING.length + WELCOME_BACK.length + QUIZ_LINES.length + THINKING_FILLERS.length;
  expect(BAKED_LINES.length).toBe(total);
  expect(new Set(BAKED_LINES).size).toBe(total);
});

test('timestamp blocks convert like the live path', () => {
  expect(wordsFromBlock({ words: ['a', 'b'], start: [0, 0.2], end: [0.2, 0.4] }).length).toBe(2);
  expect(phonemesFromBlock({ phonemes: ['x'], start: [0.1], end: [0.2] })[0].p).toBe('x');
  expect(wordsFromBlock(undefined).length).toBe(0);
});
