import assert from 'node:assert/strict';
import { decideLesson, type LessonSnap } from './applyLesson.ts';

const lesson = (revision: number): LessonSnap => ({
  revision,
  commandId: `cmd-${revision}`,
  source: 'learner',
  visible: `Target i -> u.`,
  settingsJson: '{}',
  ackPhase: 'pending',
});

const queued = decideLesson({ appliedRevision: 0, incoming: lesson(1), recording: true });
assert.equal(queued.kind, 'pending');

const applied = decideLesson({ appliedRevision: 0, incoming: lesson(1), recording: false });
assert.equal(applied.kind, 'apply');
if (applied.kind === 'apply') assert.equal(applied.speak, false);

const again = decideLesson({ appliedRevision: 1, incoming: lesson(1), recording: false });
assert.equal(again.kind, 'same');

const stale = decideLesson({ appliedRevision: 2, incoming: lesson(1), recording: false });
assert.equal(stale.kind, 'obsolete');

const fresh = decideLesson({ appliedRevision: 0, incoming: { ...lesson(0), source: 'default' }, recording: false });
assert.equal(fresh.kind, 'same');

console.log('applyLesson ok');
