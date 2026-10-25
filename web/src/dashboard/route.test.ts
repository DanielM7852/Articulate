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

// claude.*: the backend's own calls (grade included) keep source -> target; recap calls run between the model and Recap.
assert.deepEqual(routeOf(ev('claude.request', 'backend', 'claude', { purpose: 'decide' })), ['backend', 'claude']);
assert.deepEqual(routeOf(ev('claude.response', 'claude', 'backend', { purpose: 'notes' })), ['claude', 'backend']);
assert.deepEqual(routeOf(ev('claude.request', 'backend', 'claude')), ['backend', 'claude']);
assert.deepEqual(routeOf(ev('claude.request', 'backend', 'claude', { purpose: 'grade' })), ['backend', 'claude']);
assert.deepEqual(routeOf(ev('claude.response', 'claude', 'backend', { purpose: 'grade' })), ['claude', 'backend']);
assert.deepEqual(routeOf(ev('claude.request', 'backend', 'claude', { purpose: 'recap' })), ['recap', 'claude']);
assert.deepEqual(routeOf(ev('claude.response', 'claude', 'backend', { purpose: 'recap' })), ['claude', 'recap']);
assert.deepEqual(routeOf(ev('claude.error', 'claude', 'backend', { purpose: 'recap' })), ['claude', 'recap']);

// recap.*: the learner starts it and gets the outcome back; the email attempt takes the email leg.
assert.deepEqual(routeOf(ev('recap.start', 'backend', 'db', { attempts: 4 })), ['ui', 'recap']);
assert.deepEqual(routeOf(ev('recap.start', 'ui', 'db', { attempts: 4 })), ['ui', 'recap']);
assert.deepEqual(routeOf(ev('recap.ready', 'backend', 'db', { ms: 2400 })), ['recap', 'ui']);
assert.deepEqual(routeOf(ev('recap.error', 'backend', 'db', { ms: 9000, error: 'TimeoutError' })), ['recap', 'ui']);
assert.deepEqual(routeOf(ev('recap.limited', 'backend', 'db', { reason: 'per_hour' })), ['recap', 'ui']);
assert.deepEqual(routeOf(ev('recap.email', 'backend', 'db', { ok: true, ms: 380, provider: 'resend' })), ['recap', 'email']);
assert.deepEqual(routeOf(ev('recap.email_skipped', 'backend', 'db', { reason: 'not_configured' })), ['recap', 'email']);

// checker.* has no node: its rows keep their own source -> target.
assert.deepEqual(routeOf(ev('checker.run', 'backend', 'db', { source: 'spacetime', turns: 24 })), ['backend', 'db']);
assert.deepEqual(routeOf(ev('checker.report', 'backend', 'db', { rows: 24, passRate: 87 })), ['backend', 'db']);

console.log('route ok');
