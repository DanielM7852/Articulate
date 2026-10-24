"""Articulation feature extraction and the SPARC/formant corroboration gate."""

import copy
import json
from pathlib import Path

import pytest

from app.live.articulation import annotate_attempts, extract_features

FIXTURES = Path(__file__).parent / "fixtures" / "articulation"


def bundle(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


def feats(**kw):
    return {"quality": "ok", "reason": None, "tongueHeight": 0.0, "tongueFront": 0.0, **kw}


def attempt(aid, verdict, f1, f2, artic, sound="i"):
    return {"attemptId": aid, "sound": sound, "audioVerdict": verdict, "f1Offset": f1, "f2Offset": f2, "artic": artic}


def anchor(aid="a1", **kw):
    return attempt(aid, "on_target", 0.0, 0.0, feats(**kw))


def test_fixture_features_ordering():
    ee, ah, oo = (extract_features(bundle(n)) for n in ("ee", "ah", "oo"))
    assert all(f["quality"] == "ok" and f["vad"] for f in (ee, ah, oo))
    assert ee["tongueHeight"] > oo["tongueHeight"] > ah["tongueHeight"]
    assert ee["tongueFront"] > ah["tongueFront"]
    assert ee["speechMs"] == 1172.0 and ee["frames"] == 59


def test_unavailable_or_wrong_schema_is_none():
    b = bundle("ee")
    assert extract_features(None) is None and extract_features([]) is None
    wrong = copy.deepcopy(b)
    wrong["schemaVersion"] = "x/2"
    assert extract_features(wrong) is None
    down = copy.deepcopy(b)
    down["models"]["sparc"] = {"status": "error", "series": {}}
    assert extract_features(down) is None


def test_no_vad_speech_insufficient():
    b = bundle("ee")
    b["models"]["silero_vad"]["segments"] = []
    f = extract_features(b)
    assert f["quality"] == "insufficient" and f["reason"] == "no_speech" and f["frames"] == 0
    assert f["tongueHeight"] is None


def test_vad_unavailable_uses_audio_frames():
    b = bundle("ee")
    b["models"]["silero_vad"] = {"status": "error", "segments": []}
    f = extract_features(b)
    assert f["vad"] is False and f["speechMs"] is None and f["speechFraction"] is None
    assert f["frames"] > 59


def test_too_short_and_clipped():
    b = bundle("ee")
    b["models"]["silero_vad"]["segments"] = [{"startMs": 130.0, "endMs": 400.0}]
    f = extract_features(b)
    assert f["quality"] == "insufficient" and f["reason"] == "too_short"
    c = bundle("ee")
    c["audio"]["clippedFraction"] = 0.05
    assert extract_features(c)["reason"] == "clipped"


def test_agreeing_lower_claim_is_single():
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.6))
    out = annotate_attempts([cur, anchor()], None)
    assert "artic" not in out[0]
    assert out[0]["articulation"]["claims"] == [
        {"part": "tongue", "dimension": "height", "direction": "lower", "basis": "self", "comparedTo": ["a1"],
         "sparcDelta": -0.6, "formantDelta": 0.2}
    ]


def test_agreeing_frontness_claims():
    back = annotate_attempts([attempt("n", "off", 0.0, -0.2, feats(tongueFront=-0.5)), anchor()], None)
    assert [c["direction"] for c in back[0]["articulation"]["claims"]] == ["further_back"]
    fwd = annotate_attempts([attempt("n", "off", 0.0, 0.2, feats(tongueFront=0.5)), anchor()], None)
    assert [c["direction"] for c in fwd[0]["articulation"]["claims"]] == ["further_forward"]


def test_higher_claim():
    out = annotate_attempts([attempt("n", "close", -0.2, 0.0, feats(tongueHeight=0.6)), anchor()], None)
    assert [c["direction"] for c in out[0]["articulation"]["claims"]] == ["higher"]


@pytest.mark.parametrize("f1", [-0.2, 0.0, 0.05])
def test_disagreement_or_small_formant_gives_no_claim(f1):
    out = annotate_attempts([attempt("n", "close", f1, 0.0, feats(tongueHeight=-0.8)), anchor()], None)
    assert out[0]["articulation"] == {"quality": "ok", "claims": []}


def test_small_sparc_delta_gives_no_claim():
    out = annotate_attempts([attempt("n", "close", 0.3, 0.0, feats(tongueHeight=-0.2)), anchor()], None)
    assert out[0]["articulation"]["claims"] == []


def test_on_target_attempt_gets_no_claim():
    out = annotate_attempts([attempt("n", "on_target", 0.3, 0.0, feats(tongueHeight=-0.9)), anchor()], None)
    assert out[0]["articulation"]["claims"] == []


def test_no_anchor_no_claims():
    cur = attempt("n", "close", 0.3, 0.0, feats(tongueHeight=-0.9))
    assert annotate_attempts([cur], None)[0]["articulation"]["claims"] == []
    weak = attempt("a", "close", 0.0, 0.0, feats())
    assert annotate_attempts([cur, weak], None)[0]["articulation"]["claims"] == []


def test_anchors_same_sound_older_only():
    cur = attempt("n", "close", 0.3, 0.0, feats(tongueHeight=-0.9))
    other_sound = attempt("o", "on_target", 0.0, 0.0, feats(), sound="u")
    assert annotate_attempts([cur, other_sound], None)[0]["articulation"]["claims"] == []
    newer_first = [attempt("new", "on_target", 0.0, 0.0, feats()), cur]
    assert annotate_attempts(newer_first, None)[1]["articulation"]["claims"] == []
    many = [cur] + [anchor(f"a{i}") for i in range(5)]
    assert annotate_attempts(many, None)[0]["articulation"]["claims"][0]["comparedTo"] == ["a0", "a1", "a2"]


def test_anchor_median_across_anchors():
    cur = attempt("n", "close", 0.3, 0.0, feats(tongueHeight=-0.3))
    anchors = [anchor("a0", tongueHeight=0.0), anchor("a1", tongueHeight=0.0), anchor("a2", tongueHeight=-5.0)]
    assert annotate_attempts([cur, *anchors], None)[0]["articulation"]["claims"] == []


def test_insufficient_artic_and_passthrough():
    bad = attempt("n", "close", 0.3, 0.0, {"quality": "insufficient", "reason": "clipped"})
    plain = {"attemptId": "p", "sound": "i"}
    out = annotate_attempts([bad, plain], None)
    assert out[0]["articulation"] == {"quality": "insufficient", "reason": "clipped"}
    assert out[1] == plain and "articulation" not in out[1]


def test_input_not_mutated():
    items = [attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.6)), anchor()]
    before = copy.deepcopy(items)
    annotate_attempts(items, None)
    assert items == before


def test_malformed_items_do_not_raise():
    junk = [
        None, 5, "x", {}, {"artic": None}, {"artic": "bad"}, {"artic": {"quality": "ok"}},
        attempt("a", "close", None, None, feats(tongueHeight=None)),
        {"artic": feats(tongueHeight="hi"), "audioVerdict": "off", "f1Offset": "x", "f2Offset": 0.1, "sound": "i"},
        anchor(tongueHeight=None),
    ]
    assert len(annotate_attempts(junk, None)) == len(junk)
    assert annotate_attempts(None, None) == []
