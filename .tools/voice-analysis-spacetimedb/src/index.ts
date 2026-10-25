import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

/**
 * Articulate application state. Tables are private.
 * Clients read only the views below, which keep each identity to its own rows.
 * The publisher identity recorded at init is the trusted analysis worker.
 */

const MAX_TEXT = 600;
const MAX_PAYLOAD = 8_000;
const MAX_CHUNKS = 400;
const LEASE_MICROS = 30_000_000n;

const serviceRole = table(
  { name: 'service_role' },
  {
    role: t.string().primaryKey(),
    identity: t.identity(),
  },
);

const learnerProfile = table(
  { name: 'learner_profile' },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    email: t.string(),
    updatedAtMicros: t.i64(),
  },
);

const learnerProgress = table(
  {
    name: 'learner_progress',
    indexes: [{ accessor: 'by_owner_exercise', algorithm: 'btree', columns: ['owner', 'exercise'] }],
  },
  {
    progressId: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    exercise: t.string(),
    usableAttempts: t.u32(),
    unusableAttempts: t.u32(),
    endingMismatchCount: t.u32(),
    guidedAttempts: t.u32(),
    independentAttempts: t.u32(),
    lastFinding: t.string(),
    lastCueId: t.string(),
    lastAttemptId: t.string(),
    lastReferenceVersion: t.string(),
    revision: t.u64(),
    updatedAtMicros: t.i64(),
  },
);

const countedAttempt = table(
  { name: 'counted_attempt' },
  {
    attemptId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

const practiceSession = table(
  { name: 'practice_session' },
  {
    sessionId: t.string().primaryKey(),
    owner: t.identity().index('btree'),
    exercise: t.string(),
    activeAttemptId: t.string(),
    deviceId: t.string(),
    revision: t.u64(),
    updatedAtMicros: t.i64(),
  },
);

const attempt = table(
  { name: 'attempt' },
  {
    attemptId: t.string().primaryKey(),
    owner: t.identity().index('btree'),
    sessionId: t.string().index('btree'),
    referenceId: t.string(),
    analysisVersion: t.string(),
    captureState: t.string(),
    analysisState: t.string(),
    resultRevision: t.u64(),
    provenance: t.string(),
    fixtureMode: t.bool(),
    findingCode: t.string(),
    spokenText: t.string(),
    cueId: t.string(),
    nextAction: t.string(),
    status: t.string(),
    deliveryId: t.string(),
    metricsJson: t.string(),
    evidenceJson: t.string(),
    createdAtMicros: t.i64(),
    updatedAtMicros: t.i64(),
  },
);

const featureChunk = table(
  {
    name: 'feature_chunk',
    indexes: [
      {
        accessor: 'by_attempt_seq',
        algorithm: 'btree',
        columns: ['attemptId', 'sequence', 'provenance'],
      },
    ],
  },
  {
    chunkId: t.u64().primaryKey().autoInc(),
    attemptId: t.string(),
    owner: t.identity(),
    sequence: t.u32(),
    producerId: t.string(),
    captureId: t.string(),
    firstSampleOffset: t.u32(),
    sampleRateHz: t.u32(),
    hopLength: t.u32(),
    frameLength: t.u32(),
    extractionVersion: t.string(),
    provenance: t.string(),
    payload: t.string(),
    createdAtMicros: t.i64(),
  },
);

const analysisJob = table(
  { name: 'analysis_job' },
  {
    attemptId: t.string().primaryKey(),
    owner: t.identity(),
    state: t.string(),
    generation: t.u32(),
    leaseExpiresMicros: t.i64(),
    retries: t.u32(),
    inputVersion: t.string(),
    referenceVersion: t.string(),
  },
);

const feedbackDelivery = table(
  { name: 'feedback_delivery' },
  {
    deliveryId: t.string().primaryKey(),
    attemptId: t.string().index('btree'),
    revision: t.u64(),
    spoken: t.bool(),
  },
);

const classroom = table(
  { name: 'classroom' },
  {
    classroomId: t.string().primaryKey(),
    teacher: t.identity().index('btree'),
    name: t.string(),
    joinCode: t.string().unique(),
  },
);

const membership = table(
  {
    name: 'membership',
    indexes: [{ accessor: 'by_class_student', algorithm: 'btree', columns: ['classroomId', 'student'] }],
  },
  {
    membershipId: t.u64().primaryKey().autoInc(),
    classroomId: t.string(),
    student: t.identity(),
  },
);

const assignment = table(
  { name: 'assignment' },
  {
    assignmentId: t.string().primaryKey(),
    classroomId: t.string().index('btree'),
    exercise: t.string(),
    referenceId: t.string(),
    referenceVersion: t.string(),
    active: t.bool(),
  },
);

const helpRequest = table(
  { name: 'help_request' },
  {
    requestId: t.u64().primaryKey().autoInc(),
    classroomId: t.string().index('btree'),
    student: t.identity(),
    attemptId: t.string(),
    note: t.string(),
    open: t.bool(),
  },
);

const devicePresence = table(
  {
    name: 'device_presence',
    indexes: [{ accessor: 'by_owner_device', algorithm: 'btree', columns: ['owner', 'deviceId'] }],
  },
  {
    presenceId: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    deviceId: t.string(),
    sessionId: t.string(),
    recording: t.bool(),
    leaseExpiresMicros: t.i64(),
  },
);

const referenceFeature = table(
  { name: 'reference_feature' },
  {
    referenceId: t.string().primaryKey(),
    analysisVersion: t.string(),
    transcript: t.string(),
    intendedPattern: t.string(),
    contourJson: t.string(),
    updatedAtMicros: t.i64(),
  },
);

const teacherSelection = table(
  { name: 'teacher_selection' },
  {
    teacher: t.identity().primaryKey(),
    attemptId: t.string(),
  },
);

const spacetimedb = schema({
  serviceRole,
  learnerProfile,
  learnerProgress,
  countedAttempt,
  practiceSession,
  attempt,
  featureChunk,
  analysisJob,
  feedbackDelivery,
  classroom,
  membership,
  assignment,
  helpRequest,
  devicePresence,
  referenceFeature,
  teacherSelection,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const classroomSummary = t.row('classroom_summary', {
  classroomId: t.string().primaryKey(),
  name: t.string(),
  studentCount: t.u32(),
  usableAttempts: t.u32(),
  unusableAttempts: t.u32(),
  endingMismatchCount: t.u32(),
  openHelpRequests: t.u32(),
});

function nowMicros(ctx: Ctx): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function bounded(value: string, limit: number, field: string): string {
  if (value.length > limit) {
    throw new SenderError(`${field} exceeds ${limit} characters`);
  }
  return value;
}

function requireOwner(ctx: Ctx): void {
  const owner = ctx.db.serviceRole.role.find('owner');
  if (!owner || !owner.identity.equals(ctx.sender)) {
    throw new SenderError('worker_only');
  }
}

function ownsAttempt(ctx: Ctx, attemptId: string) {
  const row = ctx.db.attempt.attemptId.find(attemptId);
  if (!row || !row.owner.equals(ctx.sender)) {
    throw new SenderError('not_attempt_owner');
  }
  return row;
}

function teaches(ctx: Ctx, classroomId: string) {
  const row = ctx.db.classroom.classroomId.find(classroomId);
  if (!row || !row.teacher.equals(ctx.sender)) {
    throw new SenderError('not_classroom_teacher');
  }
  return row;
}

function teacherCanSee(ctx: Ctx, student: Ctx['sender']): boolean {
  for (const room of ctx.db.classroom.teacher.filter(ctx.sender)) {
    for (const member of ctx.db.membership.by_class_student.filter(room.classroomId)) {
      if (member.student.equals(student)) return true;
    }
  }
  return false;
}

function chunksFor(ctx: Ctx, attemptId: string) {
  return [...ctx.db.featureChunk.by_attempt_seq.filter(attemptId)];
}

function trimChunks(ctx: Ctx, attemptId: string): void {
  const rows = chunksFor(ctx, attemptId);
  if (rows.length <= MAX_CHUNKS) return;
  rows.sort((a, b) => a.sequence - b.sequence);
  for (const row of rows.slice(0, rows.length - MAX_CHUNKS)) {
    if (row.provenance === 'client_provisional') ctx.db.featureChunk.chunkId.delete(row.chunkId);
  }
}

function recordProgress(ctx: Ctx, row: ReturnType<typeof ownsAttempt>, exercise: string): void {
  if (row.fixtureMode || ctx.db.countedAttempt.attemptId.find(row.attemptId)) return;
  const usable = row.status === 'complete' || row.status === 'partial';
  const unusable = row.status === 'insufficient_audio' || row.status === 'failed';
  if (!usable && !unusable) return;
  const existing = [...ctx.db.learnerProgress.by_owner_exercise.filter([row.owner, exercise])][0];
  const mismatch = row.findingCode === 'ending_direction_mismatch' ? 1 : 0;
  const guided = exercise.includes('guided') ? 1 : 0;
  const independent = exercise.includes('independent') ? 1 : 0;
  if (existing) {
    ctx.db.learnerProgress.progressId.update({
      ...existing,
      usableAttempts: existing.usableAttempts + (usable ? 1 : 0),
      unusableAttempts: existing.unusableAttempts + (unusable ? 1 : 0),
      endingMismatchCount: existing.endingMismatchCount + mismatch,
      guidedAttempts: existing.guidedAttempts + guided,
      independentAttempts: existing.independentAttempts + independent,
      lastFinding: row.findingCode,
      lastCueId: row.cueId,
      lastAttemptId: row.attemptId,
      lastReferenceVersion: row.analysisVersion,
      revision: existing.revision + 1n,
      updatedAtMicros: nowMicros(ctx),
    });
  } else {
    ctx.db.learnerProgress.insert({
      progressId: 0n,
      owner: row.owner,
      exercise,
      usableAttempts: usable ? 1 : 0,
      unusableAttempts: unusable ? 1 : 0,
      endingMismatchCount: mismatch,
      guidedAttempts: guided,
      independentAttempts: independent,
      lastFinding: row.findingCode,
      lastCueId: row.cueId,
      lastAttemptId: row.attemptId,
      lastReferenceVersion: row.analysisVersion,
      revision: 1n,
      updatedAtMicros: nowMicros(ctx),
    });
  }
  ctx.db.countedAttempt.insert({ attemptId: row.attemptId, owner: row.owner });
}

export const init = spacetimedb.init((_ctx) => {
  // The worker identity is claimed by become_worker, not by whoever publishes.
});

export const becomeWorker = spacetimedb.reducer((ctx) => {
  const existing = ctx.db.serviceRole.role.find('owner');
  if (!existing) {
    ctx.db.serviceRole.insert({ role: 'owner', identity: ctx.sender });
    return;
  }
  if (!existing.identity.equals(ctx.sender)) throw new SenderError('worker_already_claimed');
});

export const ensureProfile = spacetimedb.reducer(
  { displayName: t.string(), email: t.string() },
  (ctx, { displayName, email }) => {
    const name = bounded(displayName.trim(), 80, 'displayName');
    const address = bounded(email.trim(), 120, 'email');
    const existing = ctx.db.learnerProfile.identity.find(ctx.sender);
    if (existing) {
      ctx.db.learnerProfile.identity.update({
        ...existing,
        displayName: name,
        email: address,
        updatedAtMicros: nowMicros(ctx),
      });
      return;
    }
    ctx.db.learnerProfile.insert({
      identity: ctx.sender,
      displayName: name,
      email: address,
      updatedAtMicros: nowMicros(ctx),
    });
  },
);

export const openSession = spacetimedb.reducer(
  { sessionId: t.string(), exercise: t.string(), deviceId: t.string() },
  (ctx, { sessionId, exercise, deviceId }) => {
    const id = bounded(sessionId, 80, 'sessionId');
    const existing = ctx.db.practiceSession.sessionId.find(id);
    if (existing && !existing.owner.equals(ctx.sender)) throw new SenderError('not_session_owner');
    if (existing) {
      ctx.db.practiceSession.sessionId.update({
        ...existing,
        exercise: bounded(exercise, 80, 'exercise'),
        deviceId: bounded(deviceId, 80, 'deviceId'),
        revision: existing.revision + 1n,
        updatedAtMicros: nowMicros(ctx),
      });
      return;
    }
    ctx.db.practiceSession.insert({
      sessionId: id,
      owner: ctx.sender,
      exercise: bounded(exercise, 80, 'exercise'),
      activeAttemptId: '',
      deviceId: bounded(deviceId, 80, 'deviceId'),
      revision: 1n,
      updatedAtMicros: nowMicros(ctx),
    });
  },
);

export const beginAttempt = spacetimedb.reducer(
  { sessionId: t.string(), attemptId: t.string(), referenceId: t.string(), deviceId: t.string() },
  (ctx, { sessionId, attemptId, referenceId, deviceId }) => {
    const session = ctx.db.practiceSession.sessionId.find(bounded(sessionId, 80, 'sessionId'));
    if (!session || !session.owner.equals(ctx.sender)) throw new SenderError('not_session_owner');
    const id = bounded(attemptId, 80, 'attemptId');
    if (ctx.db.attempt.attemptId.find(id)) throw new SenderError('duplicate_attempt');
    const other = [...ctx.db.devicePresence.by_owner_device.filter(ctx.sender)].find(
      (row) => row.recording && row.deviceId !== deviceId && row.leaseExpiresMicros > nowMicros(ctx),
    );
    if (other) throw new SenderError('other_device_recording');
    if (session.activeAttemptId) {
      const previous = ctx.db.attempt.attemptId.find(session.activeAttemptId);
      if (previous && (previous.analysisState === 'pending' || previous.analysisState === 'provisional')) {
        ctx.db.attempt.attemptId.update({ ...previous, analysisState: 'superseded', updatedAtMicros: nowMicros(ctx) });
        const job = ctx.db.analysisJob.attemptId.find(previous.attemptId);
        if (job && job.state !== 'complete') {
          ctx.db.analysisJob.attemptId.update({ ...job, state: 'superseded' });
        }
      }
    }
    const stamp = nowMicros(ctx);
    ctx.db.attempt.insert({
      attemptId: id,
      owner: ctx.sender,
      sessionId: session.sessionId,
      referenceId: bounded(referenceId, 80, 'referenceId'),
      analysisVersion: '',
      captureState: 'recording',
      analysisState: 'pending',
      resultRevision: 0n,
      provenance: 'client_provisional',
      fixtureMode: false,
      findingCode: '',
      spokenText: '',
      cueId: '',
      nextAction: '',
      status: '',
      deliveryId: '',
      metricsJson: '',
      evidenceJson: '',
      createdAtMicros: stamp,
      updatedAtMicros: stamp,
    });
    ctx.db.analysisJob.insert({
      attemptId: id,
      owner: ctx.sender,
      state: 'queued',
      generation: 1,
      leaseExpiresMicros: 0n,
      retries: 0,
      inputVersion: '1',
      referenceVersion: bounded(referenceId, 80, 'referenceId'),
    });
    ctx.db.practiceSession.sessionId.update({
      ...session,
      activeAttemptId: id,
      deviceId: bounded(deviceId, 80, 'deviceId'),
      revision: session.revision + 1n,
      updatedAtMicros: stamp,
    });
  },
);

export const appendFeatureChunk = spacetimedb.reducer(
  {
    attemptId: t.string(),
    sequence: t.u32(),
    producerId: t.string(),
    captureId: t.string(),
    firstSampleOffset: t.u32(),
    sampleRateHz: t.u32(),
    hopLength: t.u32(),
    frameLength: t.u32(),
    extractionVersion: t.string(),
    provenance: t.string(),
    payload: t.string(),
  },
  (ctx, args) => {
    const row = ownsAttempt(ctx, args.attemptId);
    if (args.provenance !== 'client_provisional') throw new SenderError('clients_send_provisional_only');
    if (row.analysisState === 'superseded') throw new SenderError('attempt_superseded');
    const payload = bounded(args.payload, MAX_PAYLOAD, 'payload');
    const duplicate = chunksFor(ctx, row.attemptId).some(
      (chunk) => chunk.sequence === args.sequence && chunk.provenance === args.provenance,
    );
    if (duplicate) return;
    ctx.db.featureChunk.insert({
      chunkId: 0n,
      attemptId: row.attemptId,
      owner: ctx.sender,
      sequence: args.sequence,
      producerId: bounded(args.producerId, 80, 'producerId'),
      captureId: bounded(args.captureId, 80, 'captureId'),
      firstSampleOffset: args.firstSampleOffset,
      sampleRateHz: args.sampleRateHz,
      hopLength: args.hopLength,
      frameLength: args.frameLength,
      extractionVersion: bounded(args.extractionVersion, 40, 'extractionVersion'),
      provenance: 'client_provisional',
      payload,
      createdAtMicros: nowMicros(ctx),
    });
    trimChunks(ctx, row.attemptId);
    if (row.analysisState === 'pending') {
      ctx.db.attempt.attemptId.update({ ...row, analysisState: 'provisional', captureState: 'recording', updatedAtMicros: nowMicros(ctx) });
    }
  },
);

export const heartbeatDevice = spacetimedb.reducer(
  { deviceId: t.string(), sessionId: t.string(), recording: t.bool() },
  (ctx, { deviceId, sessionId, recording }) => {
    const id = bounded(deviceId, 80, 'deviceId');
    const existing = [...ctx.db.devicePresence.by_owner_device.filter(ctx.sender)].find((row) => row.deviceId === id);
    const lease = nowMicros(ctx) + LEASE_MICROS;
    if (existing) {
      ctx.db.devicePresence.presenceId.update({
        ...existing,
        sessionId: bounded(sessionId, 80, 'sessionId'),
        recording,
        leaseExpiresMicros: lease,
      });
      return;
    }
    ctx.db.devicePresence.insert({
      presenceId: 0n,
      owner: ctx.sender,
      deviceId: id,
      sessionId: bounded(sessionId, 80, 'sessionId'),
      recording,
      leaseExpiresMicros: lease,
    });
  },
);

export const createClassroom = spacetimedb.reducer(
  { classroomId: t.string(), name: t.string(), joinCode: t.string() },
  (ctx, { classroomId, name, joinCode }) => {
    const id = bounded(classroomId, 80, 'classroomId');
    if (ctx.db.classroom.classroomId.find(id)) throw new SenderError('duplicate_classroom');
    ctx.db.classroom.insert({
      classroomId: id,
      teacher: ctx.sender,
      name: bounded(name, 80, 'name'),
      joinCode: bounded(joinCode, 40, 'joinCode'),
    });
  },
);

export const joinClassroom = spacetimedb.reducer({ joinCode: t.string() }, (ctx, { joinCode }) => {
  const code = bounded(joinCode, 40, 'joinCode');
  const room = [...ctx.db.classroom.iter()].find((row) => row.joinCode === code);
  if (!room) throw new SenderError('unknown_join_code');
  if (room.teacher.equals(ctx.sender)) return;
  const already = [...ctx.db.membership.by_class_student.filter(room.classroomId)].some((row) =>
    row.student.equals(ctx.sender),
  );
  if (already) return;
  ctx.db.membership.insert({ membershipId: 0n, classroomId: room.classroomId, student: ctx.sender });
});

export const assignExercise = spacetimedb.reducer(
  {
    assignmentId: t.string(),
    classroomId: t.string(),
    exercise: t.string(),
    referenceId: t.string(),
    referenceVersion: t.string(),
  },
  (ctx, args) => {
    teaches(ctx, args.classroomId);
    const id = bounded(args.assignmentId, 80, 'assignmentId');
    const existing = ctx.db.assignment.assignmentId.find(id);
    const next = {
      assignmentId: id,
      classroomId: args.classroomId,
      exercise: bounded(args.exercise, 80, 'exercise'),
      referenceId: bounded(args.referenceId, 80, 'referenceId'),
      referenceVersion: bounded(args.referenceVersion, 40, 'referenceVersion'),
      active: true,
    };
    if (existing) {
      if (existing.classroomId !== args.classroomId) throw new SenderError('assignment_classroom_mismatch');
      ctx.db.assignment.assignmentId.update(next);
      return;
    }
    ctx.db.assignment.insert(next);
  },
);

export const requestHelp = spacetimedb.reducer(
  { classroomId: t.string(), attemptId: t.string(), note: t.string() },
  (ctx, { classroomId, attemptId, note }) => {
    const member = [...ctx.db.membership.by_class_student.filter(classroomId)].some((row) =>
      row.student.equals(ctx.sender),
    );
    if (!member) throw new SenderError('not_classroom_member');
    ctx.db.helpRequest.insert({
      requestId: 0n,
      classroomId,
      student: ctx.sender,
      attemptId: bounded(attemptId, 80, 'attemptId'),
      note: bounded(note, 240, 'note'),
      open: true,
    });
  },
);

export const selectLearnerTrace = spacetimedb.reducer({ attemptId: t.string() }, (ctx, { attemptId }) => {
  const row = ctx.db.attempt.attemptId.find(bounded(attemptId, 80, 'attemptId'));
  if (!row || !teacherCanSee(ctx, row.owner)) throw new SenderError('trace_not_authorized');
  const existing = ctx.db.teacherSelection.teacher.find(ctx.sender);
  if (existing) {
    ctx.db.teacherSelection.teacher.update({ teacher: ctx.sender, attemptId: row.attemptId });
    return;
  }
  ctx.db.teacherSelection.insert({ teacher: ctx.sender, attemptId: row.attemptId });
});

export const publishReferenceFeature = spacetimedb.reducer(
  {
    referenceId: t.string(),
    analysisVersion: t.string(),
    transcript: t.string(),
    intendedPattern: t.string(),
    contourJson: t.string(),
  },
  (ctx, args) => {
    requireOwner(ctx);
    const id = bounded(args.referenceId, 80, 'referenceId');
    const next = {
      referenceId: id,
      analysisVersion: bounded(args.analysisVersion, 40, 'analysisVersion'),
      transcript: bounded(args.transcript, 240, 'transcript'),
      intendedPattern: bounded(args.intendedPattern, 40, 'intendedPattern'),
      contourJson: bounded(args.contourJson, MAX_PAYLOAD, 'contourJson'),
      updatedAtMicros: nowMicros(ctx),
    };
    const existing = ctx.db.referenceFeature.referenceId.find(id);
    if (existing) ctx.db.referenceFeature.referenceId.update(next);
    else ctx.db.referenceFeature.insert(next);
  },
);

export const commitVerified = spacetimedb.reducer(
  {
    attemptId: t.string(),
    exercise: t.string(),
    analysisVersion: t.string(),
    status: t.string(),
    findingCode: t.string(),
    spokenText: t.string(),
    cueId: t.string(),
    nextAction: t.string(),
    metricsJson: t.string(),
    evidenceJson: t.string(),
    fixtureMode: t.bool(),
    generation: t.u32(),
    deliveryId: t.string(),
  },
  (ctx, args) => {
    requireOwner(ctx);
    const row = ctx.db.attempt.attemptId.find(bounded(args.attemptId, 80, 'attemptId'));
    if (!row) throw new SenderError('attempt_missing');
    if (row.analysisState === 'superseded') throw new SenderError('attempt_superseded');
    const job = ctx.db.analysisJob.attemptId.find(row.attemptId);
    if (job && job.generation !== args.generation && job.state !== 'queued' && job.state !== 'leased') {
      throw new SenderError('stale_generation');
    }
    const session = ctx.db.practiceSession.sessionId.find(row.sessionId);
    if (session && session.activeAttemptId && session.activeAttemptId !== row.attemptId) {
      throw new SenderError('stale_attempt');
    }
    const stamp = nowMicros(ctx);
    const updated = {
      ...row,
      analysisVersion: bounded(args.analysisVersion, 40, 'analysisVersion'),
      captureState: 'complete',
      analysisState: args.fixtureMode ? 'synthetic_fixture' : 'verified',
      resultRevision: row.resultRevision + 1n,
      provenance: args.fixtureMode ? 'synthetic_fixture' : 'server_verified',
      fixtureMode: args.fixtureMode,
      findingCode: bounded(args.findingCode, 80, 'findingCode'),
      spokenText: bounded(args.spokenText, MAX_TEXT, 'spokenText'),
      cueId: bounded(args.cueId, 80, 'cueId'),
      nextAction: bounded(args.nextAction, 40, 'nextAction'),
      status: bounded(args.status, 40, 'status'),
      deliveryId: bounded(args.deliveryId, 120, 'deliveryId'),
      metricsJson: bounded(args.metricsJson, MAX_PAYLOAD, 'metricsJson'),
      evidenceJson: bounded(args.evidenceJson, MAX_PAYLOAD, 'evidenceJson'),
      updatedAtMicros: stamp,
    };
    ctx.db.attempt.attemptId.update(updated);
    if (job) {
      ctx.db.analysisJob.attemptId.update({ ...job, state: 'complete', generation: args.generation });
    }
    if (args.deliveryId && !ctx.db.feedbackDelivery.deliveryId.find(args.deliveryId)) {
      ctx.db.feedbackDelivery.insert({
        deliveryId: args.deliveryId,
        attemptId: row.attemptId,
        revision: updated.resultRevision,
        spoken: false,
      });
    }
    recordProgress(ctx, updated, bounded(args.exercise, 80, 'exercise'));
  },
);

export const markFeedbackSpoken = spacetimedb.reducer({ deliveryId: t.string() }, (ctx, { deliveryId }) => {
  requireOwner(ctx);
  const row = ctx.db.feedbackDelivery.deliveryId.find(bounded(deliveryId, 120, 'deliveryId'));
  if (!row || row.spoken) return;
  ctx.db.feedbackDelivery.deliveryId.update({ ...row, spoken: true });
});

export const claimNextJob = spacetimedb.procedure(t.string(), (ctx) =>
  ctx.withTx((tx) => {
    requireOwner(tx);
    const stamp = nowMicros(tx);
    for (const job of tx.db.analysisJob.iter()) {
      const expired = job.state === 'leased' && job.leaseExpiresMicros < stamp;
      if (job.state !== 'queued' && !expired) continue;
      tx.db.analysisJob.attemptId.update({
        ...job,
        state: 'leased',
        leaseExpiresMicros: stamp + LEASE_MICROS,
        retries: expired ? job.retries + 1 : job.retries,
      });
      return job.attemptId;
    }
    return '';
  }),
);

export const myProfile = spacetimedb.view(
  { name: 'my_profile', public: true },
  t.option(learnerProfile.rowType),
  (ctx) => ctx.db.learnerProfile.identity.find(ctx.sender) ?? undefined,
);

export const myProgress = spacetimedb.view(
  { name: 'my_progress', public: true },
  t.array(learnerProgress.rowType),
  (ctx) => [...ctx.db.learnerProgress.by_owner_exercise.filter(ctx.sender)],
);

export const mySessions = spacetimedb.view(
  { name: 'my_sessions', public: true },
  t.array(practiceSession.rowType),
  (ctx) => [...ctx.db.practiceSession.owner.filter(ctx.sender)],
);

export const myAttempts = spacetimedb.view(
  { name: 'my_attempts', public: true },
  t.array(attempt.rowType),
  (ctx) => [...ctx.db.attempt.owner.filter(ctx.sender)],
);

export const myActiveChunks = spacetimedb.view(
  { name: 'my_active_chunks', public: true },
  t.array(featureChunk.rowType),
  (ctx) => {
    const sessions = [...ctx.db.practiceSession.owner.filter(ctx.sender)];
    const active = sessions.find((row) => row.activeAttemptId !== '');
    if (!active) return [];
    return [...ctx.db.featureChunk.by_attempt_seq.filter(active.activeAttemptId)];
  },
);

export const myAssignments = spacetimedb.view(
  { name: 'my_assignments', public: true },
  t.array(assignment.rowType),
  (ctx) => {
    const rooms = [...ctx.db.membership.iter()].filter((row) => row.student.equals(ctx.sender));
    const assigned = [];
    for (const member of rooms) {
      for (const item of ctx.db.assignment.classroomId.filter(member.classroomId)) {
        if (item.active) assigned.push(item);
      }
    }
    return assigned;
  },
);

export const myClassroomSummary = spacetimedb.view(
  { name: 'my_classroom_summary', public: true },
  t.array(classroomSummary),
  (ctx) => {
    const rows = [];
    for (const room of ctx.db.classroom.teacher.filter(ctx.sender)) {
      const members = [...ctx.db.membership.by_class_student.filter(room.classroomId)];
      let usable = 0;
      let unusable = 0;
      let mismatch = 0;
      for (const member of members) {
        for (const progress of ctx.db.learnerProgress.by_owner_exercise.filter(member.student)) {
          usable += progress.usableAttempts;
          unusable += progress.unusableAttempts;
          mismatch += progress.endingMismatchCount;
        }
      }
      const help = [...ctx.db.helpRequest.classroomId.filter(room.classroomId)].filter((row) => row.open).length;
      rows.push({
        classroomId: room.classroomId,
        name: room.name,
        studentCount: members.length,
        usableAttempts: usable,
        unusableAttempts: unusable,
        endingMismatchCount: mismatch,
        openHelpRequests: help,
      });
    }
    return rows;
  },
);

export const selectedLearnerChunks = spacetimedb.view(
  { name: 'selected_learner_chunks', public: true },
  t.array(featureChunk.rowType),
  (ctx) => {
    const selection = ctx.db.teacherSelection.teacher.find(ctx.sender);
    if (!selection) return [];
    const row = ctx.db.attempt.attemptId.find(selection.attemptId);
    if (!row) return [];
    let allowed = false;
    for (const room of ctx.db.classroom.teacher.filter(ctx.sender)) {
      for (const member of ctx.db.membership.by_class_student.filter(room.classroomId)) {
        if (member.student.equals(row.owner)) allowed = true;
      }
    }
    if (!allowed) return [];
    return [...ctx.db.featureChunk.by_attempt_seq.filter(row.attemptId)];
  },
);
