"""HTTP contract checks. The synthetic fixture test runs the real extractor."""

from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings


def test_health_and_capture_state_guard(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    health = client.get("/health")
    assert health.status_code == 200
    body = health.json()
    assert body["audio_retained_by_default"] is False
    assert body["anthropic_configured"] is False
    assert body["moss_configured"] is False
    rejected = client.post(
        "/v1/comparisons",
        data={
            "reference_id": "intonation-rising-ready",
            "attempt_id": "attempt-1",
            "session_id": "session-1",
            "capture_state": "reference_playback",
        },
        files={"learner_audio": ("learner.wav", b"RIFF", "audio/wav")},
    )
    assert rejected.status_code == 422
    page = client.get("/")
    assert page.status_code == 200
    assert "Listening check" in page.text
    assert "audio" in page.text
    learner = client.get("/v1/fixtures/rising_vs_falling/audio")
    assert learner.status_code == 200
    assert learner.headers["content-type"].startswith("audio/wav")
    assert learner.content[:4] == b"RIFF"
    fixtures = client.get("/v1/fixtures")
    assert fixtures.status_code == 200
    assert fixtures.json()["fixture_mode"] is True
    assert "rising_vs_falling" in fixtures.json()["scenarios"]


def test_unknown_reference_and_session_deletion(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    missing = client.post(
        "/v1/comparisons",
        data={
            "reference_id": "missing-reference",
            "attempt_id": "attempt-1",
            "session_id": "session-1",
            "capture_state": "learner_recording",
        },
        files={"learner_audio": ("learner.wav", b"RIFFnot-audio", "audio/wav")},
    )
    assert missing.status_code == 404
    deleted = client.delete("/v1/sessions/session-1")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is False


def test_silence_fixture_requests_another_recording(tmp_path):
    client = TestClient(create_app(make_settings(tmp_path)))
    response = client.post(
        "/v1/comparisons/fixtures/silence",
        params={"session_id": "fixture-silence", "attempt_id": "silence-1"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["fixture_mode"] is True
    assert body["fixture_scenario"] == "silence"
    assert body["status"] == "insufficient_audio"
    assert body["audio_retained"] is False
    assert body["content_verified"] is False
    assert body["feedback"]["cue_id"] == "cue-rerecord-draft"
    assert body["feedback"]["spoken_text"]
    assert body["retrieval"]["disclosed_fallback"] is True
    assert "fixture_mode_synthetic_audio" in body["limitations"]
