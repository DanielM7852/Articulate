"""POST /v1/live/articulation: validation, background job, failure containment."""

import json
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.integrations.articulation import ArticulationClient
from app.live.runtime import get_runtime
from app.main import create_app
from tests.support import make_settings

AID = "0b8b8c1e-5d3a-4c1e-9b7a-2f5d6a1c9e01"
WAV = b"RIFF" + b"\0" * 60
FIXTURE = Path(__file__).parent / "fixtures" / "articulation" / "ee.json"
URL = "/v1/live/articulation"
Q = f"?attemptId={AID}&profileId=kid-1&sound=i"
H = {"Content-Type": "audio/wav"}


class FakeHistory:
    def __init__(self):
        self.recorded = []

    async def record_articulation(self, profile_id, attempt_id, sound, features):
        self.recorded.append((profile_id, attempt_id, sound, features))
        return True


def make(tmp_path, handler=None, url="http://127.0.0.1:8010", **kw):
    app = create_app(make_settings(tmp_path, articulation_url=url, **kw))
    app.state.live_history = FakeHistory()
    if handler is not None:
        app.state.live_articulation = ArticulationClient(app.state.settings, httpx.MockTransport(handler))
    return TestClient(app), app.state.live_history


def ok_handler(request):
    return httpx.Response(200, json=json.loads(FIXTURE.read_text()))


def test_accepted_and_features_stored(tmp_path):
    c, h = make(tmp_path, ok_handler)
    r = c.post(URL + Q + "&captureStartMonotonicMs=5&timeOriginUnixMs=9", content=WAV, headers=H)
    assert r.status_code == 202 and r.json() == {"accepted": True}
    assert len(h.recorded) == 1
    profile, attempt, sound, features = h.recorded[0]
    assert (profile, attempt, sound) == ("kid-1", AID, "i") and features["quality"] == "ok"


def test_disabled_without_url(tmp_path):
    c, h = make(tmp_path, url="", pitch_table_enabled=False)
    r = c.post(URL + Q, content=WAV, headers=H)
    assert r.status_code == 200 and r.json() == {"accepted": False, "reason": "disabled"} and not h.recorded


def test_validation(tmp_path):
    c, h = make(tmp_path, ok_handler)
    assert c.post(URL + Q, content=WAV, headers={"Content-Type": "audio/ogg"}).status_code == 415
    assert c.post(URL + Q, content=WAV).status_code == 415
    assert c.post(URL + Q, content=b"x" * ((1 << 20) + 1), headers=H).status_code == 413
    assert c.post(URL + Q, content=b"x" * 43, headers=H).status_code == 422
    assert c.post(URL + "?attemptId=nope&profileId=kid-1&sound=i", content=WAV, headers=H).status_code == 422
    assert c.post(URL + f"?attemptId={AID}&profileId=bad id&sound=i", content=WAV, headers=H).status_code == 422
    assert c.post(URL + f"?attemptId={AID}&profileId=kid-1&sound=z", content=WAV, headers=H).status_code == 422
    assert not h.recorded


def test_collector_failures_store_nothing(tmp_path):
    def timeout(request):
        raise httpx.ReadTimeout("slow")

    wrong = json.loads(FIXTURE.read_text())
    wrong["schemaVersion"] = "x/2"
    for handler in (lambda r: httpx.Response(500), timeout, lambda r: httpx.Response(200, json=wrong)):
        c, h = make(tmp_path, handler)
        r = c.post(URL + Q, content=WAV, headers=H)
        assert r.status_code == 202 and h.recorded == []


def test_history_failure_does_not_raise(tmp_path):
    c, h = make(tmp_path, ok_handler)

    async def boom(*args):
        raise OSError("disk")

    h.record_articulation = boom
    assert c.post(URL + Q, content=WAV, headers=H).status_code == 202


def test_queue_full_is_busy(tmp_path):
    c, h = make(tmp_path, ok_handler, articulation_max_queue=1)
    runtime = get_runtime(c.app)
    assert runtime.reserve_articulation() and runtime.reserve_articulation()  # one in flight, one waiting
    r = c.post(URL + Q, content=WAV, headers=H)
    assert r.status_code == 200 and r.json() == {"accepted": False, "reason": "busy"}
    assert h.recorded == []
