"""Stored articulation features join learner history; client + SpacetimeHistory behaviour."""

import asyncio
import json

import httpx

from app.integrations.articulation import ArticulationClient
from app.integrations.spacetime import SpacetimeClient
from app.live.history import LocalHistory, SpacetimeHistory
from tests.support import make_settings

P = "kid-1"
SCHEMA = "articulate.articulation/1"


def summary(aid, verdict, f1=0.0, f2=0.0, sound="i"):
    return {"attemptId": aid, "sound": sound, "audio": {"verdict": verdict, "f1Offset": f1, "f2Offset": f2}}


def feats(**kw):
    return {"quality": "ok", "reason": None, "tongueHeight": 0.0, "tongueFront": 0.0, **kw}


def test_local_record_and_attach_only_to_matching(tmp_path):
    h = LocalHistory(make_settings(tmp_path))

    async def go():
        await h.record(P, "a1", summary("a1", "on_target"), {})
        await h.record(P, "a2", summary("a2", "close", 0.2), {})
        await h.record_articulation(P, "a1", "i", feats())
        assert await h.record_articulation(P, "a2", "i", feats(tongueHeight=-0.6))
        return await h.load(P, 5)

    ctx = asyncio.run(go())
    by = {a["attemptId"]: a for a in ctx.attempts}
    assert by["a1"]["articulation"]["claims"] == [] and "artic" not in by["a1"]
    assert by["a2"]["articulation"]["quality"] == "ok"
    assert [c["direction"] for c in by["a2"]["articulation"]["claims"]] == ["lower"]
    assert "artic" not in by["a2"]


def test_local_no_features_unchanged(tmp_path):
    h = LocalHistory(make_settings(tmp_path))

    async def go():
        await h.record(P, "a1", summary("a1", "off"), {})
        return await h.load(P, 5)

    ctx = asyncio.run(go())
    assert set(ctx.attempts[0]) == {
        "attemptId", "sound", "audioVerdict", "f1Offset", "f2Offset", "inTargetFraction",
        "videoVerdict", "cueId", "nextAction", "caption", "focusZoneId", "wordVerdict",
    }


def test_local_anchor_beyond_limit_used_but_trimmed(tmp_path):
    h = LocalHistory(make_settings(tmp_path))

    async def go():
        await h.record(P, "a1", summary("a1", "on_target"), {})
        await h.record_articulation(P, "a1", "i", feats())
        await h.record(P, "a2", summary("a2", "close", 0.2), {})
        await h.record_articulation(P, "a2", "i", feats(tongueHeight=-0.6))
        return await h.load(P, 1)

    ctx = asyncio.run(go())
    assert len(ctx.attempts) == 1 and ctx.attempts[0]["attemptId"] == "a2"
    assert ctx.attempts[0]["articulation"]["claims"]


def test_local_concurrent_writes_all_persist(tmp_path):
    h = LocalHistory(make_settings(tmp_path))

    async def go():
        await asyncio.gather(
            h.record(P, "a1", summary("a1", "off"), {}),
            h.record_articulation(P, "a1", "i", feats()),
            h.save_notes(P, {"summary": "n"}),
        )
        return await h.load(P, 5)

    ctx = asyncio.run(go())
    assert ctx.attempts[0]["articulation"]["quality"] == "ok" and ctx.notes == {"summary": "n"}


def sql_result(cols, rows):
    return [{"schema": {"elements": [{"name": {"some": c}} for c in cols]}, "rows": rows}]


def stdb(fail_artic=False):
    calls = []

    def handler(request):
        path = request.url.path
        if path.endswith("/sql"):
            q = request.content.decode()
            if "learner_articulation" in q:
                if fail_artic:
                    return httpx.Response(404, text="no such table")
                rows = [["a2", P, json.dumps(feats(tongueHeight=-0.6)), 2], ["a1", P, json.dumps(feats()), 1]]
                return httpx.Response(200, json=sql_result(["attempt_id", "profile_id", "features", "created_at"], rows))
            if "learner_attempt" in q:
                cols = ["attempt_id", "sound", "status", "started_at", "summary"]
                rows = [
                    ["a2", "i", "coached", 2, json.dumps(summary("a2", "close", 0.2))],
                    ["a1", "i", "coached", 1, json.dumps(summary("a1", "on_target"))],
                ]
                return httpx.Response(200, json=sql_result(cols, rows))
            return httpx.Response(200, json=[])
        calls.append((path.rsplit("/", 1)[1], json.loads(request.content)))
        return httpx.Response(200, text="")

    return httpx.MockTransport(handler), calls


def st_history(tmp_path, transport):
    s = make_settings(tmp_path, spacetime_database="db", spacetime_token="t", spacetime_uri="https://stdb.test")
    return SpacetimeHistory(SpacetimeClient(s, transport, None))


def test_spacetime_record_and_load(tmp_path):
    transport, calls = stdb()
    h = st_history(tmp_path, transport)

    async def go():
        ok = await h.record_articulation(P, "a2", "i", feats())
        return ok, await h.load(P, 5)

    ok, ctx = asyncio.run(go())
    assert ok and calls[0][0] == "record_articulation" and calls[0][1][:2] == ["a2", P]
    assert json.loads(calls[0][1][2])["quality"] == "ok"
    by = {a["attemptId"]: a for a in ctx.attempts}
    assert by["a1"]["articulation"]["claims"] == []
    assert [c["direction"] for c in by["a2"]["articulation"]["claims"]] == ["lower"]


def test_spacetime_articulation_query_failure_keeps_load(tmp_path):
    transport, _ = stdb(fail_artic=True)
    ctx = asyncio.run(st_history(tmp_path, transport).load(P, 5))
    assert [a["attemptId"] for a in ctx.attempts] == ["a2", "a1"]
    assert all("articulation" not in a for a in ctx.attempts)


def client(tmp_path, handler):
    s = make_settings(tmp_path, articulation_url="http://127.0.0.1:8010")
    return ArticulationClient(s, httpx.MockTransport(handler))


KW = dict(attempt_id="x", capture_start_monotonic_ms=None, time_origin_unix_ms=None)


def test_client_clock_params_only_when_both(tmp_path):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        assert request.headers["content-type"] == "audio/wav"
        return httpx.Response(200, json={"schemaVersion": SCHEMA})

    c = client(tmp_path, handler)
    asyncio.run(c.analyze(b"w", attempt_id="x", capture_start_monotonic_ms=1.0, time_origin_unix_ms=None))
    asyncio.run(c.analyze(b"w", attempt_id="x", capture_start_monotonic_ms=1.0, time_origin_unix_ms=2.0))
    assert "capture_start_monotonic_ms" not in seen[0] and "time_origin_unix_ms" not in seen[0]
    assert seen[0]["attempt_id"] == "x" and seen[0]["models"] == "sparc,silero_vad"
    assert seen[1]["capture_start_monotonic_ms"] == "1.0" and seen[1]["time_origin_unix_ms"] == "2.0"


def test_client_503_retried_once(tmp_path, monkeypatch):
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr("app.integrations.articulation.asyncio.sleep", fake_sleep)
    n = {"c": 0}

    def busy_then_ok(request):
        n["c"] += 1
        if n["c"] == 1:
            return httpx.Response(503, headers={"Retry-After": "60"})
        return httpx.Response(200, json={"schemaVersion": SCHEMA})

    assert asyncio.run(client(tmp_path, busy_then_ok).analyze(b"w", **KW)) == {"schemaVersion": SCHEMA}
    assert n["c"] == 2 and sleeps == [5.0]
    n["c"] = 0

    def always(request):
        n["c"] += 1
        return httpx.Response(503)

    assert asyncio.run(client(tmp_path, always).analyze(b"w", **KW)) is None and n["c"] == 2


def test_client_failures_return_none(tmp_path):
    def timeout(request):
        raise httpx.ReadTimeout("slow")

    for handler in (
        timeout,
        lambda r: httpx.Response(500),
        lambda r: httpx.Response(200, text="nope"),
        lambda r: httpx.Response(200, json={"schemaVersion": "x/2"}),
    ):
        assert asyncio.run(client(tmp_path, handler).analyze(b"w", **KW)) is None
