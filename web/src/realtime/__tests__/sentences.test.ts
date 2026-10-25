import { expect, test } from '../../game/__tests__/harness';
import { heardPrefix, revealedText } from '../sentences';

const segs = [{ text: 'Nice try.' }, { text: 'Let us go again, slowly.' }, { text: 'Ready?' }];

test('revealedText: nothing before audio starts', () => {
  expect(revealedText(segs, -1)).toBe('');
  expect(revealedText([], 0)).toBe('');
});

test('revealedText: reveals a sentence when its first word starts', () => {
  expect(revealedText(segs, 0)).toBe('Nice try.');
  expect(revealedText(segs, 1)).toBe('Nice try.');
  expect(revealedText(segs, 2)).toBe('Nice try. Let us go again, slowly.');
  expect(revealedText(segs, 6)).toBe('Nice try. Let us go again, slowly.');
  expect(revealedText(segs, 7)).toBe('Nice try. Let us go again, slowly. Ready?');
});

test('revealedText: index past the end shows everything', () => {
  expect(revealedText(segs, 999)).toBe('Nice try. Let us go again, slowly. Ready?');
});

test('heardPrefix: zero, partial, beyond, odd spacing', () => {
  expect(heardPrefix('Nice try. Go again.', 0)).toBe('');
  expect(heardPrefix('Nice try. Go again.', -3)).toBe('');
  expect(heardPrefix('Nice try. Go again.', 3)).toBe('Nice try. Go');
  expect(heardPrefix('Nice try. Go again.', 4)).toBe('Nice try. Go again.');
  expect(heardPrefix('Nice try. Go again.', 40)).toBe('Nice try. Go again.');
  expect(heardPrefix('  Nice   try.  Go ', 2)).toBe('Nice try.');
  expect(heardPrefix('', 2)).toBe('');
});
