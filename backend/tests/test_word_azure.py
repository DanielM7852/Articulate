"""Azure Pronunciation Assessment evidence in the word coach (Azure mocked)."""

import asyncio
import time

import pytest

from app.audio import azure_pronunciation
from app.audio.azure_pronunciation import AzureAssessment
from app.live import orchestrator
from tests.test_word_acoustics import CLEAR, anthropic_client, anthropic_text, body, payload
from tests.test_live_api import FakeClient
from tests.test_live_word import word_decision

PHONEMES = [
    {"phoneme": "t", "accuracy": 90.0, "offsetMs": 0, "durationMs": 50, "nbest": [{"phoneme": "t", "score": 90.0}]},
    {"phoneme": "ɹ", "accuracy": 35.0, "offsetMs": 50, "durationMs": 80, "nbest": [{"phoneme": "w", "score": 60.0}]},
    {"phoneme": "æ", "accuracy": 80.0, "offsetMs": 130, "durationMs": 120, "nbest": []},
    {"phoneme": "k", "accuracy": 20.0, "offsetMs": 250, "durationMs": 60, "nbest": [{"phoneme": "g", "score": 70.0}]},
]
ASSESSMENT = AzureAssessment(accuracy=61.0, fluency=95.0, completeness=100.0, pron=70.0, phonemes=PHONEMES)
SETTINGS = dict(azure_speech_key="k", azure_speech_region="westus2")


@pytest.fixture(autouse=True)
def no_praat(monkeypatch):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: CLEAR)


def mock_assess(monkeypatch, result=ASSESSMENT, delay=0.0, calls=None):
    async def fake(wav, ref, settings, http=None):
        if calls is not None:
            calls.append(ref)
        if delay:
            await asyncio.sleep(delay)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(azure_pronunciation, "assess", fake)


def run(tmp_path, **kw):
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake, **SETTINGS).post("/v1/live/coach", json=body(**kw))
    return r, fake


def test_whole_word_sends_azure_block_and_timing(tmp_path, monkeypatch):
    calls = []
    mock_assess(monkeypatch, calls=calls)
    r, fake = run(tmp_path)
    assert r.status_code == 200 and r.json()["source"] == "agent"
    azure = payload(anthropic_text(fake.calls[0]))["azure"]
    assert calls == ["track"]
    assert azure["accuracy"] == 61.0 and azure["pron"] == 70.0 and azure["passScore"] == 60.0
    assert [p["phoneme"] for p in azure["phonemes"]] == ["t", "ɹ", "æ", "k"]
    assert azure["phonemes"][1]["nbest"] == [{"phoneme": "w", "score": 60.0}]
    assert azure["zoneAccuracy"] == {"t": 90.0, "r": 35.0, "a": 80.0, "k": 20.0}
    assert "azure" in r.json()["timingsMs"]


def test_zone_mapping_by_symbol_when_counts_differ(tmp_path, monkeypatch):
    extra = AzureAssessment(phonemes=[PHONEMES[0], PHONEMES[1], PHONEMES[3]])
    mock_assess(monkeypatch, extra)
    r, fake = run(tmp_path)
    assert payload(anthropic_text(fake.calls[0]))["azure"]["zoneAccuracy"] == {"t": 90.0, "r": 35.0, "k": 20.0}


def test_full_practice_list_counts_as_whole_word(tmp_path, monkeypatch):
    calls = []
    mock_assess(monkeypatch, calls=calls)
    b = body()
    b["practiceZoneIds"] = ["t", "r", "a", "k"]
    fake = FakeClient(word_decision())
    anthropic_client(tmp_path, fake, **SETTINGS).post("/v1/live/coach", json=b)
    assert calls == ["track"]


@pytest.mark.parametrize("part", [["t", "r"], ["a"], ["k"], ["a", "k"], ["r", "a", "k"]])
def test_part_attempt_skips_azure(tmp_path, monkeypatch, part):
    calls = []
    mock_assess(monkeypatch, calls=calls)
    b = body()
    b["practiceZoneIds"] = part
    for z in b["word"]["zones"]:  # a local pass skips every cloud call, so the practised zones must not all hit
        if z["zoneId"] in part:
            z["verdict"] = "miss"
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake, **SETTINGS).post("/v1/live/coach", json=b)
    assert fake.calls
    assert calls == []
    assert "azure" not in payload(anthropic_text(fake.calls[0]))
    assert "azure" not in r.json()["timingsMs"]


def test_skipped_without_config_audio_or_usable_quality(tmp_path, monkeypatch):
    calls = []
    mock_assess(monkeypatch, calls=calls)
    fake = FakeClient(word_decision())
    anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())  # not configured
    anthropic_client(tmp_path, fake, **SETTINGS).post("/v1/live/coach", json=body(audio=False))
    anthropic_client(tmp_path, fake, **SETTINGS).post("/v1/live/coach", json=body(quality="unclear", reason="noise"))
    assert calls == []


@pytest.mark.parametrize("failure", [None, RuntimeError("boom"), "slow"])
def test_azure_failure_or_timeout_coaches_without_azure(tmp_path, monkeypatch, failure):
    if failure == "slow":
        monkeypatch.setattr(orchestrator, "_AZURE_TIMEOUT_S", 0.05)
        mock_assess(monkeypatch, delay=0.5)
    else:
        mock_assess(monkeypatch, result=failure)
    r, fake = run(tmp_path)
    assert r.status_code == 200 and r.json()["source"] == "agent"
    assert "azure" not in payload(anthropic_text(fake.calls[0]))


def test_azure_and_acoustics_run_concurrently(tmp_path, monkeypatch):
    def slow_measure(wav, zones, *_):
        time.sleep(0.4)
        return CLEAR

    monkeypatch.setattr(orchestrator, "measure_word", slow_measure)
    mock_assess(monkeypatch, delay=0.4)
    t0 = time.perf_counter()
    r, fake = run(tmp_path)
    elapsed = time.perf_counter() - t0
    assert "azure" in payload(anthropic_text(fake.calls[0])) and "acoustics" in payload(anthropic_text(fake.calls[0]))
    assert elapsed < 0.75
