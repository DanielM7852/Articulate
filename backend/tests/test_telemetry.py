import asyncio
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app import telemetry
from app.integrations.spacetime import SpacetimeClient, table_of
from app.main import create_app
from tests.support import make_settings


class FakeClient:
    def __init__(self):
        self.calls = []
        self.gate = None

    async def call(self, reducer, args):
        if self.gate is not None:
            await self.gate.wait()
        self.calls.append((reducer, args))


@pytest.fixture(autouse=True)
def _reset():
    telemetry.reset()
    yield
    telemetry.reset()


def test_noop_when_unconfigured(tmp_path):
    telemetry.emit("backend", "db", "db.read", "x", {"a": 1})  # no client, no loop: must not raise
    assert telemetry.configure(make_settings(tmp_path)) is False
    telemetry.emit("backend", "db", "db.read", "x", {"a": 1})


def test_label_and_payload_truncation():
    assert len(telemetry._clip("x" * 500, telemetry.LABEL_MAX)) == 120
    big = telemetry._payload_json({"model": "m", "line": "y" * 5000})
    assert "line" not in json.loads(big)
    assert len(big.encode()) <= telemetry.PAYLOAD_MAX_BYTES
    assert telemetry._payload_json({"blob": "z" * 5000}) == "{}"
    assert json.loads(telemetry._payload_json({"a": 1})) == {"a": 1}


def test_line_of():
    class P:
        caption = "c" * 300
    assert telemetry.line_of(P()) == "c" * 120
    assert telemetry.line_of(object()) == "object"


def test_emit_on_loop_and_from_worker_thread():
    async def run():
        fake = FakeClient()
        assert telemetry.configure(client=fake)
        telemetry.emit("backend", "claude", "claude.request", "l" * 300, {"model": "m"})
        await asyncio.to_thread(telemetry.emit, "claude", "backend", "claude.response", "ok", {"model": "m"})
        for _ in range(50):
            if len(fake.calls) == 2:
                break
            await asyncio.sleep(0.01)
        return fake.calls

    calls = asyncio.run(run())
    assert len(calls) == 2
    reducer, args = calls[0]
    assert reducer == "emit_telemetry"
    assert args[:3] == ["backend", "claude", "claude.request"] and len(args[3]) == 120
    assert json.loads(args[4]) == {"model": "m"}
    assert calls[1][1][2] == "claude.response"


def test_in_flight_guard_drops_flood():
    async def run():
        fake = FakeClient()
        fake.gate = asyncio.Event()
        telemetry.configure(client=fake)
        for _ in range(100):
            telemetry.emit("backend", "db", "db.read", "x", {})
        assert telemetry._inflight == telemetry.MAX_IN_FLIGHT
        fake.gate.set()
        await asyncio.sleep(0.05)
        return len(fake.calls), telemetry._inflight

    sent, inflight = asyncio.run(run())
    assert sent == telemetry.MAX_IN_FLIGHT and inflight == 0


def test_real_client_posts_reducer_and_never_reports_itself(tmp_path):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.content))
        return httpx.Response(200, json=[])

    settings = make_settings(tmp_path, spacetime_database="db1", spacetime_token="tok", telemetry_enabled=True)

    async def run():
        assert telemetry.configure(settings, httpx.MockTransport(handler))
        telemetry.emit("backend", "tts", "tts.token", "t", {})
        await asyncio.sleep(0.1)
        await telemetry.aclose()

    asyncio.run(run())
    assert len(seen) == 1  # the emit_telemetry call did not trigger a db.write event
    assert "/call/emit_telemetry" in seen[0][0]
    assert json.loads(seen[0][1])[:3] == ["backend", "tts", "tts.token"]


def test_client_failure_is_swallowed():
    class Boom(FakeClient):
        async def call(self, reducer, args):
            raise RuntimeError("down")

    async def run():
        telemetry.configure(client=Boom())
        telemetry.emit("backend", "db", "db.read", "x", {})
        await asyncio.sleep(0.05)
        return telemetry._inflight

    assert asyncio.run(run()) == 0


def test_claude_call_emits_and_reraises():

    class Usage:
        input_tokens = 5
        output_tokens = 7

    class Resp:
        usage = Usage()
        parsed_output = type("Out", (), {"caption": "hello"})()

    async def run():
        fake = FakeClient()
        telemetry.configure(client=fake)
        resp = await asyncio.to_thread(telemetry.claude_call, "m", "notes", lambda: Resp())
        with pytest.raises(ValueError):
            await asyncio.to_thread(telemetry.claude_call, "m", "notes", lambda: (_ for _ in ()).throw(ValueError("x")))
        await asyncio.sleep(0.1)
        return resp, fake.calls

    resp, calls = asyncio.run(run())
    kinds = sorted(c[1][2] for c in calls)
    assert kinds == ["claude.error", "claude.request", "claude.request", "claude.response"]
    response = next(json.loads(c[1][4]) for c in calls if c[1][2] == "claude.response")
    assert response["inputTokens"] == 5 and response["outputTokens"] == 7 and response["line"] == "hello"


class Maincloud:
    """MockTransport handler: /v1/identity mints a token, reducer calls are recorded."""

    def __init__(self, identity_status=200):
        self.identity_status = identity_status
        self.mints = 0
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/identity":
            self.mints += 1
            if self.identity_status != 200:
                return httpx.Response(self.identity_status, text="down")
            return httpx.Response(200, json={"identity": "c200" + "ab" * 30, "token": "anon-token"})
        self.calls.append((request.url.path, request.headers.get("authorization"), json.loads(request.content)))
        return httpx.Response(200, json=[])

    def kinds(self):
        return [args[2] for _, _, args in self.calls]


async def _settle(predicate, steps=100):
    for _ in range(steps):
        if predicate():
            return
        await asyncio.sleep(0.01)


def _anonymous_settings(tmp_path, **overrides):
    data = {"telemetry_enabled": True, "spacetime_database": None, "spacetime_token": None}
    data.update(overrides)
    return make_settings(tmp_path, **data)


def test_anonymous_identity_minted_cached_and_announced(tmp_path):
    cloud = Maincloud()
    settings = _anonymous_settings(tmp_path, live_coach_provider="openai", articulation_url="http://127.0.0.1:8010")

    async def run():
        assert telemetry.configure(settings, httpx.MockTransport(cloud), announce=True) is False  # live later
        await _settle(lambda: cloud.calls)
        assert telemetry.enabled()
        telemetry.emit("backend", "pitch", "pitch.extract", "x", {"seconds": 1})
        await _settle(lambda: len(cloud.calls) == 2)
        await telemetry.aclose()

    asyncio.run(run())
    assert cloud.mints == 1
    path, auth, args = cloud.calls[0]
    assert path == "/v1/database/articulate-live/call/emit_telemetry"
    assert auth == "Bearer anon-token"
    assert args[:4] == ["backend", "db", "backend.up", "backend online"]
    assert json.loads(args[4]) == {
        "provider": "openai", "model": settings.live_openai_model, "articulation": True,
        "pitchTable": settings.pitch_table_enabled, "coordination": "local", "telemetryIdentity": "anonymous",
    }
    assert cloud.kinds() == ["backend.up", "pitch.extract"]
    cached = json.loads(telemetry.identity_path(settings).read_text(encoding="utf-8"))
    assert cached["token"] == "anon-token" and cached["uri"] == "https://maincloud.spacetimedb.com"


def test_anonymous_identity_uses_configured_database(tmp_path):
    cloud = Maincloud()

    async def run():
        telemetry.configure(_anonymous_settings(tmp_path, spacetime_database="other-db"), httpx.MockTransport(cloud),
                            announce=True)
        await _settle(lambda: cloud.calls)
        await telemetry.aclose()

    asyncio.run(run())
    assert cloud.calls[0][0] == "/v1/database/other-db/call/emit_telemetry"


def test_cached_identity_is_reused_without_minting(tmp_path):
    cloud = Maincloud()
    settings = _anonymous_settings(tmp_path)
    path = telemetry.identity_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"uri": "https://maincloud.spacetimedb.com", "identity": "c2001234", "token": "kept"}),
                    encoding="utf-8")

    async def run():
        telemetry.configure(settings, httpx.MockTransport(cloud), announce=True)
        await _settle(lambda: cloud.calls)
        await telemetry.aclose()

    asyncio.run(run())
    assert cloud.mints == 0
    assert cloud.calls[0][1] == "Bearer kept"


def test_mint_failure_leaves_telemetry_disabled(tmp_path, caplog):
    cloud = Maincloud(identity_status=503)
    settings = _anonymous_settings(tmp_path)

    async def run():
        with caplog.at_level(logging.INFO, logger="app.telemetry"):
            assert telemetry.configure(settings, httpx.MockTransport(cloud), announce=True) is False
            await _settle(lambda: telemetry._startup is None or telemetry._startup.done())
        telemetry.emit("backend", "db", "db.read", "x", {})
        await asyncio.sleep(0.05)
        enabled = telemetry.enabled()
        await telemetry.aclose()
        return enabled

    assert asyncio.run(run()) is False
    assert cloud.mints == 1 and cloud.calls == []
    assert not telemetry.identity_path(settings).exists()
    assert sum("telemetry disabled" in r.getMessage() for r in caplog.records) == 1


def test_disabled_setting_never_mints(tmp_path):
    cloud = Maincloud()

    async def run():
        assert telemetry.configure(make_settings(tmp_path, telemetry_enabled=False), httpx.MockTransport(cloud),
                                   announce=True) is False
        await asyncio.sleep(0.05)

    asyncio.run(run())
    assert cloud.mints == 0 and cloud.calls == []


def test_configured_token_announces_without_minting(tmp_path):
    cloud = Maincloud()
    settings = make_settings(tmp_path, telemetry_enabled=True, spacetime_database="db1", spacetime_token="real",
                             live_coach_provider="anthropic")

    async def run():
        assert telemetry.configure(settings, httpx.MockTransport(cloud), announce=True)
        await _settle(lambda: cloud.calls)
        await telemetry.aclose()

    asyncio.run(run())
    assert cloud.mints == 0
    path, auth, args = cloud.calls[0]
    assert path == "/v1/database/db1/call/emit_telemetry" and auth == "Bearer real"
    payload = json.loads(args[4])
    assert payload["telemetryIdentity"] == "configured" and payload["model"] == settings.live_coach_model


def test_lifespan_announces_through_injected_transport(tmp_path):
    cloud = Maincloud()
    app = create_app(_anonymous_settings(tmp_path))
    app.state.telemetry_transport = httpx.MockTransport(cloud)
    with TestClient(app) as client:
        for _ in range(100):
            if cloud.calls:
                break
            client.get("/health")
    assert "backend.up" in cloud.kinds()


@pytest.mark.parametrize(("query", "table"), [
    # Shapes the backend issues (app/live, app/api, app/reasoning).
    ("SELECT id FROM live_job LIMIT 1", "live_job"),
    ("SELECT attempt_id FROM live_insight LIMIT 1", "live_insight"),
    ("SELECT * FROM live_job WHERE id = 'job-1'", "live_job"),
    ("SELECT * FROM live_job WHERE status = 'running' AND lease_until <= 1700000000 LIMIT 32", "live_job"),
    ("SELECT id FROM live_session WHERE expires_at <= 1700000000 LIMIT 100", "live_session"),
    ("SELECT * FROM learner_attempt WHERE profile_id = 'learner-1'", "learner_attempt"),
    ("SELECT * FROM learner_articulation WHERE profile_id = 'learner-1'", "learner_articulation"),
    ("SELECT * FROM learner_note WHERE profile_id = '__warmup__'", "learner_note"),
    ("SELECT * FROM metric_batch WHERE attempt_id = '0b6f6a52-6a3c-4e8b-9a43-0d7f3f1a2b3c'", "metric_batch"),
    ("SELECT * FROM learner_progress WHERE profile_id = 'learner-1'", "learner_progress"),
    # Robustness: case, newlines, quoting, schema prefix, joins, FROM inside a literal.
    ("select *\n  from\n\tlearner_note\nwhere profile_id = 'x'", "learner_note"),
    ('SELECT * FROM "live_job" WHERE id = \'x\'', "live_job"),
    ("SELECT * FROM `metric_batch`", "metric_batch"),
    ("SELECT * FROM public.learner_attempt", "learner_attempt"),
    ("SELECT a.* FROM learner_attempt a JOIN learner_note n ON a.profile_id = n.profile_id", "learner_attempt"),
    ("SELECT * FROM learner_note WHERE profile_id = 'from evil'", "learner_note"),
    ("SELECT * FROM learner_note WHERE profile_id = 'it''s from x'", "learner_note"),
    ("DELETE nothing", "unknown"),
])
def test_table_of_real_query_shapes(query, table):
    assert table_of(query) == table


def test_sql_read_reports_table_and_row_count(tmp_path):
    def handler(request):
        return httpx.Response(200, json=[{"schema": {"elements": [{"name": {"some": "id"}}]}, "rows": [["a"], ["b"]]}])

    settings = make_settings(tmp_path, spacetime_database="db1", spacetime_token="tok")

    async def run():
        fake = FakeClient()
        telemetry.configure(client=fake)
        rows = await SpacetimeClient(settings, httpx.MockTransport(handler)).sql(
            "SELECT id\nFROM live_session WHERE expires_at <= 5 LIMIT 100")
        await asyncio.sleep(0.05)
        return rows, fake.calls

    rows, calls = asyncio.run(run())
    assert rows == [{"id": "a"}, {"id": "b"}]
    assert calls[0][1][2] == "db.read" and json.loads(calls[0][1][4]) == {"table": "live_session", "rows": 2}
