import { expect, it } from 'vitest';
import { projectVowel } from '../src/components/plot';

it('places higher F2 to the left and lower F1 toward the top', () => {
  const ee = projectVowel({ f1: 300, f2: 2300 });
  const oo = projectVowel({ f1: 350, f2: 800 });
  const ah = projectVowel({ f1: 750, f2: 1200 });
  expect(ee.x).toBeLessThan(oo.x);
  expect(ee.y).toBeLessThan(ah.y);
  expect(oo.y).toBeLessThan(ah.y);
});
