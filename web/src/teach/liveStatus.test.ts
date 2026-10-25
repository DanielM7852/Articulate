import assert from 'node:assert/strict';
import {
  PERCEPT_MS,
  PRESENCE_MS,
  emptyLiveState,
  learnerLive,
  lessonSeen,
  pruneLive,
  reduceLive,
  snapshotLive,
  type LiveEvent,
} from './liveStatusModel.ts';

let n = 0;
const ev = (kind: string, at: number, payload: Record<string, unknown>): LiveEvent => ({ id: String(++n), at, kind, payload });

const T = 1_000_000_000;

// Nothing is known about a profile until a tab announces it.
{
  const s = emptyLiveState();
  reduceLive(s, ev('camera.on', T, { sid: 'a1' }), T);
  assert.equal(learnerLive(s, 'p1', T), null);
  reduceLive(s, ev('ui.join', T, { sid: 'a1', ua: 'desktop', pid: 'p1' }), T);
  const status = learnerLive(s, 'p1', T);
  assert.ok(status);
  assert.equal(status.tabs, 1);
  // camera.on arrived before the join named the tab, so it is not attributed
  assert.equal(status.camera, null);
}

// sid -> pid mapping: ping with a pid maps, ping without one unmaps.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1' }), T);
  reduceLive(s, ev('camera.on', T + 1, { sid: 'a1' }), T + 1);
  assert.equal(learnerLive(s, 'p1', T + 1), null);
  reduceLive(s, ev('ui.ping', T + 2, { sid: 'a1', pid: 'p1' }), T + 2);
  reduceLive(s, ev('camera.on', T + 3, { sid: 'a1' }), T + 3);
  assert.equal(learnerLive(s, 'p1', T + 3)?.camera, 'on');
  reduceLive(s, ev('ui.ping', T + 4, { sid: 'a1' }), T + 4);
  const unmapped = learnerLive(s, 'p1', T + 4);
  assert.equal(unmapped?.tabs, 0);
  assert.equal(unmapped?.camera, null);
  // a pid that is too long is not a profile id
  reduceLive(s, ev('ui.ping', T + 5, { sid: 'a2', pid: 'x'.repeat(65) }), T + 5);
  assert.equal(learnerLive(s, 'x'.repeat(65), T + 5), null);
}

// Live signals: camera, face, microphone, phones, head; and their expiry.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), T);
  reduceLive(s, ev('camera.on', T, { sid: 'a1' }), T);
  reduceLive(s, ev('lip.frame', T, { sid: 'a1', ok: true, opening: 0.4 }), T);
  reduceLive(s, ev('audio.spectrum', T, { sid: 'a1', bins: [1, 2, 3], rms: 0.2 }), T);
  reduceLive(s, ev('phones.open', T, { sid: 'a1', provider: 'koellabs' }), T);
  reduceLive(s, ev('head.ready', T, { sid: 'a1', driver: 'talkinghead' }), T);
  let status = learnerLive(s, 'p1', T + 100);
  assert.equal(status?.camera, 'on');
  assert.equal(status?.face, 'tracking');
  assert.equal(status?.mic, 'listening');
  assert.equal(status?.phones, 'connected');
  assert.equal(status?.head, 'talkinghead');
  // perception payloads are not kept
  assert.equal(JSON.stringify([...s.tabs.values()]).includes('0.4'), false);
  // frames that say no face read lost
  reduceLive(s, ev('lip.frame', T + 2000, { sid: 'a1', ok: false }), T + 2000);
  status = learnerLive(s, 'p1', T + 2100);
  assert.equal(status?.face, 'lost');
  // no spectrum for longer than PERCEPT_MS and no open socket: the microphone reads closed
  assert.equal(status?.mic, 'closed');
  reduceLive(s, ev('stt.open', T + 2200, { sid: 'a1', provider: 'cartesia' }), T + 2200);
  assert.equal(learnerLive(s, 'p1', T + 2300)?.mic, 'listening');
  reduceLive(s, ev('stt.close', T + 2400, { sid: 'a1', provider: 'cartesia' }), T + 2400);
  assert.equal(learnerLive(s, 'p1', T + 2400 + PERCEPT_MS + 1)?.mic, 'closed');
  // camera off clears the face
  reduceLive(s, ev('camera.off', T + 3000, { sid: 'a1' }), T + 3000);
  status = learnerLive(s, 'p1', T + 3000);
  assert.equal(status?.camera, 'off');
  assert.equal(status?.face, null);
  // phones close
  reduceLive(s, ev('phones.close', T + 3100, { sid: 'a1', reason: 'client' }), T + 3100);
  assert.equal(learnerLive(s, 'p1', T + 3100)?.phones, null);
}

// Expiry: a tab with no event for PRESENCE_MS is forgotten; lastSeen stays.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), T);
  reduceLive(s, ev('camera.on', T + 10, { sid: 'a1' }), T + 10);
  assert.equal(learnerLive(s, 'p1', T + PRESENCE_MS)?.tabs, 1);
  const later = T + 10 + PRESENCE_MS + 1;
  const faded = learnerLive(s, 'p1', later);
  assert.equal(faded?.tabs, 0);
  assert.equal(faded?.camera, null);
  assert.equal(faded?.lastSeen, T + 10);
  assert.equal(pruneLive(s, later), true);
  assert.equal(s.tabs.size, 0);
  // the same sid later, without a fresh announcement, is not mapped
  reduceLive(s, ev('camera.on', later + 5, { sid: 'a1' }), later + 5);
  assert.equal(learnerLive(s, 'p1', later + 5)?.camera, null);
}

// Expiry in event time: a sid that went quiet for PRESENCE_MS starts over unmapped.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), T);
  const back = T + PRESENCE_MS + 5;
  reduceLive(s, ev('lesson.received', back, { sid: 'a1', commandId: 'c9', revision: 9 }), back);
  assert.equal(learnerLive(s, 'p1', back)?.lessons.has('c9'), false);
}

// ui.leave ends the tab at once.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), T);
  reduceLive(s, ev('camera.on', T, { sid: 'a1' }), T);
  reduceLive(s, ev('ui.leave', T + 5, { sid: 'a1' }), T + 5);
  const status = learnerLive(s, 'p1', T + 6);
  assert.equal(status?.tabs, 0);
  assert.equal(status?.camera, null);
}

// Two tabs for one learner: any live tab counts.
{
  const s = emptyLiveState();
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), T);
  reduceLive(s, ev('ui.join', T, { sid: 'b2', pid: 'p1' }), T);
  reduceLive(s, ev('camera.off', T + 1, { sid: 'a1' }), T + 1);
  reduceLive(s, ev('camera.on', T + 1, { sid: 'b2' }), T + 1);
  assert.equal(learnerLive(s, 'p1', T + 2)?.tabs, 2);
  assert.equal(learnerLive(s, 'p1', T + 2)?.camera, 'on');
}

// Backfill older than 30 s fills lessons and lastSeen, never camera or microphone.
{
  const s = emptyLiveState();
  const now = T + 45_000;
  reduceLive(s, ev('ui.join', T, { sid: 'a1', pid: 'p1' }), now);
  reduceLive(s, ev('camera.on', T + 1, { sid: 'a1' }), now);
  reduceLive(s, ev('audio.spectrum', T + 2, { sid: 'a1', bins: [1] }), now);
  reduceLive(s, ev('lip.frame', T + 2, { sid: 'a1', ok: true }), now);
  reduceLive(s, ev('lesson.received', T + 3, { sid: 'a1', commandId: 'c1', revision: 2 }), now);
  const status = learnerLive(s, 'p1', now);
  assert.equal(status?.camera, null);
  assert.equal(status?.mic, null);
  assert.equal(status?.face, null);
  assert.equal(status?.lastSeen, T + 3);
  assert.equal(status?.lessons.get('c1')?.received, T + 3);
}

// Lesson stages: received, applied, failed per command; saved names no learner; attribution for the activity list.
{
  const s = emptyLiveState();
  reduceLive(s, ev('lesson.saved', T, { sid: 'teacher', commandId: 'c1', revision: 3, scope: 'learner' }), T);
  reduceLive(s, ev('ui.join', T + 1, { sid: 'a1', pid: 'p1' }), T + 1);
  const received = ev('lesson.received', T + 2, { sid: 'a1', commandId: 'c1', revision: 3 });
  reduceLive(s, received, T + 2);
  reduceLive(s, ev('lesson.applied', T + 3, { sid: 'a1', commandId: 'c1', revision: 3 }), T + 3);
  // a duplicate later receipt keeps the first time
  reduceLive(s, ev('lesson.received', T + 9, { sid: 'a1', commandId: 'c1', revision: 3 }), T + 9);
  reduceLive(s, ev('lesson.failed', T + 4, { sid: 'a1', commandId: 'c2', revision: 4 }), T + 4);
  // an unannounced tab's receipt is not attributed to anyone
  const stray = ev('lesson.received', T + 5, { sid: 'zz', commandId: 'c1', revision: 3 });
  reduceLive(s, stray, T + 5);

  const snap = snapshotLive(s, T + 10);
  const p1 = snap.learners.get('p1') ?? null;
  assert.deepEqual(p1?.lessons.get('c1'), { revision: 3, received: T + 2, applied: T + 3 });
  assert.deepEqual(p1?.lessons.get('c2'), { revision: 4, failed: T + 4 });
  assert.deepEqual(snap.saved.get('c1'), { revision: 3, at: T, scope: 'learner' });
  assert.equal(snap.learners.has('teacher'), false);
  assert.equal(snap.attributed.get(received.id), 'p1');
  assert.equal(snap.attributed.has(stray.id), false);

  // lookup by command id, else by revision; never a stage that was not seen
  assert.equal(lessonSeen(p1, 'c1', 3)?.seen.applied, T + 3);
  assert.equal(lessonSeen(p1, 'c1', 3)?.byRevision, false);
  assert.equal(lessonSeen(p1, '', 4)?.seen.failed, T + 4);
  assert.equal(lessonSeen(p1, '', 4)?.byRevision, true);
  assert.equal(lessonSeen(p1, 'missing', 3), null);
  assert.equal(lessonSeen(p1, '', 7), null);
  assert.equal(lessonSeen(null, 'c1', 3), null);
}

console.log('liveStatus ok');
