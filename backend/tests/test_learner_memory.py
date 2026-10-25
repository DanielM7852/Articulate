"""Learner memory end to end: stored word outcomes reach the coach prompt on every provider and survive a restart."""

import json
import uuid

from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import FakeClient, body as vowel_body, decision as vowel_decision
from tests.test_live_word import MISSING_CK, attempt_dict, coach_body, word_decision
from tests.test_openai_coach import FakeOpenAI

GOOD = "Almost there. For the ck, lift the back of the tongue, then release."
KEEPS = "The ck keeps slipping. Back of the tongue up, then release."


def post(client, **kw):
    aid = str(uuid.uuid4())
    body = coach_body(attempt_dict(**{**MISSING_CK, **kw}))
    body["attemptId"] = body["word"]["attemptId"] = aid
    return client.post("/v1/live/coach", json=body)


def anthropic_client(tmp_path, fake=None):
    app = create_app(make_settings(tmp_path))
    if fake is not None:
        app.state.live_client = fake
    return TestClient(app)


def anthropic_payload(fake):
    return json.loads(fake.calls[-1]["messages"][0]["content"])


def zone_k(payload):
    return next(z for z in payload["learnerModel"]["thisWord"] if z["zoneId"] == "k")


def test_two_clear_misses_make_k_persistent_in_the_prompt(tmp_path):
    c = anthropic_client(tmp_path)
    for _ in range(2):
        assert post(c).json()["source"] == "fallback"
    fake = FakeClient(parsed=word_decision(caption=GOOD))
    c = anthropic_client(tmp_path, fake)
    assert post(c).json()["source"] == "agent"
    p = anthropic_payload(fake)
    k = zone_k(p)
    assert k["persistent"] is True and k["missStreak"] == 2 and k["misses"] == 2
    assert len(p["recentAttempts"]) == 2 and all(a["caption"] for a in p["recentAttempts"])
    assert all(a["word"] == "track" for a in p["recentAttempts"])
    assert p["learnerModel"]["otherStruggles"] == []


def test_unclear_earlier_tries_are_not_misses(tmp_path):
    c = anthropic_client(tmp_path)
    for _ in range(2):
        post(c, quality="unclear", reason="silence")
    fake = FakeClient(parsed=word_decision(caption=GOOD))
    post(anthropic_client(tmp_path, fake))
    k = zone_k(anthropic_payload(fake))
    assert k["persistent"] is False and k["misses"] == 0 and k["usable"] == 0


def test_memory_survives_a_restart(tmp_path):
    first = anthropic_client(tmp_path)
    for _ in range(2):
        post(first)
    fake = FakeClient(parsed=word_decision(caption=GOOD))
    post(anthropic_client(tmp_path, fake))  # a brand new app over the same store
    assert zone_k(anthropic_payload(fake))["persistent"] is True


def test_openai_provider_gets_the_same_view(tmp_path):
    def client(fake=None):
        app = create_app(make_settings(tmp_path, live_coach_provider="openai", openai_api_key="k"))
        if fake is not None:
            app.state.live_openai_client = fake
        return TestClient(app)

    first = client(FakeOpenAI(exc=RuntimeError("down")))
    for _ in range(2):
        post(first)
    fake = FakeOpenAI(word_decision(caption=GOOD))
    assert post(client(fake)).json()["source"] == "agent"
    content = fake.calls[-1]["messages"][1]["content"]
    p = json.loads(content if isinstance(content, str) else content[0]["text"])
    assert zone_k(p)["persistent"] is True and len(p["recentAttempts"]) == 2


def test_pattern_claims_need_a_persistent_history(tmp_path):
    fake = FakeClient(parsed=word_decision(caption=KEEPS))
    c = anthropic_client(tmp_path, fake)
    first = post(c).json()
    assert first["source"] == "fallback" and first["caption"] != KEEPS
    post(c)
    c2 = anthropic_client(tmp_path, FakeClient(parsed=word_decision(caption=KEEPS)))
    assert post(c2).json()["source"] == "agent"


def test_history_reference_needs_an_earlier_clear_try(tmp_path):
    fake = FakeClient(parsed=word_decision(caption="Like before, the ck needs the back of the tongue up, then release."))
    c = anthropic_client(tmp_path, fake)
    assert post(c).json()["source"] == "fallback"
    assert post(c).json()["source"] == "agent"


def test_vowel_prompt_carries_the_learner_model(tmp_path):
    fake = FakeClient(vowel_decision())
    app = create_app(make_settings(tmp_path, anthropic_api_key="k"))
    app.state.live_client = fake
    c = TestClient(app)
    for _ in range(3):
        assert c.post("/v1/live/coach", json=vowel_body(aid=str(uuid.uuid4()))).status_code == 200
    p = json.loads(fake.calls[-1]["messages"][0]["content"])
    this = p["learnerModel"]["thisSound"]
    assert this["persistent"] is True and this["missStreak"] == 2
    assert "thisWord" not in p["learnerModel"]


def test_unpractised_zones_do_not_count_as_misses(tmp_path):
    c = anthropic_client(tmp_path)
    for _ in range(2):
        aid = str(uuid.uuid4())
        d = attempt_dict(verdicts={"k": "skipped"})
        d["attemptId"] = aid
        body = coach_body(d)
        body["attemptId"] = aid
        body["practiceZoneIds"] = ["a"]
        assert c.post("/v1/live/coach", json=body).status_code == 200
    fake = FakeClient(parsed=word_decision(caption=GOOD))
    post(anthropic_client(tmp_path, fake))
    zones = anthropic_payload(fake)["learnerModel"]["thisWord"]
    assert [z["zoneId"] for z in zones] == ["a"] and zones[0]["usable"] == 2


def test_captions_reach_the_model_from_summary_only():
    from app.live.history import compact_attempt

    w = compact_attempt({"attemptId": "a", "word": {"word": "track", "zones": []}, "caption": "Lift it."})
    v = compact_attempt({"attemptId": "b", "sound": "u", "caption": "Round."})
    assert w["caption"] == "Lift it." and v["caption"] == "Round."
    assert compact_attempt({"attemptId": "c", "sound": "u"}, {"caption": "Old"})["caption"] == "Old"


def test_stored_vowel_turns_carry_the_caption(tmp_path):
    fake = FakeClient(vowel_decision())
    app = create_app(make_settings(tmp_path, anthropic_api_key="k"))
    app.state.live_client = fake
    c = TestClient(app)
    for _ in range(3):
        c.post("/v1/live/coach", json=vowel_body(aid=str(uuid.uuid4())))
    p = json.loads(fake.calls[-1]["messages"][0]["content"])
    assert p["learnerModel"]["thisSound"]["lastAdvice"] == vowel_decision().caption


def test_recent_attempts_come_from_the_whole_timeline(tmp_path):
    c = anthropic_client(tmp_path)
    for _ in range(3):
        post(c)
    fake = FakeClient(parsed=word_decision(caption=GOOD))
    post(anthropic_client(tmp_path, fake))
    assert len(anthropic_payload(fake)["recentAttempts"]) == 3


def test_ordinary_instructions_are_not_history_claims(tmp_path):
    fake = FakeClient(parsed=word_decision(caption="Lift the back of the tongue each time for the ck."))
    assert post(anthropic_client(tmp_path, fake)).json()["source"] == "agent"
    fake = FakeClient(parsed=word_decision(caption="Almost. Say track again, and release the ck."))
    assert post(anthropic_client(tmp_path, fake)).json()["source"] == "agent"


def test_went_missing_again_needs_a_persistent_history(tmp_path):
    line = "The ck went missing again. Back of the tongue up, then release."
    c = anthropic_client(tmp_path, FakeClient(parsed=word_decision(caption=line)))
    assert post(c).json()["source"] == "fallback"
    post(c)
    c2 = anthropic_client(tmp_path, FakeClient(parsed=word_decision(caption=line)))
    assert post(c2).json()["source"] == "agent"


def test_insight_lookup_finds_word_attempts():
    import asyncio

    from app.api.live_routes import _find_attempt
    from app.live.history import LearnerContext

    class H:
        async def load(self, profile_id, limit):
            return LearnerContext(word_attempts=[{"kind": "word", "attemptId": "w1"}])

    items, match = asyncio.run(_find_attempt(H(), "p", "w1", 5))
    assert match is not None and match["attemptId"] == "w1"
