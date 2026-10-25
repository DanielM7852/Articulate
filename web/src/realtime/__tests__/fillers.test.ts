import { expect, test } from '../../game/__tests__/harness';
import { THINKING_FILLERS, pickFiller } from '../fillers';
import { ASK_UNAVAILABLE, ATTEMPT_FINISHED_INSTRUCTIONS, LEARNER_ATTEMPT_UNMEASURED, RESULT_INSTRUCTIONS } from '../useAvaRealtime';

test('pickFiller never repeats the last pick', () => {
  let last: string | null = null;
  for (let i = 0; i < 200; i++) {
    const f = pickFiller(last);
    expect(THINKING_FILLERS.includes(f)).toBe(true);
    if (last !== null) expect(f === last).toBe(false);
    last = f;
  }
});

test('pickFiller survives extreme random values', () => {
  for (const v of [0, 0.999999, 1]) {
    for (const last of [null, THINKING_FILLERS[0], THINKING_FILLERS[THINKING_FILLERS.length - 1]]) {
      expect(pickFiller(last, () => v) === last).toBe(false);
    }
  }
});

test('fillers are neutral: no digits, no verdict words', () => {
  expect(THINKING_FILLERS.length >= 6).toBe(true);
  for (const f of THINKING_FILLERS) {
    expect(/\d/.test(f), f).toBe(false);
    expect(/right|wrong|good|great|nice|correct|missed|close/i.test(f), f).toBe(false);
  }
});

test('Ava-facing strings never mention a coach, model, tool owner or relay', () => {
  const leak = /\b(coach\w*|claude|gpt|relay\w*|supervisor)\b/i;
  const strings = [
    ASK_UNAVAILABLE.say,
    LEARNER_ATTEMPT_UNMEASURED.caption,
    LEARNER_ATTEMPT_UNMEASURED.instructions,
    RESULT_INSTRUCTIONS,
    ATTEMPT_FINISHED_INSTRUCTIONS,
    ...THINKING_FILLERS,
  ];
  for (const s of strings) expect(leak.test(s), s).toBe(false);
});
