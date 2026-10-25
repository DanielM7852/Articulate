import asyncio
import json

import httpx
import pytest

from app import telemetry
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

    settings = make_settings(tmp_path, spacetime_database="db1", spacetime_token="tok")

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
