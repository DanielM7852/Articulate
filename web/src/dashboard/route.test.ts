import assert from 'node:assert/strict';
import { routeOf, sttNodeOf } from './route.ts';

const ev = (kind: string, source: string, target: string, payload: Record<string, unknown> = {}) => ({ kind, source, target, payload });

// Default: the event's own source -> target.
assert.deepEqual(routeOf(ev('coach.request', 'ui', 'backend')), ['ui', 'backend']);
assert.deepEqual(routeOf(ev('lip.frame', 'mediapipe', 'db')), ['mediapipe', 'db']);

// stt.*: Realtime by provider; Ink for cartesia, unknown and missing provider (backfill keeps the old route).
assert.deepEqual(routeOf(ev('stt.open', 'mic', 'stt', { provider: 'openai' })), ['mic', 'realtime']);
assert.deepEqual(routeOf(ev('stt.transcript', 'stt', 'ui', { provider: 'openai' })), ['realtime', 'ui']);
assert.deepEqual(routeOf(ev('stt.transcript', 'stt', 'ui', { provider: 'cartesia' })), ['stt', 'ui']);
assert.deepEqual(routeOf(ev('stt.open', 'mic', 'stt')), ['mic', 'stt']);
assert.deepEqual(routeOf(ev('stt.close', 'mic', 'stt', { provider: 'someone-else' })), ['mic', 'stt']);
assert.equal(sttNodeOf(undefined), 'stt');
assert.equal(sttNodeOf({ provider: 'OpenAI' }), 'realtime');

// phones.*: frames come back to the tab, the rest goes out to the GPU service.
assert.deepEqual(routeOf(ev('phones.open', 'ui', 'db', { provider: 'koellabs' })), ['ui', 'phones']);
assert.deepEqual(routeOf(ev('phones.frame', 'ui', 'db', { n: 25 })), ['phones', 'ui']);
assert.deepEqual(routeOf(ev('phones.score', 'ui', 'db')), ['ui', 'phones']);
assert.deepEqual(routeOf(ev('phones.close', 'ui', 'db')), ['ui', 'phones']);

// azure.*: request and skipped go out, result and error come back.
assert.deepEqual(routeOf(ev('azure.request', 'backend', 'db')), ['backend', 'azure']);
assert.deepEqual(routeOf(ev('azure.skipped', 'backend', 'db')), ['backend', 'azure']);
assert.deepEqual(routeOf(ev('azure.result', 'backend', 'db')), ['azure', 'backend']);
assert.deepEqual(routeOf(ev('azure.error', 'backend', 'db')), ['azure', 'backend']);

// classroom.* and lesson.*: into the classroom database, from the backend or the browser.
assert.deepEqual(routeOf(ev('classroom.session', 'backend', 'db')), ['backend', 'classroom']);
assert.deepEqual(routeOf(ev('classroom.probe', 'ui', 'db')), ['ui', 'classroom']);
assert.deepEqual(routeOf(ev('lesson.saved', 'ui', 'db')), ['ui', 'classroom']);

// head.*: Sonic drives the mouth while it speaks; ready comes from the learner's screen.
assert.deepEqual(routeOf(ev('head.speak', 'ui', 'db', { ms: 4200 })), ['tts', 'head']);
assert.deepEqual(routeOf(ev('head.ready', 'ui', 'db', { driver: 'talkinghead' })), ['ui', 'head']);

console.log('route ok');
