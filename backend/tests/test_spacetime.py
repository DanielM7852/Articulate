"""Spacetime HTTP client behavior. These tests do not open a database."""

from app.integrations.spacetimedb import FeatureBatch, SpacetimeClient
from app.schemas import CartesiaHandoff, ComparisonResult, Timings
from tests.support import make_settings


class _Response:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


def test_unconfigured_client_does_not_call_the_network(tmp_path):
    settings = make_settings(tmp_path)
    client = SpacetimeClient.from_settings(settings)
    assert client.configured is False
    seen = []

    def explode(*_args, **_kwargs):
        seen.append(True)
        raise AssertionError("network")

    import app.integrations.spacetimedb as module

    original = module.httpx.post
    module.httpx.post = explode
    try:
        result = client.call("become_worker", [])
    finally:
        module.httpx.post = original
    assert result.ok is False
    assert seen == []


def test_feature_batch_rejects_an_oversized_payload(tmp_path):
    settings = make_settings(tmp_path, spacetimedb_database="articulate-local", spacetimedb_token="worker")
    client = SpacetimeClient.from_settings(settings)
    batch = FeatureBatch(
        session_id="session-1",
        attempt_id="attempt-1",
        capture_id="capture-1",
        producer_id="device-1",
        sequence=0,
        first_sample_offset=0,
        sample_rate_hz=16000,
        hop_length=256,
        frame_length=1024,
        extraction_version="pitch-v1",
        frames=[{"time_s": index / 100, "f0_hz": None, "voiced": False, "valid": False, "quality": "x" * 200} for index in range(64)],
    )
    result = client.append_batch(batch, learner_token="learner")
    assert result.ok is False
    assert result.body == "payload_too_large"


def test_commit_sends_positional_args_and_a_stable_delivery_id(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, spacetimedb_database="articulate-local", spacetimedb_token="worker")
    client = SpacetimeClient.from_settings(settings)
    calls = []

    def fake_post(url, headers, json, timeout):
        calls.append((url, headers["Authorization"], json, timeout))
        return _Response(200, "ok")

    monkeypatch.setattr("app.integrations.spacetimedb.httpx.post", fake_post)
    result = ComparisonResult(
        status="partial",
        session_id="session-1",
        attempt_id="attempt-1",
        reference_id="intonation-rising-ready",
        analysis_version="pitch-v1",
        feedback=CartesiaHandoff(
            session_id="session-1",
            attempt_id="attempt-1",
            status="partial",
            observation="The ending fell.",
            instruction="Let the ending rise.",
            spoken_text="Let the ending rise.",
            next_action="repeat",
        ),
        timings_ms=Timings(),
        fixture_mode=True,
        finding="ending_direction_mismatch",
    )
    committed = client.commit_comparison(result, exercise="intonation_rising", learner_token="learner")
    assert committed.ok is True
    assert calls[0][0].endswith("/call/open_session")
    assert calls[0][1] == "Bearer learner"
    assert calls[1][0].endswith("/call/begin_attempt")
    assert calls[2][0].endswith("/call/commit_verified")
    assert calls[2][1] == "Bearer worker"
    body = calls[2][2]
    assert body[0] == "attempt-1"
    assert body[10] is True
    assert body[12] == "attempt-1:partial:ending_direction_mismatch"
    assert "frames" not in body[8]
