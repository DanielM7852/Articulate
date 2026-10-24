import { describe, expect, it } from 'vitest';
import { LESSONS, lessonAvailability } from '../src/game/lessons';
import type { ZoneSet } from '../src/game/zones';

const base: ZoneSet = {
  ee: { vowel: 'ee', f1: 300, f2: 2300, radius: 0.2 },
  ah: { vowel: 'ah', f1: 750, f2: 1200, radius: 0.2 },
  oo: { vowel: 'oo', f1: 350, f2: 800, radius: 0.2 },
};
const lesson = (id: string) => LESSONS.find((item) => item.id === id)!;

describe('lesson availability', () => {
  it('offers calibrated routes, requires real extra targets, and keeps nasal endings locked', () => {
    expect(lessonAvailability(lesson('sweep'), base)).toEqual({ kind: 'ready' });
    expect(lessonAvailability(lesson('ladder'), base)).toEqual({ kind: 'calibrate', vowels: ['ee', 'ih', 'eh', 'ae'] });
    expect(lessonAvailability(lesson('boy'), base)).toEqual({ kind: 'calibrate', vowels: ['aw', 'ee'] });
    expect(lessonAvailability(lesson('nasals'), base)).toMatchObject({ kind: 'locked', reason: expect.stringMatching(/nasal/i) });
  });
});
