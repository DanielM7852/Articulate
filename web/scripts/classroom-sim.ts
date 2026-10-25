/**
 * Synthetic classroom transport timings. No microphone audio and no model calls.
 * All clocks are performance.now() in this one process.
 */
import { DbConnection } from '../src/module_bindings/index.ts';
import { readFileSync, writeFileSync } from 'node:fs';

type Owner = { uri: string; database: string; token: string };

const owner = JSON.parse(readFileSync(new URL('../../backend/.local_store/classroom_owner.json', import.meta.url), 'utf8')) as Owner;
const settings = JSON.stringify({
  target: 'head',
  context: 'word',
  cueId: 'open-jaw',
  assistance: 'cue-target',
  referenceReplay: true,
  repetitions: 3,
  note: 'synthetic transport',
});

function ws(uri: string): string {
  return uri.startsWith('http://') ? `ws://${uri.slice('http://'.length)}` : uri;
}

async function call(token: string, reducer: string, args: unknown[]): Promise<void> {
  const response = await fetch(`${owner.uri}/v1/database/${owner.database}/call/${reducer}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${reducer} ${response.status}`);
}

async function identity(): Promise<string> {
  const response = await fetch(`${owner.uri}/v1/identity`, { method: 'POST' });
  if (!response.ok) throw new Error('identity');
  const body = (await response.json()) as { token: string };
  return body.token;
}

function connect(token: string): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(ws(owner.uri))
      .withDatabaseName(owner.database)
      .withToken(token)
      .onConnect((conn) => resolve(conn))
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

function subscribe(conn: DbConnection, queries: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.subscriptionBuilder().onApplied(() => resolve()).onError((_ctx, err) => reject(err)).subscribe(queries);
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function classroom(count: number) {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const room = `s${suffix}`;
  const teacherToken = await identity();
  const teacherCode = crypto.randomUUID().replace(/-/g, '');
  await call(owner.token, 'mint_invite', [teacherCode, 'teacher', `${room}-t`, room, 'Teacher']);
  await call(teacherToken, 'accept_invite', [teacherCode]);
  const learners: { token: string; profile: string; conn?: DbConnection }[] = [];
  for (let i = 0; i < count; i += 1) {
    const token = await identity();
    const code = crypto.randomUUID().replace(/-/g, '');
    const profile = `${room}-${i}`;
    await call(owner.token, 'mint_invite', [code, 'learner', profile, room, `L${i}`]);
    await call(token, 'accept_invite', [code]);
    learners.push({ token, profile });
  }
  const otherToken = await identity();
  const otherCode = crypto.randomUUID().replace(/-/g, '');
  const otherRoom = `o${suffix}`;
  await call(owner.token, 'mint_invite', [otherCode, 'teacher', `${otherRoom}-t`, otherRoom, 'Other']);
  await call(otherToken, 'accept_invite', [otherCode]);

  const teacher = await connect(teacherToken);
  await subscribe(teacher, ['SELECT * FROM classroom_board']);
  for (const learner of learners) {
    learner.conn = await connect(learner.token);
    await subscribe(learner.conn, ['SELECT * FROM my_classroom_lesson']);
  }
  const other = await connect(otherToken);
  await subscribe(other, ['SELECT * FROM classroom_board']);

  const receipt: number[] = [];
  const applied: number[] = [];
  const summary: number[] = [];
  let reducerErrors = 0;
  const samples = count >= 30 ? 4 : 6;
  for (let sample = 0; sample < samples; sample += 1) {
    const target = learners[0]!;
    const before = performance.now();
    const command = crypto.randomUUID();
    const expected = sample;
    try {
      await teacher.reducers.saveLesson({
        commandId: command,
        scope: 'learner',
        targetProfile: target.profile,
        classroomId: room,
        expectedRevision: expected,
        settingsJson: settings,
        expiresInMinutes: 0,
      });
    } catch {
      reducerErrors += 1;
      continue;
    }
    const payload = JSON.stringify([command, 'learner', target.profile, room, expected, settings, 0]).length;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('receipt timeout')), 8000);
      let settled = false;
      const done = (revision: number) => {
        if (settled || revision !== expected + 1) return;
        settled = true;
        clearTimeout(timer);
        target.conn!.db.myClassroomLesson.removeOnUpdate(onUpdate);
        receipt.push(performance.now() - before);
        resolve();
      };
      const onUpdate = (_ctx: unknown, _old: { revision: number }, row: { revision: number }) => done(row.revision);
      target.conn!.db.myClassroomLesson.onUpdate(onUpdate);
      for (const row of target.conn!.db.myClassroomLesson.iter()) done(row.revision);
    });
    const applyStart = performance.now();
    await target.conn!.reducers.ackLesson({ revision: expected + 1, phase: 'applied', commandId: command });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ack timeout')), 8000);
      let settled = false;
      const seen = () => {
        if (settled) return false;
        for (const row of teacher.db.classroomBoard.iter()) {
          if (row.profileId === target.profile && row.ackPhase === 'applied' && row.lessonRevision === expected + 1) {
            settled = true;
            clearTimeout(timer);
            teacher.db.classroomBoard.removeOnUpdate(onUpdate);
            applied.push(performance.now() - applyStart);
            resolve();
            return true;
          }
        }
        return false;
      };
      const onUpdate = () => {
        seen();
      };
      teacher.db.classroomBoard.onUpdate(onUpdate);
      seen();
    });
    void payload;
    const summaryStart = performance.now();
    const summaryGoal = sample + 1;
    let summarySeen = false;
    const summaryUpdate = () => {
      if (summarySeen) return;
      for (const row of teacher.db.classroomBoard.iter()) {
        if (row.profileId === target.profile && row.usable >= summaryGoal) summarySeen = true;
      }
    };
    teacher.db.classroomBoard.onUpdate(summaryUpdate);
    await target.conn!.reducers.reportProvisional({
      attemptId: crypto.randomUUID(),
      exercise: 'head',
      usable: true,
      finding: 'none',
      referenceVersion: 'sim',
      measurementsJson: '{}',
    });
    const summaryDeadline = performance.now() + 8000;
    while (!summarySeen && performance.now() < summaryDeadline) {
      summaryUpdate();
      if (!summarySeen) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    teacher.db.classroomBoard.removeOnUpdate(summaryUpdate);
    if (!summarySeen) {
      const row = [...teacher.db.classroomBoard.iter()].find((item) => item.profileId === target.profile);
      throw new Error(`summary timeout usable=${row?.usable ?? 'missing'} goal=${summaryGoal}`);
    }
    summary.push(performance.now() - summaryStart);
  }

  const classCommand = crypto.randomUUID();
  await teacher.reducers.saveLesson({
    commandId: classCommand,
    scope: 'classroom',
    targetProfile: '',
    classroomId: room,
    expectedRevision: 0,
    settingsJson: settings,
    expiresInMinutes: 0,
  });
  const until = async (pred: () => boolean) => {
    const start = performance.now();
    while (performance.now() - start < 8000) {
      if (pred()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return pred();
  };
  const memberHit = await until(() => learners.slice(1).every((learner) => [...learner.conn!.db.myClassroomLesson.iter()].some((row) => row.source === 'classroom')));
  const isolated = [...other.db.classroomBoard.iter()].every((row) => row.classroomId !== room);

  let noisyErrors = 0;
  const noisy = learners[Math.min(1, learners.length - 1)]!;
  const quiet = learners[0]!;
  const noise = Promise.all(Array.from({ length: 40 }, () => noisy.conn!.reducers.setPresence({ presence: 'idle', exercise: 'head' }).catch(() => {
    noisyErrors += 1;
  })));
  const quietStart = performance.now();
  const quietCommand = crypto.randomUUID();
  await teacher.reducers.saveLesson({
    commandId: quietCommand,
    scope: 'learner',
    targetProfile: quiet.profile,
    classroomId: room,
    expectedRevision: samples,
    settingsJson: settings,
    expiresInMinutes: 0,
  });
  await noise;
  const quietMs = performance.now() - quietStart;

  for (const learner of learners) learner.conn?.disconnect();
  teacher.disconnect();
  other.disconnect();

  return {
    learners: count,
    samples: receipt.length,
    reducerErrors,
    noisyErrors,
    quietSaveMs: Math.round(quietMs),
    classroomReachedOthers: memberHit,
    otherClassroomIsolated: isolated,
    saveToReceiptMs: { p50: Math.round(percentile(receipt, 50)), p95: Math.round(percentile(receipt, 95)) },
    saveToAppliedAckMs: { p50: Math.round(percentile(applied, 50)), p95: Math.round(percentile(applied, 95)) },
    summaryToTeacherMs: { p50: Math.round(percentile(summary, 50)), p95: Math.round(percentile(summary, 95)) },
    lessonPayloadBytes: JSON.stringify([crypto.randomUUID(), 'learner', `${room}-0`, room, 0, settings, 0]).length,
  };
}

export async function main(): Promise<void> {
  const results = [];
  for (const count of [2, 10, 30]) results.push(await classroom(count));
  const output = {
    label: 'synthetic transport, not audio or model latency',
    clock: 'performance.now in one Node process',
    results,
  };
  writeFileSync(new URL('../../backend/.local_store/classroom-measurements.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}
