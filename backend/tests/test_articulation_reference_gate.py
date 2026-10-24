"""Reference-range tongue gate: first-try claims, agreement with self anchors, loader, templates."""

import json

import pytest

from app.live import insight
from app.live.articulation import REF_MARGIN, annotate_attempts, load_reference
from tests.test_articulation_gate import anchor, attempt, feats


def stat(lo, hi):
    return {"median": (lo + hi) / 2, "min": lo, "max": hi, "std": 0.1, "values": [lo, hi]}


def ref(n=4, height=(0.0, 1.0), front=(0.0, 1.0)):
    return {"v": 1, "source": "cartesia", "sounds": {"i": {"n": n, "tongueHeight": stat(*height), "tongueFront": stat(*front)}}}


def claims(items, reference):
    return annotate_attempts(items, reference)[0]["articulation"]["claims"]


def test_first_try_below_range_with_agreeing_formant():
    out = claims([attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.9))], ref())
    assert out == [{"part": "tongue", "dimension": "height", "direction": "lower", "basis": "reference",
                    "comparedTo": ["reference"], "sparcDelta": -0.9, "formantDelta": 0.2}]


def test_above_range_frontness_variants():
    assert [c["direction"] for c in claims([attempt("n", "off", -0.2, 0.0, feats(tongueHeight=1.8))], ref())] == ["higher"]
    assert [c["direction"] for c in claims([attempt("n", "off", 0.0, -0.2, feats(tongueFront=-0.8))], ref())] == ["further_back"]
    assert [c["direction"] for c in claims([attempt("n", "off", 0.0, 0.2, feats(tongueFront=1.8))], ref())] == ["further_forward"]


@pytest.mark.parametrize("height,f1", [(0.5, 0.3), (-REF_MARGIN, 0.3), (-0.2, 0.3), (-0.6, 0.3), (-0.9, 0.0), (-0.9, 0.05), (-0.9, -0.2)])
def test_inside_margin_or_formant_not_agreeing_no_claim(height, f1):
    assert claims([attempt("n", "close", f1, 0.0, feats(tongueHeight=height))], ref()) == []


def test_on_target_gets_no_reference_claim():
    assert claims([attempt("n", "on_target", 0.3, 0.0, feats(tongueHeight=-0.9))], ref()) == []


def test_both_basis_when_self_agrees():
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.9))
    out = claims([cur, anchor("a1", tongueHeight=0.5)], ref())
    assert len(out) == 1 and out[0]["basis"] == "both" and out[0]["comparedTo"] == ["reference", "a1"]


def test_self_only_when_reference_does_not_fire():
    # Past the range edge but within REF_MARGIN: the reference claim doesn't fire, the self claim survives.
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.2))
    out = claims([cur, anchor("a1", tongueHeight=0.8)], ref())
    assert [(c["basis"], c["comparedTo"]) for c in out] == [("self", ["a1"])]


def test_self_claim_dropped_inside_reference_range():
    # Inside the range of correct productions SPARC doesn't explain the miss: no tongue advice.
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=0.2))
    assert claims([cur, anchor("a1", tongueHeight=0.8)], ref()) == []
    # Without a usable reference the self claim is kept as before.
    assert [c["basis"] for c in claims([cur, anchor("a1", tongueHeight=0.8)], ref(n=2))] == ["self"]


def test_opposite_directions_drop_dimension():
    # reference says lower (far below range); self says higher (anchor even lower, formant moved up)
    cur = attempt("n", "close", -0.1, 0.0, feats(tongueHeight=-0.5))
    a = attempt("a1", "on_target", -0.4, 0.0, feats(tongueHeight=-1.5))
    r = ref()
    r["sounds"]["i"]["tongueHeight"] = stat(0.0, 1.0)
    assert claims([cur, a], r) == []
    # f1 of -0.1 would not fire the reference claim anyway; make it fire in both directions via a crafted case
    cur2 = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.5))
    a2 = attempt("a1", "on_target", 0.5, 0.0, feats(tongueHeight=-1.5))  # self: dh=+1.0, d1=-0.3 -> higher
    out = claims([cur2, a2], r)
    assert out == []


def test_dimensions_independent():
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.9, tongueFront=0.5))
    a = attempt("a1", "on_target", 0.0, 0.0, feats(tongueHeight=0.0, tongueFront=0.5))
    out = claims([cur, a], ref())
    assert [(c["dimension"], c["basis"]) for c in out] == [("height", "both")]


def test_no_reference_or_few_voices_equals_self_only():
    cur = attempt("n", "close", 0.2, 0.0, feats(tongueHeight=-0.9))
    assert claims([cur], None) == []
    assert claims([cur], ref(n=2)) == []
    assert claims([cur], {"v": 1, "sounds": {"i": {"n": 5}}}) == []
    items = [cur, anchor("a1")]
    assert annotate_attempts(items, ref(n=2)) == annotate_attempts(items, None)
    assert claims(items, None)[0]["basis"] == "self"


def test_load_reference(tmp_path):
    assert load_reference(tmp_path / "missing.json") is None
    bad = tmp_path / "bad.json"
    bad.write_text("{nope", encoding="utf-8")
    assert load_reference(bad) is None
    wrong = tmp_path / "wrong.json"
    wrong.write_text(json.dumps({"v": 2, "sounds": {}}), encoding="utf-8")
    assert load_reference(wrong) is None
    good = tmp_path / "good.json"
    good.write_text(json.dumps(ref()), encoding="utf-8")
    assert load_reference(good)["sounds"]["i"]["n"] == 4


@pytest.mark.parametrize("basis", ["self", "reference", "both"])
@pytest.mark.parametrize("direction", ["lower", "higher", "further_back", "further_forward"])
@pytest.mark.parametrize("sound", ["i", "u", "a"])
def test_every_template_validates(sound, direction, basis):
    dim = "height" if direction in ("lower", "higher") else "frontness"
    c = {"part": "tongue", "dimension": dim, "direction": direction, "basis": basis, "comparedTo": ["x"]}
    if not insight.claim_allowed(sound, c):
        return
    line = insight.template_line(sound, c)
    insight.validate_insight(line, sound, c)
    assert ("a clear" in line) == (basis != "self")
