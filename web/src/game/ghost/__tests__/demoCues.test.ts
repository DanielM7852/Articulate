import { expect, test } from '../../__tests__/harness';
import { unitDemoCue, zoneDemoCue } from '../demoCues';
import { GHOST_WORDS } from '../words';

const partCues = (word: string) => GHOST_WORDS[word].parts.map((p) => unitDemoCue(p.zoneIds) ?? 'none').join(' ');

test('demoCues: track parts', () => {
  expect(partCues('track')).toBe('tongue-tip-r open-jaw tongue-back');
});

test('demoCues: rent parts', () => {
  expect(partCues('rent')).toBe('tongue-r none tongue-tip');
});

test('demoCues: sheep parts', () => {
  expect(partCues('sheep')).toBe('none spread-lips none');
});

test('demoCues: whole words and empty units have no cue', () => {
  expect(unitDemoCue(['t', 'r', 'a', 'k'])).toBe(null);
  expect(unitDemoCue([])).toBe(null);
});

test('demoCues: zoneDemoCue', () => {
  expect(zoneDemoCue('t')).toBe('tongue-tip');
  expect(zoneDemoCue('n')).toBe('tongue-tip');
  expect(zoneDemoCue('r')).toBe('tongue-r');
  expect(zoneDemoCue('k')).toBe('tongue-back');
  expect(zoneDemoCue('a')).toBe('open-jaw');
  expect(zoneDemoCue('ee')).toBe('spread-lips');
  expect(zoneDemoCue('sh')).toBe(null);
  expect(zoneDemoCue(null)).toBe(null);
});
