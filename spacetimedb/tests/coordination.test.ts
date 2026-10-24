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
function finish(id: string, token = lease, extra: Record<string, unknown> = {}) {
  tx(c => module.finish_live_job(c, {
    job_id: id, lease_token: token, result_json: '{"revision":1}',
    state_json: JSON.stringify({ session_id: id, profile_id: profile }),
    summary_json: "", decision_json: "", notes_json: "", session_ttl_s: 300, ...extra,
  }));
}

beforeEach(() => {
  h = createModuleTestHarness(schema, module);
  now(100);
  tx(c => module.init(c, {}));
});

test("only the backend can enqueue and browser profiles cannot claim the signed namespace", () => {
  const args = enqueue();
  expect(() => tx(c => module.enqueue_live_job(c, args), outsider)).toThrow("backend only");
  expect(() => tx(c => module.claim_live_job(c, {
    job_id: args.job_id, worker_id: worker, lease_token: lease, lease_s: 30, concurrency_limit: 32,
  }), outsider)).toThrow("backend only");
  expect(() => tx(c => module.register_learner(c, { profile_id: profile, display_name: "A" }), outsider))
    .toThrow("reserved profile_id");
});

test("repeated submission uses one slot and rejects a changed payload or owner", () => {
  const args = enqueue();
  tx(c => module.enqueue_live_job(c, args));
  expect(h.db.liveQueue.id.find(0)?.active).toBe(1);
  expect(() => enqueue(args.job_id, { request_hash: "b".repeat(64) })).toThrow("idempotency conflict");
  expect(() => enqueue(args.job_id, {
    profile_id: otherProfile, request_json: JSON.stringify({ profileId: otherProfile }),
  })).toThrow("idempotency conflict");
});

test("global and per-profile admission limits are transactional", () => {
  enqueue(undefined, { profile_limit: 1 });
  expect(() => enqueue(undefined, { profile_limit: 1 })).toThrow("queue full");
  expect(() => enqueue(undefined, {
    profile_id: otherProfile, request_json: JSON.stringify({ profileId: otherProfile }), queue_limit: 1,
  })).toThrow("queue full");
  expect(h.db.liveQueue.id.find(0)?.active).toBe(1);
  expect([...h.db.liveJob.iter()]).toHaveLength(1);
});

test("a shared concurrency limit applies across independent workers and is released on finish", () => {
  const { job_id: first } = enqueue();
  const { job_id: second } = enqueue();
  const limitedClaim = (id: string) => tx(c => module.claim_live_job(c, {
    job_id: id, worker_id: crypto.randomUUID(), lease_token: lease, lease_s: 30, concurrency_limit: 1,
  }));
  limitedClaim(first);
  expect(() => limitedClaim(second)).toThrow("workers full");
  finish(first);
  limitedClaim(second);
  expect(h.db.liveQueue.id.find(0)?.running).toBe(1);
});

test("a live lease excludes competitors; an expired lease is fenced after takeover", () => {
  const { job_id: id } = enqueue();
  claim(id);
  const replacement = crypto.randomUUID();
  expect(() => claim(id, replacement)).toThrow("already leased");
  now(131);
  claim(id, replacement);
  expect(() => finish(id)).toThrow("stale lease");
  finish(id, replacement);
  finish(id, replacement);
  expect(h.db.liveQueue.id.find(0)?.active).toBe(0);
  expect(h.db.liveSession.id.find(id)?.revision).toBe(1);
  expect(h.db.liveJob.id.find(id)?.request_json).toBe("");
});

test("lease renewal extends ownership and rejects stale tokens", () => {
  const { job_id: id } = enqueue();
  claim(id);
  now(120);
  tx(c => module.renew_live_job(c, { job_id: id, lease_token: lease, lease_s: 30 }));
  now(131);
  expect(() => claim(id, crypto.randomUUID())).toThrow("already leased");
  expect(() => tx(c => module.renew_live_job(c, {
    job_id: id, lease_token: crypto.randomUUID(), lease_s: 30,
  }))).toThrow("stale lease");
  finish(id);
});

test("session turns are serialized and stale revisions cannot overwrite a committed turn", () => {
  const { job_id: sid } = enqueue();
  claim(sid); finish(sid);
  const args = { session_id: sid, kind: "session.turn", expected_revision: 1 };
  const { job_id: first } = enqueue(undefined, args);
  const { job_id: second } = enqueue(undefined, args);
  claim(first);
  expect(() => claim(second)).toThrow("session busy");
  finish(first, lease, { state_json: JSON.stringify({ session_id: sid, profile_id: profile }) });
  claim(second);
  expect(h.db.liveJob.id.find(second)?.error_code).toBe("revision_conflict");
  expect(h.db.liveSession.id.find(sid)?.revision).toBe(2);
  expect(h.db.liveQueue.id.find(0)?.active).toBe(0);
});

test("session ownership is checked before work is queued", () => {
  const { job_id: sid } = enqueue(); claim(sid); finish(sid);
  expect(() => enqueue(undefined, {
    session_id: sid, kind: "session.turn", expected_revision: 1, profile_id: otherProfile,
    request_json: JSON.stringify({ profileId: otherProfile }),
  })).toThrow("profile mismatch");
});

test("attempt history and the job result commit atomically", () => {
  const aid = crypto.randomUUID();
  enqueue(aid, { kind: "attempt.coach", session_id: "", request_json: JSON.stringify({
    profileId: profile, attemptId: aid, sound: "u", metricsSource: "inline",
  }) });
  claim(aid);
  expect(() => finish(aid, lease, {
    state_json: "", summary_json: "[]", decision_json: "{}",
  })).toThrow("JSON object");
  expect(h.db.liveJob.id.find(aid)?.status).toBe("running");
  expect(h.db.coachTurn.attempt_id.find(aid)).toBeNull();
  finish(aid, lease, { state_json: "", summary_json: '{"sound":"u"}', decision_json: '{"cueId":"round-lips"}' });
  expect(h.db.coachTurn.attempt_id.find(aid)?.profile_id).toBe(profile);
  expect(h.db.learnerAttempt.attempt_id.find(aid)?.status).toBe("coached");
});

test("crashed jobs have bounded retries and release their queue quota", () => {
  const { job_id: id } = enqueue();
  for (let i = 0; i < 3; i++) { now(100 + i * 31); claim(id, crypto.randomUUID()); }
  now(200); claim(id);
  expect(h.db.liveJob.id.find(id)?.error_code).toBe("retry_limit");
  expect(h.db.liveQueue.id.find(0)?.active).toBe(0);
  expect(h.db.liveQuota.profile_id.find(profile)).toBeNull();
});

test("bounded cleanup expires requests and sessions without deleting an active lease", () => {
  const { job_id: sid } = enqueue(); claim(sid); finish(sid);
  const { job_id: pending } = enqueue();
  now(3690); claim(pending);
  now(3701);
  tx(c => module.cleanup_live_state(c, { job_ids: [sid, pending], session_ids: [sid] }));
  expect(h.db.liveSession.id.find(sid)).toBeNull();
  expect(h.db.liveJob.id.find(sid)).toBeNull();
  expect(h.db.liveJob.id.find(pending)?.status).toBe("running");
  now(3721);
  tx(c => module.cleanup_live_state(c, { job_ids: [pending], session_ids: [] }));
  expect(h.db.liveJob.id.find(pending)).toBeNull();
  expect(h.db.liveQueue.id.find(0)?.active).toBe(0);
});

test("durable sessions are not evicted by the old 500-session process-local limit", () => {
  let oldest = "";
  for (let i = 0; i < 501; i++) {
    const { job_id: sid } = enqueue();
    if (!oldest) oldest = sid;
    claim(sid); finish(sid);
  }
  expect([...h.db.liveSession.iter()]).toHaveLength(501);
  expect(h.db.liveSession.id.find(oldest)?.revision).toBe(1);
  expect(h.db.liveQueue.id.find(0)?.active).toBe(0);
});
