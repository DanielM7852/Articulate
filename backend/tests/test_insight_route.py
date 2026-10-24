"""Insight job, status route and the analysis_ready session event."""

import json
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.integrations.articulation import ArticulationClient
from app.live.articulation import extract_features
from app.live.history import LearnerContext
from app.live.runtime import get_runtime
from app.main import create_app
from tests.support import make_settings

AID = "0b8b8c1e-5d3a-4c1e-9b7a-2f5d6a1c9e01"
OLD = "0b8b8c1e-5d3a-4c1e-9b7a-2f5d6a1c9e02"
OTHER = "0b8b8c1e-5d3a-4c1e-9b7a-2f5d6a1c9e03"
WAV = b"RIFF" + b"\0" * 60
FIXTURE = Path(__file__).parent / "fixtures" / "articulation" / "ee.json"
URL = "/v1/live/articulation"
Q = f"?attemptId={AID}&profileId=kid-1&sound=i"
H = {"Content-Type": "audio/wav"}
FEATURES = extract_features(json.loads(FIXTURE.read_text()))


class FakeHistory:
    def __init__(self, attempts, persist=True):
        self.attempts, self.persist, self.recorded = attempts, persist, []

    async def record_articulation(self, profile_id, attempt_id, sound, features):
        self.recorded.append(attempt_id)
        return self.persist

    async def load(self, profile_id, limit):
        return LearnerContext(attempts=list(self.attempts))


def attempts(with_anchor=True, delta=1.0):
    cur = {"attemptId": AID, "sound": "i", "audioVerdict": "off", "f1Offset": 0.3, "f2Offset": 0.0}
    items = [cur]
    if with_anchor:
        anchor = {"attemptId": OLD, "sound": "i", "audioVerdict": "on_target", "f1Offset": 0.0, "f2Offset": 0.0,
                  "artic": {**FEATURES, "tongueHeight": FEATURES["tongueHeight"] + delta,
                            "tongueFront": FEATURES["tongueFront"]}}
        items.append(anchor)
    return items


def make(tmp_path, history, **kw):
    app = create_app(make_settings(tmp_path, articulation_url="http://127.0.0.1:8010", **kw))
    app.state.live_history = history
    app.state.live_articulation = ArticulationClient(
        app.state.settings, httpx.MockTransport(lambda r: httpx.Response(200, json=json.loads(FIXTURE.read_text())))
    )
    return TestClient(app)


def post(c, q=Q):
    r = c.post(URL + q, content=WAV, headers=H)
    assert r.status_code == 202
    return r


def status(c, attempt=AID, profile="kid-1"):
    return c.get(f"{URL}/{attempt}?profileId={profile}")


def test_ready_line_with_gated_claim(tmp_path):
    c = make(tmp_path, FakeHistory(attempts()))
    post(c)
    r = status(c)
    assert r.json() == {"status": "ready", "sound": "i"}
    entry = get_runtime(c.app).get_insight(AID, "kid-1")
    assert "tongue" in entry["say"] and entry["source"] == "fallback"
    assert "tongue" not in r.text and "say" not in r.json()


def test_no_claim_is_none(tmp_path):
    c = make(tmp_path, FakeHistory(attempts(with_anchor=False)))
    post(c)
    assert status(c).json() == {"status": "none", "sound": "i"}
    c2 = make(tmp_path, FakeHistory(attempts(delta=0.0)))
    post(c2)
    assert status(c2).json()["status"] == "none"


def test_persistence_failure_still_ready_in_memory(tmp_path):
    h = FakeHistory(attempts(), persist=False)
    c = make(tmp_path, h)
    post(c)
    assert h.recorded == [AID] and status(c).json()["status"] == "ready"


def test_missing_attempt_retries_then_none(tmp_path, monkeypatch):
    import app.api.live_routes as routes

    delays = []

    async def fake_sleep(s):
        delays.append(s)

    monkeypatch.setattr(routes.asyncio, "sleep", fake_sleep)
    c = make(tmp_path, FakeHistory([]))
    post(c)
    assert delays == [routes.INSIGHT_RETRY_DELAY_S] and status(c).json()["status"] == "none"


def test_job_never_raises_and_ends_none(tmp_path):
    class Boom(FakeHistory):
        async def load(self, profile_id, limit):
            raise RuntimeError("db")

    c = make(tmp_path, Boom([]))
    post(c)
    assert status(c).json()["status"] == "none"


def test_collector_failure_is_none(tmp_path):
    c = make(tmp_path, FakeHistory(attempts()))
    c.app.state.live_articulation = ArticulationClient(c.app.state.settings, httpx.MockTransport(lambda r: httpx.Response(500)))
    post(c)
    assert status(c).json()["status"] == "none"


def test_status_route_unknown_pending_mismatch_and_validation(tmp_path):
    c = make(tmp_path, FakeHistory([]))
    rt = get_runtime(c.app)
    assert status(c).json() == {"status": "unknown", "sound": None}
    rt.set_insight(AID, "kid-1", "u", "pending")
    assert status(c).json() == {"status": "pending", "sound": "u"}
    assert status(c, profile="kid-2").json() == {"status": "unknown", "sound": None}
    rt.set_insight(AID, "kid-1", "u", "delivered", "x")
    assert status(c).json()["status"] == "delivered"
    assert status(c, attempt="nope").status_code == 422
    assert status(c, profile="bad id").status_code == 422


def test_registry_ttl_and_cap(tmp_path):
    c = make(tmp_path, FakeHistory([]), insight_ttl_s=10)
    rt = get_runtime(c.app)
    now = [0.0]
    rt.clock = lambda: now[0]
    rt.set_insight(AID, "kid-1", "i", "ready", "s")
    now[0] = 11
    assert rt.get_insight(AID, "kid-1") is None
    for n in range(502):
        now[0] += 0.001
        rt.set_insight(f"a{n}", "kid-1", "i", "none")
    assert len(rt._insights) == 500 and rt.get_insight("a0") is None and rt.get_insight("a501") is not None


# ---- analysis_ready ----


def start(c, sounds=("i", "u")):
    r = c.post("/v1/live/session/start", json={"profileId": "kid-1", "displayName": "Maya", "sounds": list(sounds)})
    return r.json()["sessionId"]


def ready(c, sid, sound="i", attempt=AID, profile="kid-1"):
    r = c.post("/v1/live/session/turn", json={
        "sessionId": sid, "profileId": profile,
        "event": {"kind": "analysis_ready", "attemptId": attempt, "currentSound": sound}})
    assert r.status_code == 200, r.text
    return r.json()


def test_analysis_ready_delivers_once(tmp_path):
    c = make(tmp_path, FakeHistory([]))
    rt = get_runtime(c.app)
    sid = start(c)
    rt.set_insight(AID, "kid-1", "i", "ready", "Compared with your best ee tries, your tongue sat a little below.", "agent")
    t = ready(c, sid)
    assert t["say"].startswith("Compared with your best ee tries") and t["action"] == "prompt_attempt"
    assert t["source"] == "agent" and t["sound"] == "i" and t["showSideView"] is False
    assert rt.get_insight(AID)["status"] == "delivered"
    again = ready(c, sid)
    assert "tongue" not in again["say"] and again["source"] == "scripted" and "keep going" in again["say"]


def test_analysis_ready_scripted_when_not_deliverable(tmp_path):
    c = make(tmp_path, FakeHistory([]))
    rt = get_runtime(c.app)
    sid = start(c)
    rt.set_insight(AID, "kid-1", "u", "ready", "Compared with your best oo tries, your tongue sat a little below.", "agent")
    assert "tongue" not in ready(c, sid, sound="i")["say"]  # sound mismatch
    rt.set_insight(OLD, "kid-2", "i", "ready", "tongue best tries lifting higher", "agent")
    assert "tongue" not in ready(c, sid, attempt=OLD)["say"]  # other profile
    assert "tongue" not in ready(c, sid, attempt=OTHER)["say"]  # unknown
    rt.set_insight(OTHER, "kid-1", "i", "pending")
    assert "tongue" not in ready(c, sid, attempt=OTHER)["say"]  # not ready yet
    assert rt.get_insight(AID)["status"] == "ready"
