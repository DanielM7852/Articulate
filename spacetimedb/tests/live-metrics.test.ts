import { beforeEach, expect, test } from "vitest";
import { ConnectionId } from "spacetimedb";
import {
  createModuleTestHarness,
  TestAuth,
} from "spacetimedb/server/test-utils";
import schema, * as module from "../src/index";

let harness: ReturnType<
  typeof createModuleTestHarness<typeof schema.schemaType>
>;
const backend = TestAuth.internal();
function user(sub: string, conn: bigint) {
  return TestAuth.fromJwtPayload(
    JSON.stringify({
      iss: "https://test.example",
      sub,
      aud: ["test"],
      iat: 0,
      exp: 4102444800,
    }),
    new ConnectionId(conn),
  );
}
const alice = user("alice", 1n);
const bob = user("bob", 2n);
const aid = "44444444-4444-4444-8444-444444444444";
const frames = JSON.stringify([{ t: 0, f1: 500, f2: 1500 }]);

const tx = <T>(a: TestAuth, f: (ctx: any) => T) => harness.withReducerTx(a, f);
const register = (a: TestAuth, p = "alice") =>
  tx(a, (c) =>
    module.register_learner(c, { profile_id: p, display_name: "Alice" }),
  );
const begin = (a: TestAuth, id = aid) =>
  tx(a, (c) => module.begin_attempt(c, { attempt_id: id, sound: "r" }));
const push = (a: TestAuth, seq = 0, kind = "audio", fj = frames) =>
  tx(a, (c) =>
    module.push_metrics(c, { attempt_id: aid, kind, seq, frames_json: fj }),
  );
const end = (a: TestAuth) =>
  tx(a, (c) => module.end_attempt(c, { attempt_id: aid }));

beforeEach(() => {
  harness = createModuleTestHarness(schema, module);
  tx(backend, (c) => module.init(c, {}));
  register(alice);
  register(bob, "bob");
});

test("register, begin, push, end happy path", () => {
  begin(alice);
  push(alice, 0, "audio");
  push(alice, 0, "video");
  end(alice);
  const a = harness.db.learnerAttempt.attempt_id.find(aid)!;
  expect(a.status).toBe("ended");
  expect(a.profile_id).toBe("alice");
  expect(a.ended_at).toBeTruthy();
  expect([...harness.db.metricBatch.iter()].length).toBe(2);
  end(alice);
  expect(harness.db.learnerAttempt.attempt_id.find(aid)!.status).toBe("ended");
});

test("begin requires registration, UUID, valid sound, no duplicates", () => {
  const carol = user("carol", 3n);
  expect(() => begin(carol)).toThrow("not a registered learner");
  expect(() => begin(alice, "nope")).toThrow("UUID");
  expect(() =>
    tx(alice, (c) =>
      module.begin_attempt(c, { attempt_id: aid, sound: "R1" }),
    ),
  ).toThrow("invalid sound");
  begin(alice);
  expect(() => begin(alice)).toThrow("already exists");
});

test("push to someone else's attempt is rejected", () => {
  begin(alice);
  expect(() => push(bob)).toThrow("not attempt owner");
  expect(() => end(bob)).toThrow("not attempt owner");
});

test("push after end is rejected", () => {
  begin(alice);
  end(alice);
  expect(() => push(alice)).toThrow("not open");
});

test("oversize or invalid frames are rejected", () => {
  begin(alice);
  expect(() => push(alice, 0, "audio", "not json")).toThrow("valid JSON");
  expect(() => push(alice, 0, "audio", "{}")).toThrow("array");
  expect(() => push(alice, 0, "audio", "[]")).toThrow("1-200");
  expect(() => push(alice, 0, "audio", "[1]")).toThrow("object");
  expect(() =>
    push(alice, 0, "audio", JSON.stringify(Array(201).fill({}))),
  ).toThrow("1-200");
  expect(() =>
    push(alice, 0, "audio", JSON.stringify([{ x: "a".repeat(33000) }])),
  ).toThrow("too large");
  expect(() => push(alice, 0, "text")).toThrow("audio or video");
  expect([...harness.db.metricBatch.iter()].length).toBe(0);
});

test("duplicate (attempt, kind, seq) is a silent no-op", () => {
  begin(alice);
  push(alice, 5, "audio");
  push(alice, 5, "audio");
  push(alice, 5, "video");
  expect([...harness.db.metricBatch.iter()].length).toBe(2);
});

test("backend-only reducers reject other senders", () => {
  begin(alice);
  expect(() =>
    tx(alice, (c) =>
      module.record_coach_turn(c, {
        attempt_id: aid,
        summary_json: "{}",
        decision_json: "{}",
      }),
    ),
  ).toThrow("backend only");
  expect(() =>
    tx(alice, (c) =>
      module.set_learner_note(c, { profile_id: "alice", notes_json: "{}" }),
    ),
  ).toThrow("backend only");
});

test("record_coach_turn marks attempt coached; set_learner_note upserts", () => {
  begin(alice);
  end(alice);
  const coach = (summary: string, decision: string) =>
    tx(backend, (c) =>
      module.record_coach_turn(c, {
        attempt_id: aid,
        summary_json: summary,
        decision_json: decision,
      }),
    );
  coach('{"score":1}', '{"next":"repeat"}');
  coach('{"score":2}', '{"next":"simplify"}');
  const a = harness.db.learnerAttempt.attempt_id.find(aid)!;
  expect(a.status).toBe("coached");
  expect(a.summary).toBe('{"score":2}');
  expect(harness.db.coachTurn.attempt_id.find(aid)?.decision).toBe(
    '{"next":"simplify"}',
  );
  expect(() => coach("[]", "{}")).toThrow("JSON object");
  const note = (n: string) =>
    tx(backend, (c) =>
      module.set_learner_note(c, { profile_id: "alice", notes_json: n }),
    );
  note('{"a":1}');
  note('{"a":2}');
  expect(harness.db.learnerNote.profile_id.find("alice")?.notes).toBe('{"a":2}');
  expect(() => note("x")).toThrow("valid JSON");
});

test("set_learner_progress is backend-only, validates, and upserts", () => {
  const put = (who: typeof backend, id: string, j: string) =>
    tx(who, (c) =>
      module.set_learner_progress(c, { profile_id: id, progress_json: j }),
    );
  expect(() => put(alice, "alice", "{}")).toThrow("backend only");
  expect(() => put(backend, "bad id!", "{}")).toThrow("invalid profile_id");
  expect(() => put(backend, "alice", "[]")).toThrow("JSON object");
  put(backend, "alice", '{"a":1}');
  put(backend, "alice", '{"a":2}');
  expect(harness.db.learnerProgress.profile_id.find("alice")?.progress).toBe(
    '{"a":2}',
  );
});

test("record_articulation is backend-only, validates, and upserts", () => {
  const put = (who: typeof backend, id: string, j: string) =>
    tx(who, (c) =>
      module.record_articulation(c, {
        attempt_id: "att-1",
        profile_id: id,
        features_json: j,
      }),
    );
  expect(() => put(alice, "alice", "{}")).toThrow("backend only");
  expect(() => put(backend, "bad id", "{}")).toThrow("invalid profile_id");
  expect(() => put(backend, "alice", "[]")).toThrow("JSON object");
  put(backend, "alice", '{"quality":"ok"}');
  put(backend, "alice", '{"quality":"insufficient"}');
  const rows = [...harness.db.learnerArticulation.iter()];
  expect(rows.length).toBe(1);
  expect(rows[0].features).toBe('{"quality":"insufficient"}');
});
