import { expect, test } from '../../game/__tests__/harness';
import { PRAISE_LINES, pickPraise } from '../praise';

test('pickPraise never repeats back to back and stays in PRAISE_LINES', () => {
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let prev = '';
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const p = pickPraise(rand);
    expect(PRAISE_LINES.includes(p), 'member').toBe(true);
    expect(p === prev, `repeat at ${i}`).toBe(false);
    seen.add(p);
    prev = p;
  }
  expect(seen.size, 'variety').toBe(PRAISE_LINES.length);
});

test('pickPraise survives extreme rand values', () => {
  expect(PRAISE_LINES.includes(pickPraise(() => 0)), 'zero').toBe(true);
  expect(PRAISE_LINES.includes(pickPraise(() => 0.9999999)), 'high').toBe(true);
});
