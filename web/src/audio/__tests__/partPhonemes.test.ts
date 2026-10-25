import { expect, test } from '../../game/__tests__/harness';
import { ipaSymbols, spreadPhonemes } from '../partPhonemes';

test('ipaSymbols: single IPA group only', () => {
  expect(ipaSymbols('<<t|ɹ|æ>>')?.join(',')).toBe('t,ɹ,æ');
  expect(ipaSymbols('<<ˈæ|t>>')?.join(',')).toBe('æ,t');
  expect(ipaSymbols('eee')).toBe(null);
  expect(ipaSymbols('hi <<æ>>')).toBe(null);
});

test('spreadPhonemes: contiguous, bounded, stops short', () => {
  const r = spreadPhonemes(['t', 'ɹ', 'æ'], 0.02, 0.6);
  expect(r.length).toBe(3);
  expect(r[0].start).toBe(0.02);
  expect(r[2].end).toBe(0.6);
  expect(r[0].end - r[0].start).toBe(0.06);
  expect(r[1].start).toBe(r[0].end);
  expect(r[2].start).toBe(r[1].end);
});

test('spreadPhonemes: cut keeps leading symbols', () => {
  const r = spreadPhonemes(['æ', 't'], 0.02, 0.19, { cut: 1 });
  expect(r.length).toBe(1);
  expect(r[0].p).toBe('æ');
  expect(r[0].end).toBe(0.19);
});
