"""Synthetic harmonic recordings through librosa.pyin.

These are generated fixtures, not human speech, and they are not an accuracy benchmark.
No real learner recording was available in the repository.
"""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings


def _fixture(tmp_path, scenario: str, attempt: str) -> dict:
    client = TestClient(create_app(make_settings(tmp_path)))
    response = client.post(
        f"/v1/comparisons/fixtures/{scenario}",
        params={"session_id": f"pyin-{scenario}", "attempt_id": attempt},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_pyin_identical_and_baseline_shift(tmp_path):
    identical = _fixture(tmp_path, "identical", "identical-1")
    assert identical["fixture_mode"] is True
    assert identical["metrics"]["reference_ending_direction"] == "rising"
    assert identical["metrics"]["learner_ending_direction"] == "rising"
    assert identical["metrics"]["aligned_rmse_st"] is not None
    assert identical["metrics"]["aligned_rmse_st"] < 1.0
    assert identical["content_verified"] is False
    assert identical["feedback"]["spoken_text"]
    assert len(identical["feedback"]["spoken_text"]) < 600

    shifted = _fixture(tmp_path, "baseline_shift", "baseline-1")
    assert shifted["metrics"]["learner_ending_direction"] == "rising"
    assert shifted["learner_contour"]["median_reliable_f0_hz"] > identical["learner_contour"]["median_reliable_f0_hz"] + 15
    assert shifted["metrics"]["aligned_rmse_st"] < 1.5


def test_pyin_falling_ending_and_faster_speech(tmp_path):
    falling = _fixture(tmp_path, "rising_vs_falling", "falling-1")
    assert falling["metrics"]["reference_ending_direction"] == "rising"
    assert falling["metrics"]["learner_ending_direction"] == "falling"
    assert falling["finding"] == "ending_direction_mismatch"
    assert falling["feedback"]["cue_id"] == "cue-rise-ending-draft"
    assert falling["feedback"]["reference_segment_replay"] is not None
    assert falling["audio_retained"] is False
    assert "selected_cue_is_unreviewed_draft" in falling["limitations"]

    faster = _fixture(tmp_path, "faster_speech", "faster-1")
    assert faster["metrics"]["learner_ending_direction"] == "rising"
    assert faster["alignment"]["duration_ratio"] is not None
    assert faster["alignment"]["duration_ratio"] < 0.9
    assert faster["metrics"]["aligned_rmse_st"] is not None
    assert faster["metrics"]["aligned_rmse_st"] < 2.0
