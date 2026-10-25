import { expect, test } from '../../__tests__/harness';
import { unitDemoCue, zoneDemoCue } from '../demoCues';
import { GHOST_WORDS } from '../words';

const partCues = (word: string) => GHOST_WORDS[word].parts.map((p) => unitDemoCue(p.zoneIds) ?? 'none').join(' ');

test('demoCues: track parts', () => {
  expect(partCues('track')).toBe('tongue-tip-r open-jaw tongue-back');
});

test('demoCues: rent parts', () => {
  expect(partCues('rent')).toBe('tongue-r mid-jaw tongue-tip');
});

test('demoCues: sheep parts', () => {
  expect(partCues('sheep')).toBe('tongue-sh spread-lips lips-close');
});

test('demoCues: brain parts', () => {
  expect(partCues('brain')).toBe('lips-close-r glide-ey tongue-tip-n');
});

test('demoCues: whole words and empty units have no cue', () => {
  expect(unitDemoCue(['t', 'r', 'a', 'k'])).toBe(null);
  expect(unitDemoCue([])).toBe(null);
  expect(unitDemoCue(['n', 't'])).toBe('tongue-tip');
  expect(unitDemoCue(['n'])).toBe('tongue-tip-n');
});

test('demoCues: zoneDemoCue', () => {
  expect(zoneDemoCue('t')).toBe('tongue-tip');
  expect(zoneDemoCue('n')).toBe('tongue-tip-n');
  expect(zoneDemoCue('r')).toBe('tongue-r');
  expect(zoneDemoCue('k')).toBe('tongue-back');
  expect(zoneDemoCue('a')).toBe('open-jaw');
  expect(zoneDemoCue('ee')).toBe('spread-lips');
  expect(zoneDemoCue('sh')).toBe('tongue-sh');
  expect(zoneDemoCue('p')).toBe('lips-close');
  expect(zoneDemoCue('b')).toBe('lips-close-voiced');
  expect(zoneDemoCue('e')).toBe('mid-jaw');
  expect(zoneDemoCue('ai')).toBe('glide-ey');
  expect(zoneDemoCue('f')).toBe(null);
  expect(zoneDemoCue(null)).toBe(null);
});
