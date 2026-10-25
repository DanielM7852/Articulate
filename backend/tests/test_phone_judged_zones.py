"""Phone-judged liquid/fricative/nasal zones (evidence judgedByPhones == 1) are real, judged zones."""

import pytest

from app.live.decision import (
    DecisionError,
    validate_word_decision,
    word_evidence_candidates,
    word_fallback_line,
)
from app.live.schemas import CoachDecision, WordAttempt
from app.live.scoring import score_word

AID = "a" * 8 + "-0000-4000-8000-" + "0" * 12
PJ = {"judgedByPhones": 1, "phonePost": 0.0, "phoneGop": -2.0}


def z(zid, phoneme, kind, verdict="hit", **ev):
    return {"zoneId": zid, "phoneme": phoneme, "kind": kind, "verdict": verdict, "dwellMs": 200,
            "startMs": 0, "endMs": 100, "evidence": ev}


def track(r_verdict="miss", r_ev=None):
    return WordAttempt.model_validate({
        "word": "track", "attemptId": AID, "durationMs": 1300, "quality": "usable", "qualityReason": None,
        "lipUsable": False,
        "zones": [z("t", "t", "stop"), z("r", "r", "liquid", r_verdict, **(PJ if r_ev is None else r_ev)),
                  z("a", "ae", "vowel"), z("k", "k", "stop")],
    })


def sheep(sh_verdict="miss", sh_ev=None):
    return WordAttempt.model_validate({
        "word": "sheep", "attemptId": AID, "durationMs": 1300, "quality": "usable", "qualityReason": None,
        "lipUsable": False,
        "zones": [z("sh", "sh", "fricative", sh_verdict, **(PJ if sh_ev is None else sh_ev)),
                  z("ee", "iy", "vowel"), z("p", "p", "stop")],
    })


def decision(**kw):
    base = dict(observation="x", caption="The r didn't come through.", cueId=None, nextAction="retry",
                evidenceFields=["word.verdict"], focusZoneId="r")
    return CoachDecision(**{**base, **kw})


def test_track_phone_judged_r_counts():
    a = track()
    s = score_word(a)
    assert s.verdict != "on_target" and s.weakestZoneId == "r" and s.zoneCount == 4
    obs, cap, focus = word_fallback_line(a, s)
    assert cap.startswith("The r") and "didn't come through" in cap and focus == "r"


def test_practice_tr_focus_r():
    a = track()
    s = score_word(a, ["t", "r"])
    assert s.weakestZoneId == "r"
    _, cap, focus = word_fallback_line(a, s, ["t", "r"])
    assert focus == "r" and "didn't come through" in cap and "landed" not in cap


def test_sheep_sh():
    s = score_word(sheep())
    assert s.weakestZoneId == "sh"
    assert "didn't come through" in word_fallback_line(sheep(), s)[1]
    p = sheep("partial")
    sp = score_word(p)
    assert sp.weakestZoneId == "sh" and "was faint" in word_fallback_line(p, sp)[1]


def test_float_one_and_missing_evidence():
    assert track(r_ev={"judgedByPhones": 1.0}).zones[1].is_advisory is False
    assert track(r_ev={}).zones[1].is_advisory is True
    assert track(r_ev={"judgedByPhones": 0}).zones[1].is_advisory is True


def test_not_phone_judged_unchanged():
    a = track(r_ev={})
    s = score_word(a)
    assert s.zoneCount == 3 and s.verdict == "on_target"
    a = track("miss", {})
    a = a.model_copy(update={"zones": [x.model_copy(update={"verdict": "hit"}) if x.zoneId == "k" else x for x in a.zones]})
    sh = sheep(sh_ev={})
    s2 = score_word(sh, ["sh"])
    _, cap, focus = word_fallback_line(sh, s2, ["sh"])
    assert cap.startswith("Let's work on the sh") and focus == "sh"


def test_validator_phone_judged_vs_not():
    a = track()
    s = score_word(a)
    validate_word_decision(decision(), a, s, word_evidence_candidates(a, s))
    validate_word_decision(decision(caption="The r was missed."), a, s, word_evidence_candidates(a, s))
    b = track(r_ev={})
    sb = score_word(b)
    # The guard fires on verdict/praise words (the existing _JUDGE/_PRAISE lists), not on "didn't come through".
    with pytest.raises(DecisionError, match="judged_advisory_zone"):
        validate_word_decision(decision(caption="The r was missed."), b, sb, word_evidence_candidates(b, sb))


def test_phone_judged_stop_and_vowel_keep_their_wording():
    """Only an r, sh or n gets the phone wording; web/src/live/wordCoach.ts says the same."""
    a = WordAttempt.model_validate({
        "word": "track", "attemptId": AID, "durationMs": 1300, "quality": "usable", "qualityReason": None,
        "lipUsable": False,
        "zones": [z("t", "t", "stop", "miss", **PJ), z("r", "r", "liquid", "hit", **PJ),
                  z("a", "ae", "vowel", "partial", **PJ), z("k", "k", "stop", "hit", **PJ)],
    })
    s = score_word(a)
    _, cap, focus = word_fallback_line(a, s)
    assert focus == "t" and "went missing" in cap
    _, cap, focus = word_fallback_line(a, score_word(a, ["a"]), ["a"])
    assert focus == "a" and "nearly there" in cap
