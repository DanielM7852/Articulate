"""Learner memory end to end: stored word outcomes reach the coach prompt on every provider and survive a restart."""

import json
import uuid

from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import body as vowel_body, decision as vowel_decision
from tests.test_live_word import MISSING_CK, attempt_dict, coach_body, word_decision
from tests.test_openai_coach import FakeOpenAI

GOOD = "Almost there. For the ck, lift the back of the tongue, then release."
KEEPS = "The ck keeps slipping. Back of the tongue up, then release."


def post(client, **kw):
    aid = str(uuid.uuid4())
    body = coach_body(attempt_dict(**{**MISSING_CK, **kw}))
    body["attemptId"] = body["word"]["attemptId"] = aid
    return client.post("/v1/live/coach", json=body)


def openai_client(tmp_path, fake=None):
    """App on the production-default OpenAI provider; no fake means every model call fails (fallback)."""
    app = create_app(make_settings(tmp_path, live_coach_provider="openai", openai_api_key="k"))
    app.state.live_openai_client = fake or FakeOpenAI(exc=RuntimeError("down"))
    return TestClient(app)


def payload(fake):
    content = fake.calls[-1]["messages"][1]["content"]
    return json.loads(content if isinstance(content, str) else content[0]["text"])


def zone_k(payload):
    return next(z for z in payload["learnerModel"]["thisWord"] if z["zoneId"] == "k")


def test_two_clear_misses_make_k_persistent_in_the_prompt(tmp_path):
    c = openai_client(tmp_path)
    for _ in range(2):
        assert post(c).json()["source"] == "fallback"
    fake = FakeOpenAI(word_decision(caption=GOOD))
    c = openai_client(tmp_path, fake)
    assert post(c).json()["source"] == "agent"
    p = payload(fake)
    k = zone_k(p)
    assert k["persistent"] is True and k["missStreak"] == 2 and k["misses"] == 2
    assert len(p["recentAttempts"]) == 2 and all(a["caption"] for a in p["recentAttempts"])
    assert all(a["word"] == "track" for a in p["recentAttempts"])
    assert p["learnerModel"]["otherStruggles"] == []


def test_unclear_earlier_tries_are_not_misses(tmp_path):
    c = openai_client(tmp_path)
    for _ in range(2):
        post(c, quality="unclear", reason="silence")
    fake = FakeOpenAI(word_decision(caption=GOOD))
    post(openai_client(tmp_path, fake))
    k = zone_k(payload(fake))
    assert k["persistent"] is False and k["misses"] == 0 and k["usable"] == 0


def test_memory_survives_a_restart(tmp_path):
    first = openai_client(tmp_path)
    for _ in range(2):
        post(first)
    fake = FakeOpenAI(word_decision(caption=GOOD))
    post(openai_client(tmp_path, fake))  # a brand new app over the same store
    assert zone_k(payload(fake))["persistent"] is True


def test_pattern_claims_need_a_persistent_history(tmp_path):
    fake = FakeOpenAI(word_decision(caption=KEEPS))
    c = openai_client(tmp_path, fake)
    first = post(c).json()
    assert first["source"] == "fallback" and first["caption"] != KEEPS
    post(c)
    c2 = openai_client(tmp_path, FakeOpenAI(word_decision(caption=KEEPS)))
    assert post(c2).json()["source"] == "agent"


def test_history_reference_needs_an_earlier_clear_try(tmp_path):
    fake = FakeOpenAI(word_decision(caption="Like before, the ck needs the back of the tongue up, then release."))
    c = openai_client(tmp_path, fake)
    assert post(c).json()["source"] == "fallback"
    assert post(c).json()["source"] == "agent"


def test_vowel_prompt_carries_the_learner_model(tmp_path):
    fake = FakeOpenAI(vowel_decision())
    c = openai_client(tmp_path, fake)
    for _ in range(3):
        assert c.post("/v1/live/coach", json=vowel_body(aid=str(uuid.uuid4()))).status_code == 200
    p = payload(fake)
    this = p["learnerModel"]["thisSound"]
    assert this["persistent"] is True and this["missStreak"] == 2
    assert "thisWord" not in p["learnerModel"]


def test_unpractised_zones_do_not_count_as_misses(tmp_path):
    c = openai_client(tmp_path)
    for _ in range(2):
        aid = str(uuid.uuid4())
        d = attempt_dict(verdicts={"k": "skipped"})
        d["attemptId"] = aid
        body = coach_body(d)
        body["attemptId"] = aid
        body["practiceZoneIds"] = ["a"]
        assert c.post("/v1/live/coach", json=body).status_code == 200
    fake = FakeOpenAI(word_decision(caption=GOOD))
    post(openai_client(tmp_path, fake))
    zones = payload(fake)["learnerModel"]["thisWord"]
    assert [z["zoneId"] for z in zones] == ["a"] and zones[0]["usable"] == 2


def test_captions_reach_the_model_from_summary_only():
    from app.live.history import compact_attempt

    w = compact_attempt({"attemptId": "a", "word": {"word": "track", "zones": []}, "caption": "Lift it."})
    v = compact_attempt({"attemptId": "b", "sound": "u", "caption": "Round."})
    assert w["caption"] == "Lift it." and v["caption"] == "Round."
    assert compact_attempt({"attemptId": "c", "sound": "u"}, {"caption": "Old"})["caption"] == "Old"


def test_stored_vowel_turns_carry_the_caption(tmp_path):
    fake = FakeOpenAI(vowel_decision())
    c = openai_client(tmp_path, fake)
    for _ in range(3):
        c.post("/v1/live/coach", json=vowel_body(aid=str(uuid.uuid4())))
    p = payload(fake)
    assert p["learnerModel"]["thisSound"]["lastAdvice"] == vowel_decision().caption


def test_recent_attempts_come_from_the_whole_timeline(tmp_path):
    c = openai_client(tmp_path)
    for _ in range(3):
        post(c)
    fake = FakeOpenAI(word_decision(caption=GOOD))
    post(openai_client(tmp_path, fake))
    assert len(payload(fake)["recentAttempts"]) == 3


def test_ordinary_instructions_are_not_history_claims(tmp_path):
    fake = FakeOpenAI(word_decision(caption="Lift the back of the tongue each time for the ck."))
    assert post(openai_client(tmp_path, fake)).json()["source"] == "agent"
    fake = FakeOpenAI(word_decision(caption="Almost. Say track again, and release the ck."))
    assert post(openai_client(tmp_path, fake)).json()["source"] == "agent"


def test_went_missing_again_needs_a_persistent_history(tmp_path):
    line = "In track, the ck went missing again. Back of the tongue up, then release."
    c = openai_client(tmp_path, FakeOpenAI(word_decision(caption=line)))
    assert post(c).json()["source"] == "fallback"
    post(c)
    c2 = openai_client(tmp_path, FakeOpenAI(word_decision(caption=line)))
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


def test_ordinary_coaching_lines_are_not_persistence_claims():
    from app.live.decision import _PERSISTENT_REF

    for line in ("Push most of your air through your lips", "Keeps getting closer, nice!",
                 "Let the ck pop off again at the end"):
        assert not _PERSISTENT_REF.search(line), line
    assert _PERSISTENT_REF.search("the ck went missing again")


def _check_named(caption, focus, persistent):
    from app.live.decision import validate_word_decision, word_evidence_candidates
    from app.live.scoring import score_word
    from tests.test_live_word import attempt

    a = attempt(**MISSING_CK)
    s = score_word(a)
    history = {"thisWord": [{"zoneId": z, "phoneme": z, "persistent": z in persistent, "usable": 2} for z in ("t", "r", "a", "k")
                            if z == "k" or z in persistent]}
    d = word_decision(caption=caption, focusZoneId=focus)
    return validate_word_decision(d, a, s, word_evidence_candidates(a, s), None, history)


def _rejected(*args):
    from app.live.decision import DecisionError

    try:
        _check_named(*args)
    except DecisionError as e:
        assert str(e) == "history_not_grounded" or e.args[0] == "history_not_grounded"
        return True
    return False


def test_history_claim_is_checked_against_the_named_part():
    assert _rejected("In track, the t keeps slipping. Tongue tip up, then release.", "k", {"k"}) is True
    assert _rejected("In track, the t keeps slipping. Tongue tip up.", "k", {"k"}) is True
    assert _rejected("In track, the ck has been hard lately. Back of the tongue up, then release.", "a", {"k"}) is False


def test_named_part_is_the_one_that_must_be_persistent():
    line = "In track, the ck went missing again. Back of the tongue up, then release."
    assert _rejected(line, "k", {"k"}) is False
    assert _rejected(line, "k", set()) is True
    assert _rejected("In track, the t and the ck keeps slipping. Tongue tip up, then release.", "k", {"k"}) is True
    assert _rejected("Nice, the t popped in track. Back of the tongue up, then release.", "k", set()) is False
