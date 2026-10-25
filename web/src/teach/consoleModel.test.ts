import assert from 'node:assert/strict';
import { classReach, commandOf, observedStages, presenceWord, publicPayload } from './consoleModel.ts';

assert.deepEqual(classReach([{ lessonSource: 'learner' }, { lessonSource: 'classroom' }, { lessonSource: 'default' }]), {
  affected: 2,
  own: 1,
});
assert.equal(presenceWord('disconnected'), 'Disconnected');
assert.equal(presenceWord('analyzing'), 'Analyzing');
assert.equal(commandOf({ commandId: 'abc' }), 'abc');
assert.equal('token' in publicPayload({ token: 'secret', revision: 2 }), false);
assert.deepEqual(observedStages([{ kind: 'lesson.saved', commandId: 'c1' }, { kind: 'lesson.saved', commandId: 'other' }], 'c1'), {
  saved: true,
  received: false,
  applied: false,
});
console.log('consoleModel ok');
