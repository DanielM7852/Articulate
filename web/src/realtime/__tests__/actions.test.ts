import { expect, test } from '../../game/__tests__/harness';
import { parseActionArgs } from '../useAvaRealtime';
import { SCREEN_STATE_MAX, screenStateMessage, type ScreenState } from '../screenState';

const BANNED = /\b(coach\w*|claude|gpt|relay\w*|supervisor)\b/i;

const base: ScreenState = {
  word: 'track',
  step: 'Part 1 of 3 · a',
  view: 'front',
  cue: null,
  feedback: null,
  canMouthCue: true,
  canSideView: false,
  canGhostPath: true,
  canNextPart: true,
  canRepeatPart: true,
  canTryNow: true,
  canNextWord: false,
  canFinish: true,
};

test('screenStateMessage lists the screen and the options', () => {
  const m = screenStateMessage(base);
  expect(m.startsWith('On screen:'), m).toBe(true);
  expect(m.includes('"track"'), m).toBe(true);
  expect(m.includes('front view'), m).toBe(true);
  expect(m.includes('no mouth cue'), m).toBe(true);
  expect(m.includes('no feedback yet'), m).toBe(true);
  expect(m.includes('You can show: mouth cue, ghost path.'), m).toBe(true);
  expect(m.includes('You can do: next part, repeat part, try now, finish.'), m).toBe(true);
  expect(m.includes('side view.') || m.includes('next word'), m).toBe(false);
});

test('screenStateMessage names the cue and quotes short feedback', () => {
  const m = screenStateMessage({ ...base, view: 'side', cue: 'open-jaw', feedback: 'Open a little wider on the 2nd try.', canSideView: true });
  expect(m.includes('side view'), m).toBe(true);
  expect(m.includes('open-jaw mouth shape'), m).toBe(true);
  expect(m.includes('last feedback "Open a little wider on the second try."'), m).toBe(true);
});

test('screenStateMessage drops long feedback, has no digits, stays short', () => {
  const long = screenStateMessage({ ...base, feedback: 'x '.repeat(80) });
  expect(long.includes('no feedback yet'), long).toBe(true);
  const worst = screenStateMessage({
    ...base,
    word: 'sheep',
    step: 'Putting it together · 12 parts',
    view: 'side',
    cue: 'spread-lips',
    feedback: 'Spread 55 percent more.',
    canSideView: true,
    canNextWord: true,
  });
  for (const m of [screenStateMessage(base), long, worst]) {
    expect(/\d/.test(m), m).toBe(false);
    expect(BANNED.test(m), m).toBe(false);
    expect(m.length <= SCREEN_STATE_MAX, `${m.length}`).toBe(true);
  }
});

test('screenStateMessage with nothing available', () => {
  const m = screenStateMessage({ ...base, canMouthCue: false, canGhostPath: false, canNextPart: false, canRepeatPart: false, canTryNow: false, canFinish: false });
  expect(m.includes('You can show: nothing right now.'), m).toBe(true);
  expect(m.includes('You can do: nothing right now.'), m).toBe(true);
});

test('parseActionArgs validates show_demo', () => {
  const ok = parseActionArgs('show_demo', { what: 'mouth_cue', speed: 'slow' });
  expect(ok?.tool === 'show_demo' && ok.what === 'mouth_cue' && ok.speed === 'slow', 'valid').toBe(true);
  const dflt = parseActionArgs('show_demo', { what: 'ghost_path' });
  expect(dflt?.tool === 'show_demo' && dflt.speed === 'normal', 'speed defaults to normal').toBe(true);
  expect(parseActionArgs('show_demo', { what: 'tongue', speed: 'slow' }), 'bad what').toBe(null);
  expect(parseActionArgs('show_demo', { what: 'side_view', speed: 'fast' }), 'bad speed').toBe(null);
  expect(parseActionArgs('show_demo', {}), 'empty').toBe(null);
  expect(parseActionArgs('show_demo', { what: 3 }), 'wrong type').toBe(null);
});

test('parseActionArgs validates lesson_control', () => {
  for (const action of ['next_part', 'repeat_part', 'try_now', 'next_word', 'finish']) {
    const p = parseActionArgs('lesson_control', { action });
    expect(p?.tool === 'lesson_control' && p.action === action, action).toBe(true);
  }
  expect(parseActionArgs('lesson_control', { action: 'skip' }), 'bad action').toBe(null);
  expect(parseActionArgs('lesson_control', null), 'null args').toBe(null);
  expect(parseActionArgs('stay_quiet', {}), 'other tool').toBe(null);
});
