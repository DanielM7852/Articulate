import { schema, table, t } from "spacetimedb/server";

// No public tables. All browser access goes through the scoped Python session gateway.
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
