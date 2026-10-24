import { beforeEach, expect, test } from "vitest";
import { ConnectionId } from "spacetimedb";
import {
  createModuleTestHarness,
  TestAuth,
} from "spacetimedb/server/test-utils";
import schema, * as module from "../src/index";
const owner = "11111111-1111-4111-8111-111111111111",
  sid = "22222222-2222-4222-8222-222222222222";
let harness: ReturnType<
  typeof createModuleTestHarness<typeof schema.schemaType>
>;
const auth = TestAuth.internal();
function event(revision: number, type = "session.state", extra = {}) {
  return {
    schema_version: 1,
    type,
    event_id: crypto.randomUUID(),
    session_id: sid,
    attempt_id: null,
    generation_id: null,
    payload: {
      owner,
      expected_sync_revision: revision,
      session: {
        id: sid,
        owner,
        target_id: "i",
        target_version: 1,
        state: "ready",
        revision: 0,
      },
      ...extra,
    },
  };
}
function commit(e: unknown) {
  harness.withReducerTx(auth, (ctx) =>
    module.commit_event(ctx, { body: JSON.stringify(e) }),
  );
}
beforeEach(() => {
  harness = createModuleTestHarness(schema, module);
  harness.withReducerTx(auth, (ctx) => module.init(ctx, {}));
});
test("repeated events commit once and stale revisions fail atomically", () => {
  const e = event(0);
  commit(e);
  commit(e);
  expect(harness.db.sessions.id.find(sid)?.revision).toBe(1);
  expect(() => commit(event(0))).toThrow("revision conflict");
  expect(harness.db.sessions.id.find(sid)?.revision).toBe(1);
});
test("browser identity cannot forge accepted decisions", () => {
  const outsider = TestAuth.fromJwtPayload(
    JSON.stringify({
      iss: "https://test.example",
      sub: "learner",
      aud: ["test"],
      iat: 0,
      exp: 4102444800,
    }),
    new ConnectionId(1n),
  );
  expect(() =>
    harness.withReducerTx(outsider, (ctx) =>
      module.commit_event(ctx, { body: JSON.stringify(event(0)) }),
    ),
  ).toThrow("backend only");
  expect(harness.db.sessions.id.find(sid)).toBeNull();
});
test("ownership and invalid state transitions are rejected", () => {
  commit(event(0));
  expect(() =>
    commit(
      event(1, "session.state", {
        owner: "33333333-3333-4333-8333-333333333333",
      }),
    ),
  ).toThrow("owner mismatch");
  expect(() =>
    commit(
      event(1, "session.state", {
        session: {
          id: sid,
          owner,
          target_id: "i",
          target_version: 1,
          state: "presenting",
          revision: 1,
        },
      }),
    ),
  ).toThrow("invalid transition");
});
test("decision must reference an attempt owned by the same session", () => {
  commit(event(0));
  const attempt = crypto.randomUUID(),
    generation = crypto.randomUUID();
  const decision = {
    ...event(1, "coach.decision", {
      generation_id: generation,
      attempt_id: attempt,
      next_action: "repeat",
    }),
    attempt_id: attempt,
    generation_id: generation,
  };
  expect(() => commit(decision)).toThrow("unknown attempt");
  commit({
    ...event(1, "attempt.summary", { attempt_id: attempt, target_id: "i" }),
    attempt_id: attempt,
  });
  commit({
    ...decision,
    payload: { ...decision.payload, expected_sync_revision: 2 },
  });
  expect(harness.db.coachingDecisions.id.find(generation)?.sessionId).toBe(sid);
});
