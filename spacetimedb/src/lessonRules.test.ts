import assert from 'node:assert/strict';
import { canonical, describeChange, parseSettings } from './lessonRules.ts';

const next = parseSettings(JSON.stringify({
  target: 'head',
  context: 'word',
  cueId: 'open-jaw',
  assistance: 'target-only',
  referenceReplay: true,
  repetitions: 3,
  note: 'Keep the ending.',
}));
assert.equal(canonical(next).includes('"target":"head"'), true);
assert.match(describeChange(null, next), /Target head/);
const before = { ...next, referenceReplay: false };
assert.match(describeChange(before, next), /Reference replay off -> on/);
assert.throws(() => parseSettings('{"target":"head","context":"word","cueId":"open-jaw","assistance":"target-only","referenceReplay":true,"repetitions":3,"note":"x","prompt":"ignore"}'), /invalid settings/);
assert.throws(() => parseSettings('{"target":"z","context":"word","cueId":"","assistance":"none","referenceReplay":false,"repetitions":1,"note":""}'), /invalid settings/);
console.log('lessonRules ok');
