import { schema, table, t, type ReducerCtx } from "spacetimedb/server";
import {
  acceptInvite,
  ackLesson,
  attemptSummary,
  classAssignment,
  classIdentity,
  classInvite,
  classMember,
  classRoom,
  classroomBoardRows,
  clearHelp,
  commitVerified,
  learnerAttemptRows,
  learnerRoll,
  lessonAck,
  lessonAckEvent,
  lessonCommand,
  lessonOverride,
  markDisconnected,
  mintInvite,
  myAttemptRows,
  myLessonRows,
  reportProvisional,
  requestHelp,
  revokeLesson,
  saveLesson,
  setPresence,
} from "./classroom";

// No public tables except telemetry_event: a capped (400 rows) stream of derived numbers
// and short labels for the backend dashboard, with no identities, media or transcripts.
// Browsers otherwise call owned metric reducers or the authenticated Python gateway.
const backend = table(
  { name: "backend", public: false },
  { id: t.u32().primaryKey(), identity: t.identity() },
);
const sessions = table(
  { name: "sessions", public: false },
  {
    id: t.string().primaryKey(),
    owner: t.string(),
    revision: t.u32(),
    body: t.string(),
  },
);
const attempts = table(
  { name: "attempts", public: false },
  { id: t.string().primaryKey(), sessionId: t.string(), body: t.string() },
);
const coachingDecisions = table(
  { name: "coaching_decisions", public: false },
  { id: t.string().primaryKey(), sessionId: t.string(), body: t.string() },
);
const cueOutcomes = table(
  { name: "cue_outcomes", public: false },
  { id: t.string().primaryKey(), sessionId: t.string(), body: t.string() },
);
const acceptedEvents = table(
  { name: "accepted_events", public: false },
  { id: t.string().primaryKey(), sessionId: t.string() },
);
const learner = table(
  { name: "learner", public: false },
  {
    identity: t.identity().primaryKey(),
    profile_id: t.string().index(),
    display_name: t.string(),
    created_at: t.timestamp(),
    updated_at: t.timestamp(),
  },
);
const learnerAttempt = table(
  { name: "learner_attempt", public: false },
  {
    attempt_id: t.string().primaryKey(),
    learner: t.identity().index(),
    profile_id: t.string().index(),
    sound: t.string(),
    status: t.string(),
    started_at: t.timestamp(),
    ended_at: t.option(t.timestamp()),
    summary: t.string(),
  },
);
const metricBatch = table(
  { name: "metric_batch", public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    attempt_id: t.string().index(),
    kind: t.string(),
    seq: t.u32(),
    frame_count: t.u32(),
    frames: t.string(),
    received_at: t.timestamp(),
  },
);
const coachTurn = table(
  { name: "coach_turn", public: false },
  {
    attempt_id: t.string().primaryKey(),
    profile_id: t.string().index(),
    created_at: t.timestamp(),
    decision: t.string(),
  },
);
const learnerNote = table(
  { name: "learner_note", public: false },
  {
    profile_id: t.string().primaryKey(),
    notes: t.string(),
    updated_at: t.timestamp(),
  },
);
const learnerArticulation = table(
  { name: "learner_articulation", public: false },
  {
    attempt_id: t.string().primaryKey(),
    profile_id: t.string().index(),
    features: t.string(),
    created_at: t.timestamp(),
  },
);
const learnerProgress = table(
  { name: "learner_progress", public: false },
  {
    profile_id: t.string().primaryKey(),
    progress: t.string(),
    updated_at: t.timestamp(),
  },
);
// Backend-only coordination for horizontally replicated Python APIs/workers.
const liveSession = table(
  { name: "live_session", public: false },
  {
    id: t.string().primaryKey(), profile_id: t.string().index(),
    state_json: t.string(), revision: t.u32(), expires_at: t.u32().index(),
    active_job: t.string(),
  },
);
const liveJob = table(
  { name: "live_job", public: false },
  {
    id: t.string().primaryKey(), profile_id: t.string().index(),
    session_id: t.string(), kind: t.string(), request_json: t.string(), request_hash: t.string(),
    expected_revision: t.u32(), status: t.string().index(),
    worker_id: t.string(), lease_token: t.string(), lease_until: t.f64(), attempts: t.u32(),
    result_json: t.string(), error_code: t.string(),
    created_at: t.f64(), expires_at: t.u32().index(),
  },
);
const liveQueue = table(
  { name: "live_queue", public: false },
  { id: t.u32().primaryKey(), active: t.u32(), running: t.u32() },
);
const liveQuota = table(
  { name: "live_quota", public: false },
  { profile_id: t.string().primaryKey(), active: t.u32() },
);
const liveInsight = table(
  { name: "live_insight", public: false },
  {
    attempt_id: t.string().primaryKey(), profile_id: t.string().index(),
    sound: t.string(), status: t.string(), say: t.string(), source: t.string(),
    created_at: t.u32(), expires_at: t.u32().index(),
  },
);
const telemetryEvent = table(
  { name: "telemetry_event", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    source: t.string(),
    target: t.string(),
    kind: t.string(),
    label: t.string(),
    payload: t.string(),
  },
);
const db = schema({
  backend,
  sessions,
  attempts,
  coachingDecisions,
  cueOutcomes,
  acceptedEvents,
  learner,
  learnerAttempt,
  metricBatch,
  coachTurn,
  learnerNote,
  learnerProgress,
  learnerArticulation,
  liveSession,
  liveJob,
  liveQueue,
  liveQuota,
  liveInsight,
  telemetryEvent,
  classInvite,
  classIdentity,
  classRoom,
  classMember,
  lessonOverride,
  classAssignment,
  lessonCommand,
  lessonAck,
  lessonAckEvent,
  attemptSummary,
  learnerRoll,
});
export default db;

export const init = db.init((ctx) => {
  ctx.db.backend.insert({ id: 0, identity: ctx.sender });
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const commit_event = db.reducer(
  { body: t.string() },
  (ctx, { body }) => {
    const principal = ctx.db.backend.id.find(0);
    if (!principal || !ctx.sender.isEqual(principal.identity))
      throw new Error("backend only");
    if (body.length > 32768) throw new Error("event too large");
    const e = JSON.parse(body);
    if (
      e.schema_version !== 1 ||
      !uuid.test(e.event_id) ||
      !uuid.test(e.session_id) ||
      !uuid.test(e.payload?.owner)
    )
      throw new Error("invalid IDs/schema");
    if (ctx.db.acceptedEvents.id.find(e.event_id)) return;
    const current = ctx.db.sessions.id.find(e.session_id);
    const expected = e.payload.expected_sync_revision;
    if (
      !Number.isInteger(expected) ||
      expected < 0 ||
      expected !== (current?.revision ?? 0)
    )
      throw new Error("revision conflict");
    if (current && current.owner !== e.payload.owner)
      throw new Error("owner mismatch");
    if (!current && e.type !== "session.state")
      throw new Error("session must exist");
    if (e.type === "session.state") {
      const s = e.payload.session;
      if (
        s?.id !== e.session_id ||
        s.owner !== e.payload.owner ||
        !["i", "u", "aa"].includes(s.target_id) ||
        s.target_version !== 1 ||
        ![
          "ready",
          "capturing",
          "analyzing",
          "coaching",
          "presenting",
          "paused",
        ].includes(s.state)
      )
        throw new Error("invalid session");
      if (current) {
        const old = JSON.parse(current.body);
        const allowed: Record<string, string[]> = {
          ready: ["ready", "capturing", "paused"],
          capturing: ["capturing", "analyzing", "ready", "paused"],
          analyzing: ["coaching", "ready", "capturing", "paused"],
          coaching: ["presenting", "ready", "capturing", "paused"],
          presenting: ["ready", "capturing", "paused", "presenting"],
          paused: ["ready", "paused"],
        };
        if (!allowed[old.state]?.includes(s.state) || s.revision < old.revision)
          throw new Error("invalid transition");
      }
    } else if (e.type === "attempt.summary") {
      if (
        !uuid.test(e.attempt_id) ||
        e.payload.attempt_id !== e.attempt_id ||
        !["i", "u", "aa"].includes(e.payload.target_id)
      )
        throw new Error("invalid attempt");
      if (ctx.db.attempts.id.find(e.attempt_id))
        throw new Error("attempt already committed");
      ctx.db.attempts.insert({
        id: e.attempt_id,
        sessionId: e.session_id,
        body: JSON.stringify(e.payload),
      });
    } else if (e.type === "coach.decision") {
      if (
        !uuid.test(e.generation_id) ||
        e.payload.generation_id !== e.generation_id ||
        e.payload.attempt_id !== e.attempt_id
      )
        throw new Error("invalid decision");
      const attempt = ctx.db.attempts.id.find(e.attempt_id);
      if (!attempt || attempt.sessionId !== e.session_id)
        throw new Error("unknown attempt");
      if (
        ![
          "repeat",
          "change_cue",
          "simplify",
          "reduce_assistance",
          "next_target",
          "pause",
          "repair_capture",
        ].includes(e.payload.next_action)
      )
        throw new Error("invalid action");
      ctx.db.coachingDecisions.insert({
        id: e.generation_id,
        sessionId: e.session_id,
        body: JSON.stringify(e.payload),
      });
    } else if (e.type === "provider.status" && e.payload.cue_outcome) {
      ctx.db.cueOutcomes.insert({
        id: e.event_id,
        sessionId: e.session_id,
        body: JSON.stringify(e.payload.cue_outcome),
      });
    } else throw new Error("unsupported durable event");
    const next = {
      id: e.session_id,
      owner: e.payload.owner,
      revision: expected + 1,
      body:
        e.type === "session.state"
          ? JSON.stringify(e.payload.session)
          : current!.body,
    };
    if (current) ctx.db.sessions.id.update(next);
    else ctx.db.sessions.insert(next);
    ctx.db.acceptedEvents.insert({ id: e.event_id, sessionId: e.session_id });
  },
);

const encoder = new TextEncoder();
const byteLength = (v: string) => encoder.encode(v).length;
const profileIdRe = /^[A-Za-z0-9_.:@-]{1,64}$/;

function parseJsonObject(text: string, what: string): void {
  if (byteLength(text) > 16384) throw new Error(`${what} too large`);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`${what} must be a JSON object`);
}

export const register_learner = db.reducer(
  { profile_id: t.string(), display_name: t.string() },
  (ctx, { profile_id, display_name }) => {
    // Signed API guest profiles are reserved; only the backend can create their attempts.
    if (/^p_[0-9a-f]{32}$/.test(profile_id)) throw new Error("reserved profile_id");
    if (!profileIdRe.test(profile_id))
      throw new Error("invalid profile_id: 1-64 chars of [A-Za-z0-9_.:@-]");
    if (display_name.length > 80)
      throw new Error("display_name too long (max 80)");
    const existing = ctx.db.learner.identity.find(ctx.sender);
    if (existing)
      ctx.db.learner.identity.update({
        ...existing,
        profile_id,
        display_name,
        updated_at: ctx.timestamp,
      });
    else
      ctx.db.learner.insert({
        identity: ctx.sender,
        profile_id,
        display_name,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
      });
  },
);

export const begin_attempt = db.reducer(
  { attempt_id: t.string(), sound: t.string() },
  (ctx, { attempt_id, sound }) => {
    const me = ctx.db.learner.identity.find(ctx.sender);
    if (!me) throw new Error("not a registered learner");
    if (!uuid.test(attempt_id)) throw new Error("attempt_id must be a UUID");
    if (!/^[a-z]{1,16}$/.test(sound))
      throw new Error("invalid sound: 1-16 chars of [a-z]");
    if (ctx.db.learnerAttempt.attempt_id.find(attempt_id))
      throw new Error("attempt already exists");
    ctx.db.learnerAttempt.insert({
      attempt_id,
      learner: ctx.sender,
      profile_id: me.profile_id,
      sound,
      status: "open",
      started_at: ctx.timestamp,
      ended_at: undefined,
      summary: "",
    });
  },
);

const telemetryNodes = [
  "camera", "mediapipe", "mic", "audio", "stt", "tts",
  "backend", "pitch", "sparc", "db", "claude", "ui",
];
const telemetryKindRe = /^[a-z]+(\.[a-z_]+)+$/;
const TELEMETRY_KEEP = 400;

export const emit_telemetry = db.reducer(
  {
    source: t.string(),
    target: t.string(),
    kind: t.string(),
    label: t.string(),
    payload_json: t.string(),
  },
  (ctx, { source, target, kind, label, payload_json }) => {
    if (!telemetryNodes.includes(source)) throw new Error("unknown source node");
    if (!telemetryNodes.includes(target)) throw new Error("unknown target node");
    if (!telemetryKindRe.test(kind)) throw new Error("invalid kind");
    if (label.length > 120) throw new Error("label too long (max 120)");
    if (byteLength(payload_json) > 2048) throw new Error("payload too large");
    parseJsonObject(payload_json, "payload_json");
    ctx.db.telemetryEvent.insert({
      id: 0n,
      at: ctx.timestamp,
      source,
      target,
      kind,
      label,
      payload: payload_json,
    });
    const excess = Number(ctx.db.telemetryEvent.count()) - TELEMETRY_KEEP;
    if (excess <= 0) return;
    const ids: bigint[] = [];
    for (const row of ctx.db.telemetryEvent.iter()) ids.push(row.id);
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of ids.slice(0, excess)) ctx.db.telemetryEvent.id.delete(id);
  },
);

export const push_metrics = db.reducer(
  {
    attempt_id: t.string(),
    kind: t.string(),
    seq: t.u32(),
    frames_json: t.string(),
  },
  (ctx, { attempt_id, kind, seq, frames_json }) => {
    const attempt = ctx.db.learnerAttempt.attempt_id.find(attempt_id);
    if (!attempt) throw new Error("unknown attempt");
    if (!attempt.learner.isEqual(ctx.sender))
      throw new Error("not attempt owner");
    if (attempt.status !== "open") throw new Error("attempt is not open");
    if (kind !== "audio" && kind !== "video")
      throw new Error("kind must be audio or video");
    if (byteLength(frames_json) > 32768) throw new Error("frames too large");
    let frames: unknown;
    try {
      frames = JSON.parse(frames_json);
    } catch {
      throw new Error("frames_json is not valid JSON");
    }
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 200)
      throw new Error("frames_json must be a JSON array of 1-200 frames");
    for (const f of frames)
      if (typeof f !== "object" || f === null || Array.isArray(f))
        throw new Error("each frame must be a JSON object");
    for (const b of ctx.db.metricBatch.attempt_id.filter(attempt_id))
      if (b.kind === kind && b.seq === seq) return;
    ctx.db.metricBatch.insert({
      id: 0n,
      attempt_id,
      kind,
      seq,
      frame_count: frames.length,
      frames: frames_json,
      received_at: ctx.timestamp,
    });
  },
);

const telemetryNodes = [
  "camera", "mediapipe", "mic", "audio", "stt", "tts",
  "backend", "pitch", "sparc", "db", "claude", "ui",
];
const telemetryKindRe = /^[a-z]+(\.[a-z_]+)+$/;
const TELEMETRY_KEEP = 400;

export const emit_telemetry = db.reducer(
  {
    source: t.string(),
    target: t.string(),
    kind: t.string(),
    label: t.string(),
    payload_json: t.string(),
  },
  (ctx, { source, target, kind, label, payload_json }) => {
    if (!telemetryNodes.includes(source)) throw new Error("unknown source node");
    if (!telemetryNodes.includes(target)) throw new Error("unknown target node");
    if (!telemetryKindRe.test(kind)) throw new Error("invalid kind");
    if (label.length > 120) throw new Error("label too long (max 120)");
    if (byteLength(payload_json) > 2048) throw new Error("payload too large");
    parseJsonObject(payload_json, "payload_json");
    ctx.db.telemetryEvent.insert({
      id: 0n,
      at: ctx.timestamp,
      source,
      target,
      kind,
      label,
      payload: payload_json,
    });
    const excess = Number(ctx.db.telemetryEvent.count()) - TELEMETRY_KEEP;
    if (excess <= 0) return;
    // Auto-inc ids grow monotonically, so the lowest ids are the oldest rows.
    const ids: bigint[] = [];
    for (const row of ctx.db.telemetryEvent.iter()) ids.push(row.id);
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of ids.slice(0, excess)) ctx.db.telemetryEvent.id.delete(id);
  },
);

export const end_attempt = db.reducer(
  { attempt_id: t.string() },
  (ctx, { attempt_id }) => {
    const attempt = ctx.db.learnerAttempt.attempt_id.find(attempt_id);
    if (!attempt) throw new Error("unknown attempt");
    if (!attempt.learner.isEqual(ctx.sender))
      throw new Error("not attempt owner");
    if (attempt.status !== "open") return;
    ctx.db.learnerAttempt.attempt_id.update({
      ...attempt,
      status: "ended",
      ended_at: ctx.timestamp,
    });
  },
);

export const record_coach_turn = db.reducer(
  {
    attempt_id: t.string(),
    summary_json: t.string(),
    decision_json: t.string(),
  },
  (ctx, { attempt_id, summary_json, decision_json }) => {
    const principal = ctx.db.backend.id.find(0);
    if (!principal || !ctx.sender.isEqual(principal.identity))
      throw new Error("backend only");
    const attempt = ctx.db.learnerAttempt.attempt_id.find(attempt_id);
    if (!attempt) throw new Error("unknown attempt");
    parseJsonObject(summary_json, "summary_json");
    parseJsonObject(decision_json, "decision_json");
    ctx.db.learnerAttempt.attempt_id.update({
      ...attempt,
      summary: summary_json,
      status: "coached",
    });
    const row = {
      attempt_id,
      profile_id: attempt.profile_id,
      created_at: ctx.timestamp,
      decision: decision_json,
    };
    if (ctx.db.coachTurn.attempt_id.find(attempt_id))
      ctx.db.coachTurn.attempt_id.update(row);
    else ctx.db.coachTurn.insert(row);
  },
);

export const set_learner_note = db.reducer(
  { profile_id: t.string(), notes_json: t.string() },
  (ctx, { profile_id, notes_json }) => {
    const principal = ctx.db.backend.id.find(0);
    if (!principal || !ctx.sender.isEqual(principal.identity))
      throw new Error("backend only");
    if (!profileIdRe.test(profile_id)) throw new Error("invalid profile_id");
    parseJsonObject(notes_json, "notes_json");
    const row = { profile_id, notes: notes_json, updated_at: ctx.timestamp };
    if (ctx.db.learnerNote.profile_id.find(profile_id))
      ctx.db.learnerNote.profile_id.update(row);
    else ctx.db.learnerNote.insert(row);
  },
);

export const record_articulation = db.reducer(
  { attempt_id: t.string(), profile_id: t.string(), features_json: t.string() },
  (ctx, { attempt_id, profile_id, features_json }) => {
    const principal = ctx.db.backend.id.find(0);
    if (!principal || !ctx.sender.isEqual(principal.identity))
      throw new Error("backend only");
    if (!profileIdRe.test(profile_id)) throw new Error("invalid profile_id");
    parseJsonObject(features_json, "features_json");
    const row = {
      attempt_id,
      profile_id,
      features: features_json,
      created_at: ctx.timestamp,
    };
    if (ctx.db.learnerArticulation.attempt_id.find(attempt_id))
      ctx.db.learnerArticulation.attempt_id.update(row);
    else ctx.db.learnerArticulation.insert(row);
  },
);

export const set_learner_progress = db.reducer(
  { profile_id: t.string(), progress_json: t.string() },
  (ctx, { profile_id, progress_json }) => {
    const principal = ctx.db.backend.id.find(0);
    if (!principal || !ctx.sender.isEqual(principal.identity))
      throw new Error("backend only");
    if (!profileIdRe.test(profile_id)) throw new Error("invalid profile_id");
    parseJsonObject(progress_json, "progress_json");
    const row = { profile_id, progress: progress_json, updated_at: ctx.timestamp };
    if (ctx.db.learnerProgress.profile_id.find(profile_id))
      ctx.db.learnerProgress.profile_id.update(row);
    else ctx.db.learnerProgress.insert(row);
  },
);

type LiveContext = ReducerCtx<typeof db.schemaType>;

function requireBackend(ctx: LiveContext): void {
  const principal = ctx.db.backend.id.find(0);
  if (!principal || !ctx.sender.isEqual(principal.identity)) throw new Error("backend only");
}

const nowSeconds = (ctx: LiveContext) => Math.floor(Number(ctx.timestamp.microsSinceUnixEpoch) / 1_000_000);

function releaseLiveJob(ctx: LiveContext, job: typeof liveJob.rowType.type): void {
  const queue = ctx.db.liveQueue.id.find(0)!;
  ctx.db.liveQueue.id.update({ ...queue, active: queue.active - 1,
    running: queue.running - (job.status === "running" ? 1 : 0) });
  const quota = ctx.db.liveQuota.profile_id.find(job.profile_id)!;
  if (quota.active === 1) ctx.db.liveQuota.profile_id.delete(job.profile_id);
  else ctx.db.liveQuota.profile_id.update({ ...quota, active: quota.active - 1 });
  const session = ctx.db.liveSession.id.find(job.session_id);
  if (session?.active_job === job.id) ctx.db.liveSession.id.update({ ...session, active_job: "" });
}

export const enqueue_live_job = db.reducer(
  {
    job_id: t.string(), profile_id: t.string(), session_id: t.string(), kind: t.string(),
    request_json: t.string(), request_hash: t.string(), expected_revision: t.u32(),
    queue_limit: t.u32(), profile_limit: t.u32(), retention_s: t.u32(),
  },
  (ctx, p) => {
    requireBackend(ctx);
    if (!uuid.test(p.job_id) || !/^p_[0-9a-f]{32}$/.test(p.profile_id)) throw new Error("invalid IDs");
    if (!["session.start", "session.turn", "attempt.coach", "notes.update"].includes(p.kind))
      throw new Error("invalid job kind");
    if (!/^[0-9a-f]{64}$/.test(p.request_hash) || byteLength(p.request_json) > 524288)
      throw new Error("invalid request");
    const request = JSON.parse(p.request_json);
    if (request.profileId !== p.profile_id) throw new Error("profile mismatch");
    const previous = ctx.db.liveJob.id.find(p.job_id);
    if (previous) {
      if (previous.profile_id !== p.profile_id || previous.request_hash !== p.request_hash ||
          previous.kind !== p.kind || previous.session_id !== p.session_id)
        throw new Error("idempotency conflict");
      return;
    }
    if (p.queue_limit < 1 || p.queue_limit > 10000 || p.profile_limit < 1 || p.profile_limit > 16 ||
        p.retention_s < 300 || p.retention_s > 86400) throw new Error("invalid queue limits");
    const now = nowSeconds(ctx);
    if (p.kind === "session.start") {
      if (p.session_id !== p.job_id || p.expected_revision !== 0) throw new Error("invalid session start");
    } else if (p.kind === "session.turn") {
      const session = ctx.db.liveSession.id.find(p.session_id);
      if (!session || session.expires_at <= now) throw new Error("session not found");
      if (session.profile_id !== p.profile_id) throw new Error("profile mismatch");
      if (p.expected_revision !== session.revision) throw new Error("revision conflict");
    } else if (p.session_id !== "") throw new Error("unexpected session");
    const queue = ctx.db.liveQueue.id.find(0) ?? ctx.db.liveQueue.insert({ id: 0, active: 0, running: 0 });
    const quota = ctx.db.liveQuota.profile_id.find(p.profile_id);
    if (queue.active >= p.queue_limit || (quota?.active ?? 0) >= p.profile_limit)
      throw new Error("queue full");
    if (p.kind === "attempt.coach") {
      if (!uuid.test(request.attemptId) || !["i", "u", "a"].includes(request.sound) ||
          request.metricsSource !== "inline") throw new Error("invalid attempt");
      const attempt = ctx.db.learnerAttempt.attempt_id.find(request.attemptId);
      if (attempt) throw new Error("attempt already exists");
      ctx.db.learnerAttempt.insert({
        attempt_id: request.attemptId, learner: ctx.sender, profile_id: p.profile_id,
        sound: request.sound, status: "ended", started_at: ctx.timestamp,
        ended_at: ctx.timestamp, summary: "",
      });
    }
    ctx.db.liveQueue.id.update({ ...queue, active: queue.active + 1 });
    const nextQuota = { profile_id: p.profile_id, active: (quota?.active ?? 0) + 1 };
    if (quota) ctx.db.liveQuota.profile_id.update(nextQuota);
    else ctx.db.liveQuota.insert(nextQuota);
    ctx.db.liveJob.insert({
      id: p.job_id, profile_id: p.profile_id, session_id: p.session_id, kind: p.kind,
      request_json: p.request_json, request_hash: p.request_hash, expected_revision: p.expected_revision,
      status: "queued", worker_id: "", lease_token: "", lease_until: 0, attempts: 0,
      result_json: "", error_code: "", created_at: now, expires_at: now + p.retention_s,
    });
  },
);

export const claim_live_job = db.reducer(
  { job_id: t.string(), worker_id: t.string(), lease_token: t.string(), lease_s: t.u32(), concurrency_limit: t.u32() },
  (ctx, { job_id, worker_id, lease_token, lease_s, concurrency_limit }) => {
    requireBackend(ctx);
    if (!uuid.test(worker_id) || !uuid.test(lease_token) || lease_s < 30 || lease_s > 300)
      throw new Error("invalid lease");
    const job = ctx.db.liveJob.id.find(job_id);
    const now = nowSeconds(ctx);
    if (!job || !["queued", "running"].includes(job.status) || job.expires_at <= now)
      throw new Error("job not available");
    if (job.status === "running" && job.lease_until > now) throw new Error("job already leased");
    const session = ctx.db.liveSession.id.find(job.session_id);
    if (session?.active_job && session.active_job !== job.id) {
      const active = ctx.db.liveJob.id.find(session.active_job);
      if (active && active.status === "running" && active.lease_until > now)
        throw new Error("session busy");
    }
    let error = job.attempts >= 3 ? "retry_limit" : "";
    if (job.kind === "session.turn" && (!session || session.expires_at <= now)) error = "session_not_found";
    if (job.kind === "session.turn" && session && session.revision !== job.expected_revision) error = "revision_conflict";
    if (error) {
      releaseLiveJob(ctx, job);
      ctx.db.liveJob.id.update({ ...job, status: "failed", error_code: error, request_json: "" });
      return;
    }
    if (concurrency_limit < 1 || concurrency_limit > 1000) throw new Error("invalid concurrency limit");
    const queue = ctx.db.liveQueue.id.find(0)!;
    if (job.status === "queued") {
      if (queue.running >= concurrency_limit) throw new Error("workers full");
      ctx.db.liveQueue.id.update({ ...queue, running: queue.running + 1 });
    }
    if (session) ctx.db.liveSession.id.update({ ...session, active_job: job.id });
    ctx.db.liveJob.id.update({
      ...job, status: "running", worker_id, lease_token, lease_until: now + lease_s, attempts: job.attempts + 1,
    });
  },
);

export const renew_live_job = db.reducer(
  { job_id: t.string(), lease_token: t.string(), lease_s: t.u32() },
  (ctx, { job_id, lease_token, lease_s }) => {
    requireBackend(ctx);
    const job = ctx.db.liveJob.id.find(job_id);
    const now = nowSeconds(ctx);
    if (!job || job.status !== "running" || job.lease_token !== lease_token || job.lease_until <= now)
      throw new Error("stale lease");
    if (lease_s < 30 || lease_s > 300) throw new Error("invalid lease");
    ctx.db.liveJob.id.update({ ...job, lease_until: now + lease_s });
  },
);

export const finish_live_job = db.reducer(
  {
    job_id: t.string(), lease_token: t.string(), result_json: t.string(), state_json: t.string(),
    summary_json: t.string(), decision_json: t.string(), notes_json: t.string(), session_ttl_s: t.u32(),
    delivered_attempt_id: t.string(),
  },
  (ctx, p) => {
    requireBackend(ctx);
    const job = ctx.db.liveJob.id.find(p.job_id);
    const now = nowSeconds(ctx);
    // Retried completion of the same lease is harmless after a lost HTTP response.
    if (job?.status === "done" && job.lease_token === p.lease_token) return;
    if (!job || job.status !== "running" || job.lease_token !== p.lease_token || job.lease_until <= now)
      throw new Error("stale lease");
    // Delivery is committed with the turn that speaks the insight; any failure rolls both back.
    const delivered = p.delivered_attempt_id ? ctx.db.liveInsight.attempt_id.find(p.delivered_attempt_id) : null;
    if (p.delivered_attempt_id && (job.kind !== "session.turn" || !delivered ||
        delivered.profile_id !== job.profile_id || delivered.status !== "ready"))
      throw new Error("insight conflict");
    parseJsonObject(p.result_json, "result_json");
    if (job.kind.startsWith("session.")) {
      parseJsonObject(p.state_json, "state_json");
      if (p.session_ttl_s < 1 || p.session_ttl_s > 86400) throw new Error("invalid session TTL");
      const state = JSON.parse(p.state_json);
      const session = ctx.db.liveSession.id.find(job.session_id);
      if (state.session_id !== job.session_id || state.profile_id !== job.profile_id ||
          (session?.revision ?? 0) !== job.expected_revision ||
          (session && session.active_job !== job.id)) throw new Error("revision conflict");
      const row = { id: job.session_id, profile_id: job.profile_id, state_json: p.state_json,
        revision: job.expected_revision + 1, expires_at: now + p.session_ttl_s, active_job: "" };
      if (session) ctx.db.liveSession.id.update(row);
      else ctx.db.liveSession.insert(row);
    } else if (p.state_json) throw new Error("unexpected state");
    if (job.kind === "attempt.coach") {
      const request = JSON.parse(job.request_json);
      const attempt = ctx.db.learnerAttempt.attempt_id.find(request.attemptId);
      if (!attempt || attempt.profile_id !== job.profile_id) throw new Error("profile mismatch");
      record_coach_turn(ctx, { attempt_id: request.attemptId, summary_json: p.summary_json, decision_json: p.decision_json });
    } else if (p.summary_json || p.decision_json) throw new Error("unexpected attempt");
    if (p.notes_json) {
      if (job.kind !== "notes.update") throw new Error("unexpected notes");
      set_learner_note(ctx, { profile_id: job.profile_id, notes_json: p.notes_json });
    }
    if (delivered) ctx.db.liveInsight.attempt_id.update({ ...delivered, status: "delivered" });
    releaseLiveJob(ctx, job);
    ctx.db.liveJob.id.update({ ...job, status: "done", result_json: p.result_json, request_json: "" });
  },
);

export const set_live_insight = db.reducer(
  {
    attempt_id: t.string(), profile_id: t.string(), sound: t.string(), status: t.string(),
    say: t.string(), source: t.string(), ttl_s: t.u32(),
  },
  (ctx, p) => {
    requireBackend(ctx);
    const ready = p.status === "ready";
    if (!uuid.test(p.attempt_id) || !profileIdRe.test(p.profile_id) || !["i", "u", "a"].includes(p.sound) ||
        !["pending", "ready", "none"].includes(p.status) || p.ttl_s < 60 || p.ttl_s > 86400 ||
        (ready ? p.say.length < 1 || p.say.length > 600 || !["agent", "fallback"].includes(p.source)
          : p.say !== "" || p.source !== "")) throw new Error("invalid insight");
    const previous = ctx.db.liveInsight.attempt_id.find(p.attempt_id);
    if (previous && previous.profile_id !== p.profile_id) throw new Error("profile mismatch");
    if (previous?.status === "delivered") return;
    const now = nowSeconds(ctx);
    const row = { attempt_id: p.attempt_id, profile_id: p.profile_id, sound: p.sound, status: p.status,
      say: p.say, source: p.source, created_at: previous?.created_at ?? now, expires_at: now + p.ttl_s };
    if (previous) ctx.db.liveInsight.attempt_id.update(row);
    else ctx.db.liveInsight.insert(row);
  },
);

export const fail_live_job = db.reducer(
  { job_id: t.string(), lease_token: t.string() },
  (ctx, { job_id, lease_token }) => {
    requireBackend(ctx);
    const job = ctx.db.liveJob.id.find(job_id);
    if (!job || job.status !== "running" || job.lease_token !== lease_token || job.lease_until <= nowSeconds(ctx))
      throw new Error("stale lease");
    releaseLiveJob(ctx, job);
    ctx.db.liveJob.id.update({ ...job, status: "failed", error_code: "processing_failed", request_json: "" });
  },
);

// Workers select bounded batches with the expiry indexes; recheck every deletion transactionally.
export const cleanup_live_state = db.reducer(
  { job_ids: t.array(t.string()), session_ids: t.array(t.string()), insight_ids: t.array(t.string()) },
  (ctx, { job_ids, session_ids, insight_ids }) => {
    requireBackend(ctx);
    if (job_ids.length + session_ids.length + insight_ids.length > 300) throw new Error("invalid cleanup limit");
    const now = nowSeconds(ctx);
    for (const id of job_ids) {
      const job = ctx.db.liveJob.id.find(id);
      if (!job || job.expires_at > now) continue;
      if (job.status === "running" && job.lease_until > now) continue;
      if (["queued", "running"].includes(job.status)) releaseLiveJob(ctx, job);
      ctx.db.liveJob.id.delete(job.id);
    }
    for (const id of session_ids) {
      const session = ctx.db.liveSession.id.find(id);
      if (!session || session.expires_at > now) continue;
      const active = ctx.db.liveJob.id.find(session.active_job);
      if (active?.status === "running" && active.lease_until > now) continue;
      ctx.db.liveSession.id.delete(session.id);
    }
    for (const id of insight_ids) {
      const insight = ctx.db.liveInsight.attempt_id.find(id);
      if (insight && insight.expires_at <= now) ctx.db.liveInsight.attempt_id.delete(id);
    }
  },
);

const lessonView = t.row("ClassroomLessonRow", {
  profile_id: t.string().primaryKey(),
  revision: t.u32(),
  command_id: t.string(),
  source: t.string(),
  settings_json: t.string(),
  visible: t.string(),
  status: t.string(),
  ack_phase: t.string(),
});

const boardView = t.row("ClassroomBoardRow", {
  profile_id: t.string().primaryKey(),
  display_name: t.string(),
  classroom_id: t.string(),
  presence: t.string(),
  presence_at: t.u64(),
  exercise: t.string(),
  lesson_revision: t.u32(),
  lesson_source: t.string(),
  override_revision: t.u32(),
  classroom_revision: t.u32(),
  visible: t.string(),
  settings_json: t.string(),
  ack_phase: t.string(),
  usable: t.u32(),
  unusable: t.u32(),
  last_finding: t.string(),
  last_kind: t.string(),
  last_provenance: t.string(),
  last_at: t.u64(),
  repeat_count: t.u32(),
  needs_attention: t.bool(),
  synthetic_repeat: t.u32(),
  help_requested: t.bool(),
  help_note: t.string(),
});

const attemptView = t.row("AttemptCardRow", {
  attempt_id: t.string().primaryKey(),
  profile_id: t.string(),
  exercise: t.string(),
  usable: t.bool(),
  finding: t.string(),
  kind: t.string(),
  provenance: t.string(),
  reference_version: t.string(),
  analysis_version: t.string(),
  cue_id: t.string(),
  measurements_json: t.string(),
  synthetic: t.bool(),
  created_at: t.u64(),
});

export const mint_invite = db.reducer(
  { code: t.string(), role: t.string(), profile_id: t.string(), classroom_id: t.string(), display_name: t.string() },
  (ctx, args) => mintInvite(ctx, args),
);
export const accept_invite = db.reducer({ code: t.string() }, (ctx, { code }) => acceptInvite(ctx, code));
export const save_lesson = db.reducer(
  {
    command_id: t.string(),
    scope: t.string(),
    target_profile: t.string(),
    classroom_id: t.string(),
    expected_revision: t.u32(),
    settings_json: t.string(),
    expires_in_minutes: t.u32(),
  },
  (ctx, args) => saveLesson(ctx, args),
);
export const revoke_lesson = db.reducer(
  { command_id: t.string(), scope: t.string(), target_profile: t.string(), classroom_id: t.string(), expected_revision: t.u32() },
  (ctx, args) => revokeLesson(ctx, args),
);
export const ack_lesson = db.reducer(
  { revision: t.u32(), phase: t.string(), command_id: t.string() },
  (ctx, args) => ackLesson(ctx, args),
);
export const set_presence = db.reducer(
  { presence: t.string(), exercise: t.string() },
  (ctx, { presence, exercise }) => setPresence(ctx, presence, exercise),
);
export const request_help = db.reducer({ message: t.string() }, (ctx, { message }) => requestHelp(ctx, message));
export const clear_help = db.reducer({ profile_id: t.string() }, (ctx, { profile_id }) => clearHelp(ctx, profile_id));
export const report_provisional = db.reducer(
  {
    attempt_id: t.string(),
    exercise: t.string(),
    usable: t.bool(),
    finding: t.string(),
    reference_version: t.string(),
    measurements_json: t.string(),
  },
  (ctx, args) => reportProvisional(ctx, args),
);
export const commit_verified_summary = db.reducer(
  {
    profile_id: t.string(),
    attempt_id: t.string(),
    exercise: t.string(),
    usable: t.bool(),
    finding: t.string(),
    provenance: t.string(),
    reference_version: t.string(),
    analysis_version: t.string(),
    cue_id: t.string(),
    measurements_json: t.string(),
    synthetic: t.bool(),
  },
  (ctx, args) => commitVerified(ctx, args),
);
export const classroom_disconnect = db.clientDisconnected((ctx) => markDisconnected(ctx));

export const my_classroom_lesson = db.view(
  { public: true, name: "my_classroom_lesson" },
  t.array(lessonView),
  (ctx) => myLessonRows(ctx),
);
export const classroom_board = db.view(
  { public: true, name: "classroom_board" },
  t.array(boardView),
  (ctx) => classroomBoardRows(ctx),
);
export const my_attempt_cards = db.view(
  { public: true, name: "my_attempt_cards" },
  t.array(attemptView),
  (ctx) => myAttemptRows(ctx),
);
export const learner_attempt_cards = db.view(
  { public: true, name: "learner_attempt_cards" },
  { profile_id: t.string() },
  t.array(attemptView),
  (ctx, { profile_id }) => learnerAttemptRows(ctx, profile_id),
);
