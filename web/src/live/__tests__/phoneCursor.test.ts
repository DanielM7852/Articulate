import { expect, test } from '../../game/__tests__/harness';
import { isNoisePhone, mergeHeard, phoneCursorState } from '../phoneCursor';
import type { Phone } from '../phoneStream';

const ph = (p: string, startMs: number, conf = 0.9): Phone => ({ p, startMs, endMs: startMs + 60, conf });
const seq = (...ps: string[]): Phone[] => ps.map((p, i) => ph(p, i * 100));
const T = ['t', 'ɹ', 'æ', 'k'];

test('phoneCursor: in-order matching advances', () => {
  expect(phoneCursorState(T, []).matched).toBe(0);
  expect(phoneCursorState(T, seq('t')).matched).toBe(1);
  expect(phoneCursorState(T, seq('t', 'ɹ', 'æ')).matched).toBe(3);
  const all = phoneCursorState(T, seq('t', 'ɹ', 'æ', 'k'));
  expect(all.matched).toBe(4);
  expect(all.veer).toBe(false);
  expect(all.lastPhone).toBe('k');
});

test('phoneCursor: r folds to ɹ and aspiration is stripped', () => {
  expect(phoneCursorState(T, seq('tʰ', 'r', 'æ', 'kʰ')).matched).toBe(4);
});

test('phoneCursor: wrong phone veers, right phone recovers', () => {
  const wrong = phoneCursorState(T, seq('t', 'w'));
  expect(wrong.matched).toBe(1);
  expect(wrong.veer).toBe(true);
  const back = phoneCursorState(T, seq('t', 'w', 'ɹ'));
  expect(back.matched).toBe(2);
  expect(back.veer).toBe(false);
});

test('phoneCursor: one schwa between targets is tolerated, a second is not', () => {
  const one = phoneCursorState(T, seq('t', 'ɹ', 'ə', 'æ'));
  expect(one.matched).toBe(3);
  expect(one.veer).toBe(false);
  expect(phoneCursorState(T, seq('t', 'ɹ', 'ə', 'ə')).veer).toBe(true);
});

test('phoneCursor: low confidence and noise are ignored', () => {
  expect(phoneCursorState(T, [ph('t', 0), ph('s', 100, 0.1)]).veer).toBe(false);
  expect(phoneCursorState(T, seq('t', 'ʔ', '<unk>', '', 'ɹ')).matched).toBe(2);
  expect(isNoisePhone('ʔ')).toBe(true);
  expect(isNoisePhone('æ')).toBe(false);
});

test('phoneCursor: repeats ignored, skipped targets jump, extras after the end ignored', () => {
  expect(phoneCursorState(T, seq('t', 't', 'ɹ')).matched).toBe(2);
  expect(phoneCursorState(T, seq('t', 'æ')).matched).toBe(3);
  const done = phoneCursorState(T, seq('t', 'ɹ', 'æ', 'k', 's'));
  expect(done.matched).toBe(4);
  expect(done.veer).toBe(false);
});

test('phoneCursor: provisional retraction settles back', () => {
  const committed = [ph('t', 0)];
  expect(phoneCursorState(T, mergeHeard(committed, [ph('ɹ', 120)])).matched).toBe(2);
  expect(phoneCursorState(T, mergeHeard(committed, [ph('w', 120)])).veer).toBe(true);
  const settled = phoneCursorState(T, mergeHeard(committed, []));
  expect(settled.matched).toBe(1);
  expect(settled.veer).toBe(false);
});

test('phoneCursor: mergeHeard drops provisional overlapping committed', () => {
  const merged = mergeHeard([ph('t', 0), ph('ɹ', 100)], [ph('ɹ', 100), ph('æ', 200)]);
  expect(merged.map((p) => p.p).join('')).toBe('tɹæ');
});
