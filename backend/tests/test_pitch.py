"""Deterministic contour tests. These do not claim perceptual accuracy."""

import numpy as np

from app.audio.compare import compare_contours
from app.audio.content import ContentCheck, RejectingContentVerifier
from app.reasoning.assessment import assess
from tests.support import analyzed_pair, contour_from_hz, pitch_track, make_settings


def test_identical_contours_have_no_shape_difference(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "rising")
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    assert metrics.reference_ending_direction == "rising"
    assert metrics.learner_ending_direction == "rising"
    assert metrics.aligned_rmse_st == 0
    assert alignment.method == "linear_time_normalization"
    assert alignment.alignment_ok is True


def test_baseline_shift_keeps_relative_contour(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "rising", f0_scale=1.35)
    metrics, _alignment = compare_contours(loaded.contour, learner.contour, settings)
    assert loaded.contour.median_reliable_f0_hz is not None
    assert learner.contour.median_reliable_f0_hz is not None
    assert learner.contour.median_reliable_f0_hz > loaded.contour.median_reliable_f0_hz + 20
    assert metrics.aligned_rmse_st == 0
    assert metrics.learner_ending_direction == "rising"
    assert metrics.learner_pitch_range_st == metrics.reference_pitch_range_st


def test_rising_and_falling_endings_differ(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    metrics, _alignment = compare_contours(loaded.contour, learner.contour, settings)
    assert metrics.reference_ending_direction == "rising"
    assert metrics.learner_ending_direction == "falling"
    assert metrics.aligned_rmse_st is not None
    assert metrics.aligned_rmse_st > 1.5


def test_different_speed_preserves_duration_ratio(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "rising", time_scale=1.4)
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    assert metrics.learner_duration_s is not None
    assert metrics.reference_duration_s is not None
    assert metrics.learner_duration_s > metrics.reference_duration_s * 1.3
    assert alignment.duration_ratio is not None
    assert alignment.duration_ratio > 1.3
    assert metrics.learner_ending_direction == "rising"
    assert alignment.method == "constrained_dtw"
    assert metrics.aligned_rmse_st is not None
    assert metrics.aligned_rmse_st < 0.05


def test_silence_has_no_usable_pitch(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "silence")
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    assert metrics.learner_usable_frames == 0
    assert metrics.learner_ending_direction == "unknown"
    assert alignment.alignment_ok is False
    content = ContentCheck(False, "content_verifier_not_configured", "not_configured")
    assessment = assess(metrics, alignment, learner.facts, loaded.facts, content, loaded.metadata, settings)
    assert assessment.finding == "insufficient_usable_pitch"
    assert assessment.usable is False
    assert assessment.terminal_status == "insufficient_audio"


def test_octave_glitch_is_withheld_from_scoring(tmp_path):
    settings = make_settings(tmp_path)
    times, f0 = pitch_track("rising", glitch="octave")
    contour = contour_from_hz(settings, f0, times)
    rejected = [frame for frame in contour.frames if frame.rejected_reason == "suspected_octave_error"]
    assert len(rejected) == 5
    assert all(frame.f0_hz is None and frame.relative_pitch_st is None and frame.usable is False for frame in rejected)
    loaded, learner = analyzed_pair(settings, "rising", glitch="octave")
    assert learner.facts.suspected_octave_error is True
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    content = ContentCheck(False, "content_verifier_not_configured", "not_configured")
    assessment = assess(metrics, alignment, learner.facts, loaded.facts, content, loaded.metadata, settings)
    assert "suspected_octave_error" in assessment.limitations
    assert assessment.usable is True
    assert metrics.aligned_rmse_st is not None
    assert metrics.aligned_rmse_st < 1.0


def test_implausible_jump_is_flagged(tmp_path):
    settings = make_settings(tmp_path)
    times, f0 = pitch_track("steady", glitch="jump")
    contour = contour_from_hz(settings, f0, times)
    assert any(frame.rejected_reason == "implausible_pitch_jump" for frame in contour.frames)


def test_content_mismatch_limits_claims(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    content = RejectingContentVerifier().verify(
        expected_transcript=loaded.metadata.transcript,
        samples=np.zeros(8),
        sample_rate=16000,
    )
    assessment = assess(metrics, alignment, learner.facts, loaded.facts, content, loaded.metadata, settings)
    assert assessment.claims_limited is True
    assert assessment.quality.content_verified is False
    assert "content_mismatch" in assessment.limitations
    assert assessment.finding == "ending_direction_mismatch"


def test_reference_that_does_not_match_its_pattern_is_not_used(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "steady", reference_kind="steady")
    metrics, alignment = compare_contours(loaded.contour, learner.contour, settings)
    content = ContentCheck(False, "content_verifier_not_configured", "not_configured")
    assessment = assess(
        metrics,
        alignment,
        learner.facts,
        loaded.facts,
        content,
        loaded.metadata,
        settings,
    )
    assert assessment.finding == "reference_unusable"
    assert assessment.usable is False
