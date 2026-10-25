import { expect, test } from '../../__tests__/harness';
import { GHOST_WORDS, loneVowelExample, partPrompt } from '../words';
import { MAX_TRIES, NAIL_STREAK, lessonPlan, nextStep, skipStep, startProgress, stepLabel } from '../plan';

const summary = (word: string) =>
  lessonPlan(GHOST_WORDS[word])
    .map((s) => `${s.unit.label}${s.kind === 'word' ? `@${s.speedWatch}` : s.kind === 'part' ? '(part)' : ''}${s.practisable ? '' : '!'}`)
    .join(' ');

test('plan: track is tr, a, ck, track@0.6, track@1', () => {
  expect(summary('track')).toBe('tr(part) a(part) ck(part) track@0.6 track@1');
});

test('plan: sheep: sh is watch-only', () => {
  expect(summary('sheep')).toBe('sh(part)! ee(part) p(part) sheep@0.6 sheep@1');
});

test('plan: rent has no chain steps', () => {
  expect(summary('rent')).toBe('r(part) e(part) nt(part) rent@0.6 rent@1');
});

test('plan: brain: n is watch-only', () => {
  expect(summary('brain')).toBe('br(part) ai(part) n(part)! brain@0.6 brain@1');
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
    expect(plan.some((s) => s.kind === 'chain')).toBe(false);
    expect(plan.length).toBe(spec.parts.length + 2);
  }
});

test('progress: one close attempt advances', () => {
  const r = nextStep(startProgress(), true);
  expect(NAIL_STREAK).toBe(1);
  expect(r.advance).toBe(true);
  expect(r.gentle).toBe(false);
  expect(r.state.step).toBe(1);
  expect(r.state.tries).toBe(0);
});

test('progress: a miss stays on the step, then one close attempt passes', () => {
  let r = nextStep(startProgress(), false);
  expect(r.advance).toBe(false);
  expect(r.state.streak).toBe(0);
  r = nextStep(r.state, true);
  expect(r.advance).toBe(true);
  expect(r.gentle).toBe(false);
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

test('plan: track kinds are part, part, part, word, word', () => {
  expect(lessonPlan(GHOST_WORDS.track).map((s) => s.kind).join()).toBe('part,part,part,word,word');
});

test('stepLabel: parts and whole word', () => {
  const plan = lessonPlan(GHOST_WORDS.track);
  expect(stepLabel(plan, 1)).toBe('Part 2 of 3 · a');
  expect(stepLabel(plan, 3)).toBe('Whole word');
});

test('part prompt: the lone vowel of track asks with an example word, other parts keep the plain ask', () => {
  const spec = GHOST_WORDS.track;
  const [tr, a, ck] = lessonPlan(spec).filter((s) => s.kind === 'part');
  const pa = partPrompt(spec, a.unit);
  expect(`Say ${pa.lead}“${pa.label}”${pa.tail}`).toBe('Say the “a” in track, like in “cat”');
  expect(pa.spoken).toBe('Say the a in track, like in cat.');
  for (const s of [tr, ck]) {
    const p = partPrompt(spec, s.unit);
    expect(p.tail).toBe(null);
    expect(p.lead).toBe('');
    expect(p.spoken).toBe(`Say ${s.unit.label}.`);
  }
});

test('part prompt: a vowel zone without an example falls back to the plain ask; examples exist for every ghost vowel', () => {
  const spec = { ...GHOST_WORDS.track, zones: GHOST_WORDS.track.zones.map((z) => (z.id === 'a' ? { ...z, example: undefined } : z)) };
  const p = partPrompt(spec, { label: 'a', zoneIds: ['a'] });
  expect(p.tail).toBe(null);
  expect(p.spoken).toBe('Say a.');
  expect(loneVowelExample(GHOST_WORDS.track, ['a'])).toBe('cat');
  expect(loneVowelExample(GHOST_WORDS.track, ['t', 'r'])).toBe(undefined);
  for (const w of Object.values(GHOST_WORDS)) for (const z of w.zones) expect(z.kind === 'vowel' ? typeof z.example : 'string').toBe('string');
});
