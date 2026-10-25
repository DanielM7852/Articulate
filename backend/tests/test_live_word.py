"""Word coaching (the "track" demo): roll-up scoring, the word validator, the fallback, and the route."""

import pytest
from fastapi.testclient import TestClient

from app.live.decision import (
    DecisionError,
    validate_word_decision,
    word_evidence_candidates,
    word_fallback_decision,
    word_fallback_line,
)
from app.live.schemas import CoachDecision, WordAttempt
from app.live.scoring import score_word
from app.live.words import TRACK
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import AID, FakeClient

ZONE_KIND = {"t": ("t", "stop"), "r": ("r", "tuner"), "a": ("ae", "vowel"), "k": ("k", "stop")}


def zone(zid, verdict="hit", **evidence):
    phoneme, kind = ZONE_KIND[zid]
    return {
        "zoneId": zid,
        "phoneme": phoneme,
        "kind": kind,
        "verdict": verdict,
        "dwellMs": 0 if kind == "stop" else 240,
        "startMs": 0,
        "endMs": 100,
        "evidence": evidence,
    }


def attempt_dict(verdicts=None, quality="usable", reason=None, lip=False, evidence=None):
    verdicts = {"t": "hit", "r": "hit", "a": "hit", "k": "hit", **(verdicts or {})}
    evidence = evidence or {}
    return {
        "word": "track",
        "attemptId": AID,
        "durationMs": 1380,
        "zones": [zone(z, verdicts[z], **evidence.get(z, {})) for z in ("t", "r", "a", "k")],
        "quality": quality,
        "qualityReason": reason,
        "lipUsable": lip,
    }


def attempt(**kw) -> WordAttempt:
    return WordAttempt.model_validate(attempt_dict(**kw))


MISSING_CK = dict(
    verdicts={"r": "partial", "k": "miss"},
    evidence={
        "t": {"burstDetected": 1, "burstMs": 40, "voicedBefore": 0},
        "r": {"valueMedian": 780.0, "valueBest": 640.0, "inBandFraction": 0.18},
        "a": {"f1Median": 745.0, "f2Median": 1790.0, "f1Offset": 0.034, "f2Offset": -0.033, "inTargetFraction": 0.72},
        "k": {"burstDetected": 0, "burstMs": -1, "voicedBefore": 1},
    },
)


# ---- score_word ----


def test_all_hit_is_on_target():
    s = score_word(attempt())
    assert (s.verdict, s.hitCount, s.zoneCount, s.weakestZoneId) == ("on_target", 4, 4, None)


def test_partial_only_is_close_and_weakest_is_first_partial():
    s = score_word(attempt(verdicts={"r": "partial", "a": "partial"}))
    assert (s.verdict, s.hitCount, s.weakestZoneId) == ("close", 2, "r")


def test_miss_beats_partial_for_weakest():
    s = score_word(attempt(verdicts={"r": "partial", "k": "miss"}))
    assert (s.verdict, s.weakestZoneId, s.hitCount) == ("off", "k", 2)


def test_skipped_counts_as_missing():
    s = score_word(attempt(verdicts={"t": "partial", "a": "skipped"}))
    assert (s.verdict, s.weakestZoneId) == ("off", "a")


def test_unclear_capture_is_insufficient():
    s = score_word(attempt(verdicts={"k": "miss"}, quality="unclear", reason="silence"))
    assert (s.verdict, s.weakestZoneId) == ("insufficient", None)


def test_zone_verdicts_pass_through():
    a = attempt(**MISSING_CK)
    s = score_word(a)
    assert [z.verdict for z in s.zones] == ["hit", "partial", "hit", "miss"]
    assert s.zones[2].evidence["f1Median"] == 745.0


def test_server_hints_mirror_track():
    assert [z.id for z in TRACK.zones] == ["t", "r", "a", "k"]
    assert [z.label for z in TRACK.zones] == ["t", "r", "a", "ck"]
    assert [z.phoneme for z in TRACK.zones] == ["t", "r", "ae", "k"]
    assert TRACK.zone("k").hint == "Back of the tongue up, then release."


def test_schema_rejects_duplicate_zones_and_bad_evidence_keys():
    d = attempt_dict()
    d["zones"].append(dict(d["zones"][0]))
    with pytest.raises(ValueError):
        WordAttempt.model_validate(d)
    d = attempt_dict(evidence={"t": {"bad key": 1.0}})
    with pytest.raises(ValueError):
        WordAttempt.model_validate(d)


# ---- validator ----


def word_decision(**kw):
    d = dict(
        observation="The board saw no release for the ck at the end.",
        caption="The ck at the end went missing. Back of the tongue up, then release.",
        cueId=None,
        nextAction="retry",
        evidenceFields=["word.verdict", "word.k.verdict"],
        focusZoneId="k",
    )
    d.update(kw)
    return CoachDecision(**d)


def check(decision, a=None):
    a = a or attempt(**MISSING_CK)
    s = score_word(a)
    return validate_word_decision(decision, a, s, word_evidence_candidates(a, s))


def test_good_decision_passes():
    evidence = check(word_decision())
    assert [e.field for e in evidence] == ["word.verdict", "word.k.verdict"]
    assert evidence[1].value == "miss"


def test_digits_from_cited_evidence_pass():
    d = word_decision(
        observation="Your a landed in the target for 72 percent of the vowel; the ck was missed.",
        evidenceFields=["word.a.inTargetFraction", "word.k.verdict"],
    )
    check(d)


def test_wrong_focus_zone_fails():
    with pytest.raises(DecisionError, match="focus_zone_unknown"):
        check(word_decision(focusZoneId="x"))


def test_digit_not_in_evidence_fails():
    with pytest.raises(DecisionError, match="number_not_in_evidence"):
        check(word_decision(caption="The ck went missing 3 times. Back of the tongue up, then release."))


def test_cited_digit_from_uncited_field_fails():
    # 780 is real evidence (word.r.valueMedian) but the decision did not list that field.
    with pytest.raises(DecisionError, match="number_not_in_evidence"):
        check(word_decision(observation="The r gap sat at 780."))


def test_unknown_evidence_field_fails():
    with pytest.raises(DecisionError, match="unknown_evidence_field"):
        check(word_decision(evidenceFields=["word.k.notAField"]))


def test_caption_must_name_focus_or_word():
    with pytest.raises(DecisionError, match="caption_misses_focus"):
        check(word_decision(caption="Back of the tongue up, then release."))
    check(word_decision(caption="Say track again. Back of the tongue up, then release."))


def test_on_target_caption_must_name_word():
    a = attempt()
    with pytest.raises(DecisionError, match="caption_misses_word"):
        check(word_decision(focusZoneId=None, nextAction="next_sound", caption="Every part landed."), a)
    check(word_decision(focusZoneId=None, nextAction="next_sound", caption="That's track. Nice work."), a)


def test_at_most_two_sentences():
    with pytest.raises(DecisionError, match="caption_length"):
        check(word_decision(caption="The ck went missing. Back of the tongue up. Then release."))


def test_one_sentence_of_praise_max():
    with pytest.raises(DecisionError, match="too_much_praise"):
        check(word_decision(caption="Nice t at the start. Great r too."))
    check(word_decision(caption="Nice t at the start. Now the ck: back of the tongue up, then release."))


def test_shaming_fails():
    with pytest.raises(DecisionError, match="shaming_language"):
        check(word_decision(caption="The ck was wrong. Back of the tongue up, then release."))


def test_listening_language_fails():
    with pytest.raises(DecisionError, match="listening_language"):
        check(word_decision(caption="Listen to the ck at the end. Back of the tongue up, then release."))


def test_lips_and_jaw_need_the_camera():
    d = word_decision(focusZoneId="a", caption="The a needs more room. Drop your jaw a little more.")
    with pytest.raises(DecisionError, match="body_claim_without_video"):
        check(d)
    check(d, attempt(lip=True, **MISSING_CK))


def test_tongue_claims_fail_but_instructions_pass():
    with pytest.raises(DecisionError, match="tongue_claim"):
        check(word_decision(caption="Your tongue stayed down on the ck. Lift it, then release."))
    check(word_decision(caption="For the ck, back of the tongue up, then release."))


def test_cue_only_for_its_zone():
    with pytest.raises(DecisionError, match="cue_not_for_zone"):
        check(word_decision(cueId="open-jaw"))  # focus is k
    check(word_decision(cueId="open-jaw", focusZoneId="a", caption="The a in the middle: open wide, tongue low and forward."))


def test_unclear_capture_needs_plain_retry():
    a = attempt(quality="unclear", reason="silence")
    with pytest.raises(DecisionError, match="insufficient_capture_needs_retry"):
        check(word_decision(nextAction="next_sound", caption="Say track once more."), a)
    check(word_decision(focusZoneId=None, caption="Say track once more, clear and steady."), a)


# ---- fallback ----


def test_fallback_line_for_missing_ck():
    a = attempt(**MISSING_CK)
    _, caption, focus = word_fallback_line(a, score_word(a))
    assert focus == "k"
    assert caption == "The ck at the end went missing. Back of the tongue up, then release."


@pytest.mark.parametrize(
    "kw",
    [
        {},
        {"verdicts": {"t": "miss"}},
        {"verdicts": {"r": "miss"}},
        {"verdicts": {"r": "partial"}},
        {"verdicts": {"a": "miss"}},
        {"verdicts": {"a": "miss"}, "lip": True},
        {"verdicts": {"a": "skipped"}},
        {"verdicts": {"k": "partial"}},
        {"quality": "unclear", "reason": "silence"},
        {"quality": "unclear", "reason": "clipped"},
        {"quality": "unclear", "reason": "too-short"},
    ],
)
def test_fallback_always_passes_the_validator(kw):
    a = attempt(**kw)
    s = score_word(a)
    candidates = word_evidence_candidates(a, s)
    decision, evidence = word_fallback_decision(a, s, candidates)
    assert validate_word_decision(decision, a, s, candidates) == evidence
    assert decision.focusZoneId == s.weakestZoneId


@pytest.mark.parametrize(
    "practice,name",
    [
        (None, "track"),
        (["t", "r", "a", "k"], "track"),
        (["t", "r"], "the tr in track"),
        (["k"], "the ck in track"),
    ],
)
@pytest.mark.parametrize(
    "reason,template",
    [
        (None, "I couldn't catch {n} that time. Say it once more, clear and steady."),
        ("clipped", "That was a bit loud for me. Say {n} once more, a little softer."),
        ("too-short", "That went by quickly. Say {n} once more, at an easy pace."),
    ],
)
def test_insufficient_fallback_names_the_practised_part(practice, name, reason, template):
    a = attempt(quality="unclear", reason=reason)
    s = score_word(a, practice)
    _, caption, focus = word_fallback_line(a, s, practice)
    assert focus is None
    assert caption == template.format(n=name)
    candidates = word_evidence_candidates(a, s)
    decision, evidence = word_fallback_decision(a, s, candidates, practice)
    assert validate_word_decision(decision, a, s, candidates, practice) == evidence


def test_part_label_caption_allowed_only_for_a_strict_practice_part():
    a = attempt()
    caption = "Nice. Say the tr once more, tongue tip up then back."
    d = word_decision(focusZoneId=None, caption=caption, evidenceFields=["word.verdict"], nextAction="next_sound")
    s = score_word(a, ["t", "r"])
    cands = word_evidence_candidates(a, s)
    assert validate_word_decision(d, a, s, cands, ["t", "r"])
    s_all = score_word(a)
    with pytest.raises(DecisionError, match="caption_misses_word"):
        validate_word_decision(d, a, s_all, word_evidence_candidates(a, s_all), None)


def test_fallback_without_camera_avoids_jaw():
    a = attempt(verdicts={"a": "miss"})
    _, caption, _ = word_fallback_line(a, score_word(a))
    assert "jaw" not in caption.lower() and caption.startswith("The a in the middle")


# ---- route ----


def coach_body(word):
    return {
        "attemptId": AID,
        "profileId": "word-1",
        "sound": "a",
        "metricsSource": "inline",
        "clientSummary": {"durationSec": 1.38, "usableVoicedSec": 0.0, "quality": "usable", "qualityReason": None},
        "frames": {"audio": [], "video": []},
        "word": word,
    }


def client_for(tmp_path, fake=None):
    app = create_app(make_settings(tmp_path))
    if fake is not None:
        app.state.live_client = fake
    return TestClient(app)


def test_route_fallback_for_missing_ck(tmp_path):
    r = client_for(tmp_path).post("/v1/live/coach", json=coach_body(attempt_dict(**MISSING_CK)))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["source"] == "fallback"
    assert data["focusZoneId"] == "k"
    assert data["caption"] == "The ck at the end went missing. Back of the tongue up, then release."
    assert data["cueId"] is None and data["showSideView"] is True and data["nextAction"] == "retry"
    assert data["word"]["verdict"] == "off" and data["word"]["weakestZoneId"] == "k" and data["word"]["hitCount"] == 2


def test_route_agent_decision_is_validated_and_used(tmp_path):
    fake = FakeClient(parsed=word_decision(caption="Almost there. For the ck, lift the back of the tongue, then release."))
    r = client_for(tmp_path, fake).post("/v1/live/coach", json=coach_body(attempt_dict(**MISSING_CK)))
    data = r.json()
    assert data["source"] == "agent" and data["focusZoneId"] == "k"
    assert fake.calls and "word.k.burstDetected" in fake.calls[0]["messages"][0]["content"]
    assert "Ava" in fake.calls[0]["system"]


def test_route_agent_with_bad_focus_falls_back(tmp_path):
    fake = FakeClient(parsed=word_decision(focusZoneId="zz"))
    data = client_for(tmp_path, fake).post("/v1/live/coach", json=coach_body(attempt_dict(**MISSING_CK))).json()
    assert data["source"] == "fallback" and data["focusZoneId"] == "k"


def test_route_on_target_word(tmp_path):
    data = client_for(tmp_path).post("/v1/live/coach", json=coach_body(attempt_dict())).json()
    assert data["word"]["verdict"] == "on_target" and data["nextAction"] == "next_sound"
    assert data["focusZoneId"] is None and data["showSideView"] is False


def test_route_vowel_path_unchanged_without_word(tmp_path):
    body = coach_body(None)
    del body["word"]
    body["frames"] = None
    data = client_for(tmp_path).post("/v1/live/coach", json=body).json()
    assert data["word"] is None and data["focusZoneId"] is None
    assert data["audio"]["verdict"] == "insufficient"
