"""Ghost-path words: four word specs, advisory zones, practiceZoneIds focus, ghost evidence keys, word ask."""

import pytest

from app.live.decision import (
    DecisionError,
    validate_word_decision,
    word_evidence_candidates,
    word_fallback_decision,
)
from app.live.schemas import CoachDecision, WordAttempt
from app.live.scoring import score_word
from app.live.words import WORDS, ZONE_CUE, word_info
from tests.test_live_api import AID, FakeClient
from tests.test_live_word import client_for, coach_body
from tests.test_word_ask import body as ask_body
from tests.test_word_ask import draft, make

SPECS = {
    "track": [("t", "t", "t", "stop"), ("r", "r", "r", "liquid"), ("a", "ae", "a", "vowel"), ("k", "k", "ck", "stop")],
    "sheep": [("sh", "sh", "sh", "fricative"), ("ee", "iy", "ee", "vowel"), ("p", "p", "p", "stop")],
    "rent": [("r", "r", "r", "liquid"), ("e", "eh", "e", "vowel"), ("n", "n", "n", "nasal"), ("t", "t", "t", "stop")],
    "brain": [("b", "b", "b", "stop"), ("r", "r", "r", "liquid"), ("ai", "ey", "ai", "vowel"), ("n", "n", "n", "nasal")],
}
GHOST = {"pathDistance": 0.8, "closeFraction": 0.75}


def zres(word, zid, verdict="hit", kind=None, **evidence):
    spec = next(s for s in SPECS[word] if s[0] == zid)
    skipped_kind = spec[3] in ("fricative", "nasal")
    return {
        "zoneId": zid,
        "phoneme": spec[1],
        "kind": kind or spec[3],
        "verdict": "skipped" if skipped_kind else verdict,
        "dwellMs": 200,
        "evidence": {} if skipped_kind else evidence,
    }


def make_attempt(word, verdicts=None, practice=None, **kw):
    verdicts = verdicts or {}
    zones = []
    for zid, _, _, kind in SPECS[word]:
        ev = dict(GHOST) if kind in ("vowel", "liquid") else {}
        zones.append(zres(word, zid, verdicts.get(zid, "hit"), **ev))
    d = {"word": word, "attemptId": AID, "durationMs": 1400, "zones": zones, "quality": "usable"}
    if practice is not None:
        d["practiceZoneIds"] = practice
    d.update(kw)
    return d


def decision(**kw):
    d = dict(
        observation="The board marked the part as missed.",
        caption="The ee in sheep needs a retry. Tongue high and forward, held steady.",
        cueId=None,
        nextAction="retry",
        evidenceFields=["word.verdict"],
        focusZoneId="ee",
    )
    d.update(kw)
    return CoachDecision(**d)


def check(dec, word, verdicts=None, practice=None):
    a = WordAttempt.model_validate(make_attempt(word, verdicts))
    s = score_word(a, practice)
    return validate_word_decision(dec, a, s, word_evidence_candidates(a, s), practice)


@pytest.mark.parametrize("word", list(SPECS))
def test_word_specs_load(word):
    info = word_info(word)
    assert info is not None and word in WORDS
    assert [(z.id, z.phoneme, z.label, z.kind) for z in info.zones] == SPECS[word]
    for z in info.zones:
        assert z.hint and z.hint_no_camera
        assert "lip" not in z.hint_no_camera.lower() and "jaw" not in z.hint_no_camera.lower()


def test_cues_only_for_vowels_with_a_lip_cue():
    assert ZONE_CUE == {"a": "open-jaw", "ee": "spread-lips"}
    consonants = {z.id for w in WORDS.values() for z in w.zones if z.kind != "vowel"}
    assert not consonants & set(ZONE_CUE)


def test_new_kinds_and_ghost_evidence_validate():
    a = WordAttempt.model_validate(make_attempt("sheep"))
    assert [z.kind for z in a.zones] == ["fricative", "vowel", "stop"]
    assert a.zones[0].verdict == "skipped" and a.zones[0].evidence == {}
    assert a.zones[1].evidence == GHOST
    cand = word_evidence_candidates(a, score_word(a))
    assert cand["word.ee.pathDistance"] == 0.8 and cand["word.ee.closeFraction"] == 0.75


def test_legacy_tuner_r_still_accepted_and_counts():
    d = make_attempt("track")
    d["zones"][1]["kind"] = "tuner"
    d["zones"][1]["verdict"] = "miss"
    s = score_word(WordAttempt.model_validate(d))
    assert (s.verdict, s.weakestZoneId, s.zoneCount) == ("off", "r", 4)


def test_advisory_zones_do_not_count():
    # A missed liquid and a skipped fricative/nasal never change the verdict.
    a = WordAttempt.model_validate(make_attempt("rent", {"r": "miss"}))
    s = score_word(a)
    assert (s.verdict, s.zoneCount, s.hitCount, s.weakestZoneId) == ("on_target", 2, 2, None)
    a = WordAttempt.model_validate(make_attempt("sheep"))
    s = score_word(a)
    assert (s.verdict, s.zoneCount, s.hitCount) == ("on_target", 2, 2)
    a = WordAttempt.model_validate(make_attempt("sheep", {"p": "miss"}))
    assert score_word(a).weakestZoneId == "p"


def test_advisory_flag_marks_any_kind():
    d = make_attempt("track")
    d["zones"][2]["advisory"] = True
    d["zones"][2]["verdict"] = "miss"
    s = score_word(WordAttempt.model_validate(d))
    assert s.zoneCount == 2 and s.verdict == "on_target"


def test_practice_ids_restrict_the_verdict():
    a = WordAttempt.model_validate(make_attempt("brain", {"b": "miss", "ai": "partial"}))
    assert score_word(a).weakestZoneId == "b"
    s = score_word(a, ["ai"])
    assert (s.verdict, s.zoneCount, s.weakestZoneId) == ("close", 1, "ai")
    s = score_word(a, ["r", "n"])  # only advisory parts: cue-only
    assert (s.zoneCount, s.hitCount, s.weakestZoneId) == (0, 0, "r")


def test_focus_must_come_from_practice_list():
    verdicts = {"p": "miss", "ee": "partial"}
    check(decision(focusZoneId="ee"), "sheep", verdicts, ["ee"])
    with pytest.raises(DecisionError, match="focus_zone_unknown"):
        check(decision(focusZoneId="p", caption="The p at the end needs a retry."), "sheep", verdicts, ["ee"])
    check(decision(focusZoneId="p", caption="The p at the end needs a retry."), "sheep", verdicts, None)


def test_advisory_focus_cannot_be_judged():
    dec = decision(focusZoneId="sh", caption="The sh at the start was right. Push a soft stream of air.")
    with pytest.raises(DecisionError, match="judged_advisory_zone"):
        check(dec, "sheep")
    check(decision(focusZoneId="sh", observation="The sh is a cue-only part.", caption="Let us work on the sh. Push a long, soft stream of air."), "sheep")


def test_fallback_respects_practice_and_passes_validator():
    verdicts = {"p": "miss", "ee": "partial"}
    a = WordAttempt.model_validate(make_attempt("sheep", verdicts))
    for practice in (None, ["ee"], ["sh"], ["sh", "ee"]):
        s = score_word(a, practice)
        cand = word_evidence_candidates(a, s)
        dec, ev = word_fallback_decision(a, s, cand, practice)
        assert validate_word_decision(dec, a, s, cand, practice) == ev
        if practice == ["ee"]:
            assert dec.focusZoneId == "ee"
        if practice == ["sh"]:
            assert dec.focusZoneId == "sh" and "work on the sh" in dec.caption and "went missing" not in dec.caption


def test_route_practice_ids_scope_verdict_and_fallback(tmp_path):
    body = coach_body(make_attempt("brain", {"b": "miss", "ai": "partial"}))
    body["practiceZoneIds"] = ["ai"]
    data = client_for(tmp_path).post("/v1/live/coach", json=body).json()
    assert data["word"]["verdict"] == "close" and data["word"]["zoneCount"] == 1
    assert data["focusZoneId"] == "ai"


def test_route_model_focus_outside_list_falls_back(tmp_path):
    body = coach_body(make_attempt("sheep", {"p": "miss", "ee": "partial"}))
    body["practiceZoneIds"] = ["ee"]
    fake = FakeClient(parsed=decision(focusZoneId="p", caption="The p at the end needs a retry."))
    data = client_for(tmp_path, fake).post("/v1/live/coach", json=body).json()
    assert data["source"] == "fallback" and data["focusZoneId"] == "ee"
    assert '"practiceZoneIds":["ee"]' in fake.calls[0]["messages"][0]["content"]


def test_route_accepts_practice_ids_inside_word(tmp_path):
    body = coach_body(make_attempt("sheep", {"p": "miss", "ee": "partial"}, practice=["ee"]))
    data = client_for(tmp_path).post("/v1/live/coach", json=body).json()
    assert data["focusZoneId"] == "ee"


def test_coach_prompt_explains_ghost_and_advisory():
    from app.live import llm

    s = llm.WORD_COACH_SYSTEM
    for token in ("pathDistance", "closeFraction", "practiceZoneIds", "advisory", "160 characters"):
        assert token in s, token


def test_word_ask_with_practice_ids(tmp_path):
    fake = FakeClient(draft("Pull the tongue back a little and push a long stream of air."))
    c = make(tmp_path, fake, anthropic_api_key="k")
    r = c.post("/v1/live/word/ask", json=ask_body(word="sheep", practiceZoneIds=["sh"], question="How do I say the sh?"))
    assert r.json()["source"] == "model"
    content = fake.calls[0]["messages"][0]["content"]
    assert '"practiceZones":["sh"]' in content and '"kind":"fricative"' in content


def test_word_ask_fallback_names_the_part(tmp_path):
    c = make(tmp_path)
    r = c.post("/v1/live/word/ask", json=ask_body(word="rent", practiceZoneIds=["n"], question="Help?"))
    assert r.json()["source"] == "fallback" and "the n" in r.json()["say"]
