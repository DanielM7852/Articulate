"""Shared long-lived clients, background warm-up and per-stage timings. No network."""

import httpx
from fastapi.testclient import TestClient

from app.live import llm
from app.live.runtime import get_runtime
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import SPACE, FakeClient, FakeSpacetime, body, decision

TIMING_KEYS = {"frames", "history", "scoring", "llm", "validate", "total"}


def test_clients_created_once_and_reused_across_requests(tmp_path, monkeypatch):
    built = []
    fake = FakeClient(decision())

    def build(settings, timeout_s):
        built.append(timeout_s)
        return fake

    monkeypatch.setattr(llm, "build_client", build)
    st = FakeSpacetime()
    app = create_app(make_settings(tmp_path, anthropic_api_key="k", **SPACE))
    app.state.live_spacetime_transport = httpx.MockTransport(st)
    with TestClient(app) as c:
        for _ in range(2):
            r = c.post("/v1/live/coach", json=body(source="spacetimedb", frames=False))
            assert r.status_code == 200 and r.json()["source"] == "agent"
        runtime = get_runtime(app)
        assert len(built) == 1 and runtime.anthropic_created == 1
        assert runtime.http_created == 1
        http = runtime._http
        c.post("/v1/live/coach", json=body(source="spacetimedb", frames=False))
        assert runtime._http is http and runtime.http_created == 1
    assert http.is_closed
    assert len(fake.calls) == 3


def test_warmup_failures_do_not_break_startup_or_requests(tmp_path, monkeypatch):
    class BrokenModels:
        def retrieve(self, *_a, **_k):
            raise RuntimeError("models down")

    broken = FakeClient(decision())
    broken.models = BrokenModels()
    monkeypatch.setattr(llm, "build_client", lambda settings, timeout_s: broken)

    def boom(request):
        raise httpx.ConnectError("down")

    app = create_app(make_settings(tmp_path, anthropic_api_key="k", **SPACE))
    app.state.live_spacetime_transport = httpx.MockTransport(boom)
    with TestClient(app) as c:  # lifespan runs, warm-up fails in the background
        assert c.get("/health").status_code in (200, 404)
        r = c.post("/v1/live/coach", json=body())
        assert r.status_code == 200 and r.json()["source"] == "agent"


def test_warmup_succeeds_and_calls_models_api(tmp_path, monkeypatch):
    class Models:
        calls = []

        def retrieve(self, model):
            Models.calls.append(model)

    ok = FakeClient(decision())
    ok.models = Models()
    monkeypatch.setattr(llm, "build_client", lambda settings, timeout_s: ok)
    st = FakeSpacetime()
    app = create_app(make_settings(tmp_path, anthropic_api_key="k", **SPACE))
    app.state.live_spacetime_transport = httpx.MockTransport(st)
    with TestClient(app):
        import time

        deadline = time.time() + 3
        while time.time() < deadline and not (Models.calls and st.sql):
            time.sleep(0.02)
    assert Models.calls == ["claude-sonnet-5-5"]
    assert any("learner_note" in q for q in st.sql)


def test_timings_returned_with_all_stage_keys(tmp_path):
    c = TestClient(create_app(make_settings(tmp_path, anthropic_api_key="k")))
    c.app.state.live_client = FakeClient(decision())
    j = c.post("/v1/live/coach", json=body()).json()
    assert set(j["timingsMs"]) == TIMING_KEYS
    assert all(isinstance(v, int) and v >= 0 for v in j["timingsMs"].values())
    assert j["timingsMs"]["total"] >= j["timingsMs"]["llm"]


def test_ended_attempt_is_not_polled(tmp_path):
    st = FakeSpacetime(status="ended")
    c = TestClient(create_app(make_settings(tmp_path, **SPACE)))
    c.app.state.live_spacetime_transport = httpx.MockTransport(st)
    c.post("/v1/live/coach", json=body(source="spacetimedb", frames=False))
    assert sum("FROM learner_attempt WHERE attempt_id" in q for q in st.sql) == 1
    assert sum("FROM metric_batch" in q for q in st.sql) == 1
