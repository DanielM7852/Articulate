import { DbConnection } from '../module_bindings';
import { wsUri } from '../classroom/session';
import { emit as telemetryEmit } from '../telemetry/client';

/** Seats from the latest openSeats, so a finished probe write can report the whole school's update count. */
let openedSeats: Seat[] = [];

const SETTINGS = JSON.stringify({
  target: 'i',
  context: 'sound',
  cueId: 'spread-lips',
  assistance: 'cue-target',
  referenceReplay: false,
  repetitions: 1,
  note: 'scale probe',
});

export type ScaleIdentity = {
  token: string;
  profileId: string;
  classroomId: string;
  uri: string;
  database: string;
};

export type ScaleRoom = {
  classroomId: string;
  teacher: ScaleIdentity;
  learner: ScaleIdentity;
};

export type Seat = {
  id: number;
  classroomId: string;
  updates: number;
  teacher: DbConnection;
  learner: DbConnection;
  learnerProfile: string;
};

export type Gate = { armed: boolean };

type ScaleResponse = {
  database: string;
  uri: string;
  rooms: ScaleRoom[];
};

function connect(identity: ScaleIdentity): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(wsUri(identity.uri))
      .withDatabaseName(identity.database)
      .withToken(identity.token)
      .onConnect((conn) => resolve(conn))
      .onConnectError(() => reject(new Error('A subscription could not connect.')))
      .build();
  });
}

function subscribed(conn: DbConnection, query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(() => reject(new Error('A subscription was rejected.')))
      .subscribe([query]);
  });
}

export async function loadScale(): Promise<ScaleResponse> {
  const response = await fetch('/v1/dev/classroom/scale', { method: 'POST' });
  if (!response.ok) throw new Error('The scale rooms could not be opened on the classroom database.');
  return response.json() as Promise<ScaleResponse>;
}

export async function openSeats(rooms: ScaleRoom[], gate: Gate, onReady: (ready: number) => void, onUpdate: () => void): Promise<Seat[]> {
  const seats: Seat[] = [];
  for (const room of rooms) {
    const teacher = await connect(room.teacher);
    await subscribed(teacher, 'SELECT * FROM classroom_board');
    const learner = await connect(room.learner);
    await subscribed(learner, 'SELECT * FROM my_classroom_lesson');
    const seat: Seat = {
      id: seats.length + 1,
      classroomId: room.classroomId,
      updates: 0,
      teacher,
      learner,
      learnerProfile: room.learner.profileId,
    };
    const bump = () => {
      if (!gate.armed) return;
      seat.updates += 1;
      onUpdate();
    };
    teacher.db.classroomBoard.onInsert(bump);
    teacher.db.classroomBoard.onUpdate(bump);
    learner.db.myClassroomLesson.onInsert(bump);
    learner.db.myClassroomLesson.onUpdate(bump);
    seats.push(seat);
    onReady(seats.length * 2);
  }
  openedSeats = seats;
  return seats;
}

function waitFor(check: () => boolean): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.clearInterval(poll);
      reject(new Error('The acknowledgment did not return from the database.'));
    }, 8000);
    const poll = window.setInterval(() => {
      if (!check()) return;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      resolve();
    }, 20);
  });
}

export async function assignRoom(seat: Seat): Promise<number> {
  const started = performance.now();
  let expected = 0;
  for (const row of seat.teacher.db.classroomBoard.iter()) expected = row.classroomRevision;
  const commandId = crypto.randomUUID();
  const revision = expected + 1;
  await seat.teacher.reducers.saveLesson({
    commandId,
    scope: 'classroom',
    targetProfile: '',
    classroomId: seat.classroomId,
    expectedRevision: expected,
    settingsJson: SETTINGS,
    expiresInMinutes: 0,
  });
  await waitFor(() => {
    for (const row of seat.learner.db.myClassroomLesson.iter()) {
      if (row.revision === revision && row.commandId === commandId) return true;
    }
    return false;
  });
  await seat.learner.reducers.ackLesson({ revision, phase: 'applied', commandId });
  await waitFor(() => {
    for (const row of seat.teacher.db.classroomBoard.iter()) {
      if (row.profileId === seat.learnerProfile && row.ackPhase === 'applied' && row.lessonRevision === revision) return true;
    }
    return false;
  });
  const ms = Math.round(performance.now() - started);
  const school = openedSeats.includes(seat) ? openedSeats : [seat];
  const updates = school.reduce((sum, item) => sum + item.updates, 0);
  telemetryEmit('ui', 'db', 'classroom.probe', `probe write ${seat.classroomId} acked`, { rooms: school.length, updates, ms });
  return ms;
}

export function closeSeats(seats: Seat[]): void {
  if (seats === openedSeats) openedSeats = [];
  for (const seat of seats) {
    (seat.teacher as DbConnection & { disconnect?: () => void }).disconnect?.();
    (seat.learner as DbConnection & { disconnect?: () => void }).disconnect?.();
  }
}
