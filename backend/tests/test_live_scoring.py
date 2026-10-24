"""Deterministic scoring of live attempts."""

from app.live.schemas import AudioFrame, LipFrame
from app.live.scoring import score_audio, score_video
from app.live.targets import in_target


def audio(f1, f2, n=20, valid=True):
    return [AudioFrame(t=i * 20.0, f1=f1, f2=f2, conf=0.9, rms=0.1, valid=valid) for i in range(n)]


def lips(n=10, ok=True, **kw):
    return [LipFrame(t=i * 33.0, ok=ok, **kw) for i in range(n)]


def test_targets_match_web_regions():
    assert in_target("u", 420, 1050) and in_target("i", 390, 2500) and in_target("a", 850, 1400)
    assert not in_target("i", 850, 1400)


def test_on_target_u():
    s = score_audio("u", audio(420, 1050))
    assert s.verdict == "on_target" and s.inTargetFraction == 1.0 and s.voicedFrames == 20
    assert abs(s.f1Offset) < 0.01 and abs(s.f2Offset) < 0.01


def test_far_off_has_offset_signs():
    # u spoken with a wide-open, front vowel: F1 higher (too open), F2 higher (too front).
    s = score_audio("u", audio(800, 2200))
    assert s.verdict == "off" and s.inTargetFraction == 0.0
    assert s.f1Offset > 0 and s.f2Offset > 0
    t = score_audio("i", audio(300, 1500))  # F1 lower, F2 lower (too back)
    assert t.verdict == "off" and t.f1Offset < 0 and t.f2Offset < 0


def test_close_band():
    s = score_audio("u", audio(420, 1450))  # just outside the ellipse
    assert s.inTargetFraction == 0.0 and s.verdict == "close"


def test_insufficient_when_few_voiced():
    s = score_audio("u", audio(420, 1050, n=7))
    assert s.verdict == "insufficient" and s.f1Median is None
    assert score_audio("u", audio(420, 1050, n=30, valid=False)).verdict == "insufficient"


def test_video_u_rounding_matches():
    v = score_video("u", lips(rounding=0.5, lipWidth=0.9))
    assert v.verdict == "matches" and v.roundingMean == 0.5 and "rounded" in v.expectation


def test_video_partly_mismatch_insufficient_and_none():
    assert score_video("u", lips(rounding=0.25, lipWidth=0.9)).verdict == "partly"
    assert score_video("u", lips(rounding=0.05, lipWidth=0.95)).verdict == "mismatch"
    assert score_video("i", lips(spread=0.3)).verdict == "matches"
    assert score_video("a", lips(jawDrop=1.2)).verdict == "matches"
    assert score_video("u", lips(n=5, rounding=0.5)).verdict == "insufficient"
    assert score_video("u", lips(ok=False, rounding=0.5)).verdict == "insufficient"
    assert score_video("u", []) is None
