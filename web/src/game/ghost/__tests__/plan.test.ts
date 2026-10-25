import { expect, test } from '../../__tests__/harness';
import { GHOST_WORDS } from '../words';
import { MAX_TRIES, NAIL_STREAK, lessonPlan, nextStep, skipStep, startProgress, stepLabel } from '../plan';

const summary = (word: string) =>
  lessonPlan(GHOST_WORDS[word])
    .map((s) => `${s.unit.label}${s.kind === 'word' ? `@${s.speedWatch}` : s.kind === 'part' ? '(part)' : ''}${s.practisable ? '' : '!'}`)
    .join(' ');

test('plan: track is tr, a, ck, ack, rack, track@0.6, track@1', () => {
  expect(summary('track')).toBe('tr(part) a(part) ck(part) ack rack track@0.6 track@1');
});

test('plan: sheep skips the repeated p; sh is watch-only', () => {
  expect(summary('sheep')).toBe('sh(part)! ee(part) p(part) eep sheep@0.6 sheep@1');
});

test('plan: rent skips the lone t chain (already inside the nt part)', () => {
  expect(summary('rent')).toBe('r(part) e(part) nt(part) ent rent@0.6 rent@1');
});

test('plan: brain skips the repeated n; n is watch-only', () => {
  expect(summary('brain')).toBe('br(part) ai(part) n(part)! ain rain brain@0.6 brain@1');
});

test('plan: parts are in word order, the two word steps share a unit and end the plan', () => {
  for (const word of Object.keys(GHOST_WORDS)) {
    const spec = GHOST_WORDS[word];
    const plan = lessonPlan(spec);
    const parts = plan.filter((s) => s.kind === 'part');
    expect(parts.map((s) => s.unit.id).join()).toBe(spec.parts.map((p) => p.id).join());
    const words = plan.filter((s) => s.kind === 'word');
    expect(words.length).toBe(2);
    expect(words[0].unit.id).toBe(words[1].unit.id);
    expect(words[0].speedWatch).toBe(0.6);
    expect(words[1].speedWatch).toBe(1);
    expect(plan[plan.length - 1].kind).toBe('word');
  }
});

test('progress: two close attempts in a row advance', () => {
  let r = nextStep(startProgress(), true);
  expect(r.advance).toBe(false);
  r = nextStep(r.state, true);
  expect(NAIL_STREAK).toBe(2);
  expect(r.advance).toBe(true);
  expect(r.gentle).toBe(false);
  expect(r.state.step).toBe(1);
  expect(r.state.tries).toBe(0);
});

test('progress: a miss resets the streak', () => {
  let r = nextStep(startProgress(), true);
  r = nextStep(r.state, false);
  r = nextStep(r.state, true);
  expect(r.advance).toBe(false);
  expect(r.state.streak).toBe(1);
});

test('progress: MAX_TRIES advances gently', () => {
  let last = nextStep(startProgress(), false);
  for (let i = 1; i < MAX_TRIES; i++) {
    expect(last.advance).toBe(false);
    last = nextStep(last.state, false);
  }
  expect(MAX_TRIES).toBe(4);
  expect(last.advance).toBe(true);
  expect(last.gentle).toBe(true);
  expect(last.state.step).toBe(1);
});

test('progress: skipStep moves on and clears the counters', () => {
  const s = skipStep({ step: 2, tries: 3, streak: 1 });
  expect(s.step).toBe(3);
  expect(s.tries).toBe(0);
  expect(s.streak).toBe(0);
});

test('stepLabel: parts, chain, whole word', () => {
  const plan = lessonPlan(GHOST_WORDS.track);
  expect(stepLabel(plan, 1)).toBe('Part 2 of 3 · a');
  expect(stepLabel(plan, 4)).toBe('Putting it together · rack');
  expect(stepLabel(plan, 5)).toBe('Whole word');
});
