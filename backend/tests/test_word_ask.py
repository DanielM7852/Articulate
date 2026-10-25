"""POST /v1/live/word/ask: Claude-reasoned answer to a learner question, validated, with a deterministic fallback."""

import pytest
from fastapi.testclient import TestClient

from app.live.identity import COOKIE
from app.live.schemas import WordAskDraft
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import FakeClient

PROFILE = "learner-1"


def make(tmp_path, client=None, **settings) -> TestClient:
    app = create_app(make_settings(tmp_path, **settings))
    if client is not None:
        app.state.live_client = client
    return TestClient(app)


def body(**kw):
    data = {"profileId": PROFILE, "word": "track", "question": "How do I say the ck at the end?"}
    data.update(kw)
    return data


def draft(say):
    return WordAskDraft(say=say)


def test_valid_model_answer_is_used(tmp_path):
    fake = FakeClient(draft("Lift the back of the tongue, then let go at the end."))
    c = make(tmp_path, fake, anthropic_api_key="k")
    r = c.post("/v1/live/word/ask", json=body(lastCoaching={"caption": "Try the ck again.", "focusZoneId": "k"},
                                              lastAttempt={"verdict": "partial", "hitCount": 3, "zoneCount": 4, "weakestZoneId": "k"},
                                              tries=2))
    assert r.status_code == 200
    assert r.json() == {"say": "Lift the back of the tongue, then let go at the end.", "source": "model"}
    call = fake.calls[0]
    assert call["model"] == "claude-sonnet-5-5" and call["output_config"] == {"effort": "medium"}
    assert call["output_format"] is WordAskDraft
    assert "How do I say the ck" in call["messages"][0]["content"]


@pytest.mark.parametrize("say", [
    "Your tongue stayed too low on that one.",
    "Your lips were closed during the vowel.",
    "Try it 3 times in a row.",
    "That was wrong, try again.",
    "Listen to how the ck ends.",
    "Say the word slowly. Then say it faster. Then hold the vowel. Then stop.",
    "x" * 201,
])
def test_unsafe_model_answers_fall_back(tmp_path, say):
    c = make(tmp_path, FakeClient(draft(say)), anthropic_api_key="k")
    r = c.post("/v1/live/word/ask", json=body())
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "fallback" and j["say"] == "Watch the board as you say the word, then try it again when you are ready."


def test_fallback_uses_last_coaching_caption(tmp_path):
    c = make(tmp_path, FakeClient(draft("Your tongue stayed low.")), anthropic_api_key="k")
    r = c.post("/v1/live/word/ask", json=body(lastCoaching={"caption": "Curl the tongue tip back for the r.", "focusZoneId": "r"}))
    assert r.json() == {"say": "Curl the tongue tip back for the r.", "source": "fallback"}


def test_model_error_and_timeout_fall_back(tmp_path):
    for exc in (RuntimeError("boom"), TimeoutError()):
        c = make(tmp_path, FakeClient(exc=exc), anthropic_api_key="k")
        r = c.post("/v1/live/word/ask", json=body())
        assert r.status_code == 200 and r.json()["source"] == "fallback"


def test_no_model_configured_falls_back(tmp_path):
    r = make(tmp_path).post("/v1/live/word/ask", json=body())
    assert r.status_code == 200 and r.json()["source"] == "fallback"


def test_bad_input_is_422(tmp_path):
    c = make(tmp_path, FakeClient(draft("Fine.")), anthropic_api_key="k")
    assert c.post("/v1/live/word/ask", json=body(question="")).status_code == 422
    assert c.post("/v1/live/word/ask", json=body(question="q" * 501)).status_code == 422
    assert c.post("/v1/live/word/ask", json=body(word="w" * 33)).status_code == 422
    assert c.post("/v1/live/word/ask", json=body(profileId="bad id!")).status_code == 422


def test_unauthorized_profile_behaves_like_coach(tmp_path):
    fake = FakeClient(draft("Fine."))
    c = make(tmp_path, fake, anthropic_api_key="k", live_coordination="spacetime",
             live_identity_secret="test-secret-" * 4, live_cookie_secure=False,
             spacetime_database="test", spacetime_token="backend-token")
    assert c.post("/v1/live/word/ask", json=body()).status_code == 401
    c.cookies.set(COOKIE, PROFILE + ".9999999999." + "a" * 64)
    assert c.post("/v1/live/word/ask", json=body()).status_code == 401
    assert fake.calls == []
    c.cookies.clear()
    mine = c.get("/v1/live/identity").json()["profileId"]
    assert c.post("/v1/live/word/ask", json=body(profileId=mine)).status_code == 200
    assert c.post("/v1/live/word/ask", json=body(profileId="someone-else")).status_code == 403
