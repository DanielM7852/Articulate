"""pitch.extract / pitch.result dashboard telemetry from the Praat passes that the app runs, and the pYIN tag."""

import asyncio
import json

import numpy as np
import pytest

from app import telemetry
from app.audio.extract import extract_pitch, f0_summary
from app.audio.pitch_table import compare_wav
from app.live import orchestrator
from app.live.schemas import LiveCoachRequest
from tests.support import make_settings
from tests.test_pitch_table import _sine_wav
from tests.test_telemetry import FakeClient
from tests.test_word_acoustics import REAL, RATE, body, buzz

RESULT_KEYS = {"f0Mean", "f0Min", "f0Max", "voicedPct", "latencyMs", "method"}


@pytest.fixture(autouse=True)
def _reset():
    telemetry.reset()
    yield
    telemetry.reset()


def _collect(work, expected):
    """Run `work` (a coroutine factory) with a fake telemetry client; return [(kind, label, payload)]."""

    async def run():
        fake = FakeClient()
        assert telemetry.configure(client=fake)
        value = await work()
        for _ in range(100):
            if len(fake.calls) >= expected:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.02)
        return value, [(args[2], args[3], json.loads(args[4])) for _, args in fake.calls]

    return asyncio.run(run())


def _check_result(payload, method):
    assert RESULT_KEYS <= set(payload)
    assert payload["method"] == method
    assert 0.0 <= payload["voicedPct"] <= 100.0
    assert isinstance(payload["latencyMs"], int) and payload["latencyMs"] >= 0


def test_f0_summary_ignores_unvoiced_and_reports_percent():
    s = f0_summary(np.array([0.0, np.nan, 100.0, 200.0]))
    assert s == {"f0Mean": 150.0, "f0Min": 100.0, "f0Max": 200.0, "voicedPct": 50.0}
    assert f0_summary(np.array([0.0, 0.0])) == {"f0Mean": None, "f0Min": None, "f0Max": None, "voicedPct": 0.0}
    assert f0_summary(np.array([]))["voicedPct"] == 0.0


def test_word_acoustics_emit_praat_extract_and_result(tmp_path):
    settings = make_settings(tmp_path)
    req = LiveCoachRequest.model_validate(body())
    result, events = _collect(lambda: orchestrator._measure_acoustics(settings, req, REAL), 2)
    assert result is not None and result["source"] == "praat"
    assert "pitch" not in result and "f0Mean" not in json.dumps(result)  # telemetry stats never reach the coach
    assert [e[0] for e in events] == ["pitch.extract", "pitch.result"]
    kind, label, extract = events[0]
    assert label == "praat measure" and extract == {"seconds": 1.0, "method": "praat"}
    _, label, res = events[1]
    _check_result(res, "praat")
    assert 110 <= res["f0Mean"] <= 130 and res["f0Min"] <= res["f0Mean"] <= res["f0Max"]
    assert 60 <= res["voicedPct"] <= 90  # 0.8 s of buzz in a 1.0 s clip
    assert label == f"f0 {round(res['f0Mean'])} Hz"
    for key in ("f1Hz", "f2Hz"):
        assert key not in res or isinstance(res[key], int)


def test_word_acoustics_failure_or_timeout_emits_no_result(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    req = LiveCoachRequest.model_validate(body())
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: None)
    result, events = _collect(lambda: orchestrator._measure_acoustics(settings, req, REAL), 1)
    assert result is None and [e[0] for e in events] == ["pitch.extract"]

    def slow(wav, zones, pitch_out=None):
        import time

        time.sleep(0.3)
        if pitch_out is not None:
            pitch_out.update({"f0Mean": 1.0})
        return {"source": "praat"}

    monkeypatch.setattr(orchestrator, "_ACOUSTICS_TIMEOUT_S", 0.05)
    monkeypatch.setattr(orchestrator, "measure_word", slow)
    result, events = _collect(lambda: orchestrator._measure_acoustics(settings, req, REAL), 1)
    assert result is None and [e[0] for e in events] == ["pitch.extract"]


def test_disabled_acoustics_emit_nothing(tmp_path):
    settings = make_settings(tmp_path, word_acoustics_enabled=False)
    req = LiveCoachRequest.model_validate(body())
    result, events = _collect(lambda: orchestrator._measure_acoustics(settings, req, REAL), 0)
    assert result is None and events == []


def test_pitch_table_emits_praat_extract_and_result(tmp_path):
    settings = make_settings(tmp_path)
    table, events = _collect(lambda: asyncio.to_thread(compare_wav, settings, _sine_wav(), "i"), 2)
    assert table is not None
    assert [e[0] for e in events] == ["pitch.extract", "pitch.result"]
    assert events[0][1] == "praat measure" and events[0][2] == {"seconds": 0.6, "method": "praat"}
    res = events[1][2]
    _check_result(res, "praat")
    assert 170 <= res["f0Mean"] <= 190 and res["voicedPct"] > 50
    assert res.get("f1Hz") == table["learner"]["f1Hz"] or (table["learner"]["f1Hz"] is None and "f1Hz" not in res)


def test_pitch_table_too_short_emits_no_result(tmp_path):
    settings = make_settings(tmp_path)
    table, events = _collect(lambda: asyncio.to_thread(compare_wav, settings, _sine_wav(seconds=0.03), "i"), 1)
    assert table is None and [e[0] for e in events] == ["pitch.extract"]


def test_pyin_extract_is_tagged_and_voiced_pct_is_percent(tmp_path):
    settings = make_settings(tmp_path)
    samples = buzz(0.5)
    _, events = _collect(lambda: asyncio.to_thread(extract_pitch, samples, RATE, settings), 2)
    assert [e[0] for e in events] == ["pitch.extract", "pitch.result"]
    assert events[0][2] == {"seconds": 0.5, "method": "pyin"}
    res = events[1][2]
    _check_result(res, "pyin")
    assert events[1][1] == "pitch extracted" and res["voicedPct"] > 50
