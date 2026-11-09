import { expect, test } from './game/__tests__/harness';
import { DEMO_MVP, lessonWordKeys } from './demoMvp';

const all = ['track', 'sheep', 'rent', 'brain'];

test('lessonWordKeys: demo mode is track, sheep, rent in order', () => {
  expect(lessonWordKeys(all, true).join()).toBe('track,sheep,rent');
  expect(lessonWordKeys(['brain', 'rent', 'sheep', 'track'], true).join()).toBe('track,sheep,rent');
});
test('lessonWordKeys: skips demo words that do not exist', () => {
  expect(lessonWordKeys(['track', 'rent', 'brain'], true).join()).toBe('track,rent');
});
test('lessonWordKeys: off leaves the full list unchanged', () => {
  expect(lessonWordKeys(all, false)).toBe(all);
});
test('DEMO_MVP is off unless VITE_DEMO_MVP is exactly "true"', () => {
  expect(DEMO_MVP).toBe(false);
});
