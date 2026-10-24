import { beforeEach, expect, test } from "vitest";
import { ConnectionId, Timestamp } from "spacetimedb";
import { createModuleTestHarness, TestAuth } from "spacetimedb/server/test-utils";
import schema, * as module from "../src/index";

let h: ReturnType<typeof createModuleTestHarness<typeof schema.schemaType>>;
const auth = TestAuth.internal();
const outsider = TestAuth.fromJwtPayload(JSON.stringify({
  iss: "https://test.example", sub: "outsider", aud: ["test"], iat: 0, exp: 4102444800,
}), new ConnectionId(1n));
const profile = "p_" + "a".repeat(32);
const otherProfile = "p_" + "b".repeat(32);
const worker = crypto.randomUUID();
const lease = crypto.randomUUID();
const tx = <T>(fn: (ctx: any) => T, who = auth) => h.withReducerTx(who, fn);
const now = (seconds: number) => h.clock.set(new Timestamp(BigInt(seconds) * 1_000_000n));

function enqueue(id = crypto.randomUUID(), extra: Record<string, unknown> = {}) {
  const args = {
    job_id: id, profile_id: profile, session_id: id, kind: "session.start",
    request_json: JSON.stringify({ profileId: profile }), request_hash: "a".repeat(64),
    expected_revision: 0, queue_limit: 1000, profile_limit: 4, retention_s: 3600,
    ...extra,
  };
  tx(c => module.enqueue_live_job(c, args));
  return args;
}
function claim(id: string, token = lease) {
  tx(c => module.claim_live_job(c, { job_id: id, worker_id: worker, lease_token: token, lease_s: 30, concurrency_limit: 32 }));
}
function finish(id: string, extra: Record<string, unknown> = {}) {
  tx(c => module.finish_live_job(c, {
    job_id: id, lease_token: lease, result_json: '{"revision":1}',
    state_json: JSON.stringify({ session_id: id, profile_id: profile }),
    summary_json: "", decision_json: "", notes_json: "", session_ttl_s: 300, delivered_attempt_id: "", ...extra,
  }));
}

beforeEach(() => {
  h = createModuleTestHarness(schema, module);
  now(100);
  tx(c => module.init(c, {}));
});

const insightArgs = (extra: Record<string, unknown> = {}) => ({
  attempt_id: crypto.randomUUID(), profile_id: profile, sound: "u", status: "ready",
  say: "Round your lips.", source: "agent", ttl_s: 600, ...extra,
});
const setInsight = (a: ReturnType<typeof insightArgs>, who = auth) => tx(c => module.set_live_insight(c, a), who);

function runningTurn() {
  const { job_id: sid } = enqueue(); claim(sid); finish(sid);
  const { job_id: turn } = enqueue(undefined, { session_id: sid, kind: "session.turn", expected_revision: 1 });
  claim(turn);
  return { sid, turn, state: JSON.stringify({ session_id: sid, profile_id: profile }) };
}

test("insights are backend-only and validated", () => {
  expect(() => setInsight(insightArgs(), outsider)).toThrow("backend only");
  const bad: Record<string, unknown>[] = [
    { attempt_id: "nope" }, { profile_id: "bad id" }, { sound: "x" }, { status: "done" },
    { ttl_s: 59 }, { ttl_s: 86401 }, { say: "" }, { say: "a".repeat(601) }, { source: "other" },
    { status: "pending" }, { status: "none", source: "agent" }, { status: "pending", say: "", source: "agent" },
  ];
  for (const extra of bad) expect(() => setInsight(insightArgs(extra))).toThrow("invalid insight");
  setInsight(insightArgs({ status: "pending", say: "", source: "" }));
  setInsight(insightArgs({ status: "none", say: "", source: "" }));
  expect([...h.db.liveInsight.iter()]).toHaveLength(2);
});

test("insight upsert keeps created_at, refreshes expiry, and guards owner and delivery", () => {
  const a = insightArgs({ status: "pending", say: "", source: "" });
  setInsight(a);
  now(150);
  setInsight({ ...a, status: "ready", say: "Round.", source: "fallback", ttl_s: 900 });
  const row = h.db.liveInsight.attempt_id.find(a.attempt_id)!;
  expect([row.status, row.say, row.created_at, row.expires_at]).toEqual(["ready", "Round.", 100, 1050]);
  expect(() => setInsight({ ...a, profile_id: otherProfile })).toThrow("profile mismatch");
  const { turn, state } = runningTurn();
  finish(turn, { state_json: state, delivered_attempt_id: a.attempt_id });
  setInsight({ ...a, status: "ready", say: "Overwritten", source: "agent" });
  expect(h.db.liveInsight.attempt_id.find(a.attempt_id)).toMatchObject({ status: "delivered", say: "Round." });
});

test("finishing a turn marks the insight delivered atomically", () => {
  const a = insightArgs(); setInsight(a);
  const { turn, state } = runningTurn();
  finish(turn, { state_json: state, delivered_attempt_id: a.attempt_id });
  expect(h.db.liveInsight.attempt_id.find(a.attempt_id)?.status).toBe("delivered");
  expect(h.db.liveJob.id.find(turn)?.status).toBe("done");
  finish(turn, { state_json: state, delivered_attempt_id: a.attempt_id });
});

test("delivery with a missing, unready, foreign or wrong-kind insight conflicts and rolls back", () => {
  const pending = insightArgs({ status: "pending", say: "", source: "" });
  const foreign = insightArgs({ profile_id: otherProfile });
  setInsight(pending); setInsight(foreign);
  const { turn, sid, state } = runningTurn();
  for (const id of [crypto.randomUUID(), pending.attempt_id, foreign.attempt_id])
    expect(() => finish(turn, { state_json: state, delivered_attempt_id: id })).toThrow("insight conflict");
  expect(h.db.liveJob.id.find(turn)?.status).toBe("running");
  expect(h.db.liveSession.id.find(sid)?.revision).toBe(1);
  const ready = insightArgs(); setInsight(ready);
  const { job_id: other } = enqueue(); claim(other);
  expect(() => finish(other, { delivered_attempt_id: ready.attempt_id })).toThrow("insight conflict");
  expect(h.db.liveJob.id.find(other)?.status).toBe("running");
  expect(h.db.liveInsight.attempt_id.find(ready.attempt_id)?.status).toBe("ready");
});

test("cleanup deletes only expired insights", () => {
  const old = insightArgs({ ttl_s: 60 }); const fresh = insightArgs({ ttl_s: 600 });
  setInsight(old); setInsight(fresh);
  now(161);
  tx(c => module.cleanup_live_state(c, {
    job_ids: [], session_ids: [], insight_ids: [old.attempt_id, fresh.attempt_id, crypto.randomUUID()],
  }));
  expect(h.db.liveInsight.attempt_id.find(old.attempt_id)).toBeNull();
  expect(h.db.liveInsight.attempt_id.find(fresh.attempt_id)).not.toBeNull();
  expect(() => tx(c => module.cleanup_live_state(c, {
    job_ids: [], session_ids: [], insight_ids: Array.from({ length: 301 }, () => "x"),
  }))).toThrow("invalid cleanup limit");
});
