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
const db = schema({
  backend,
  sessions,
  attempts,
  coachingDecisions,
  cueOutcomes,
  acceptedEvents,
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
