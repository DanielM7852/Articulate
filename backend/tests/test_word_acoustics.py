"""Word acoustics (Praat) unit tests with synthetic WAVs, and the orchestrator wiring with fake model clients."""

import base64
import io
import json
import time
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.audio.word_acoustics import measure_word
from app.live import orchestrator
from app.live.schemas import WordZoneResult
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import FakeClient
from tests.test_live_word import MISSING_CK, attempt_dict, coach_body, word_decision
from tests.test_openai_coach import FakeOpenAI, client_for

RATE = 16000


def wav_bytes(samples: np.ndarray, rate: int = RATE, width: int = 2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(width)
        w.setframerate(rate)
        if width == 2:
            w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        else:
            w.writeframes(((np.clip(samples, -1, 1) * 127) + 128).astype("u1").tobytes())
    return buf.getvalue()


def buzz(seconds: float, f0: float = 120.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    x = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 20))
    return amp * x / np.max(np.abs(x))


def zone(zid, kind, start, end, phoneme="a"):
    return WordZoneResult(zoneId=zid, phoneme=phoneme, kind=kind, verdict="skipped", dwellMs=0, startMs=start, endMs=end)


def test_silence_is_not_clear():
    r = measure_word(wav_bytes(np.zeros(RATE)), [])
    assert r["speech"]["clear"] is False and r["speech"]["onsetMs"] is None and r["source"] == "praat"


def test_buzz_with_lead_is_clear_and_onset_close():
    lead = 0.25
    x = np.concatenate([np.zeros(int(lead * RATE)), buzz(1.0)])
    r = measure_word(wav_bytes(x), [zone("v", "vowel", 0, 400)])
    assert r["speech"]["clear"] is True
    assert abs(r["speech"]["onsetMs"] - 250) <= 40
    assert r["speech"]["clipMs"] == 1250
    assert r["zones"]["v"]["voicedMs"] > 300


def noise(seconds: float, band: str) -> np.ndarray:
    rng = np.random.default_rng(1)
    n = int(seconds * RATE)
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    spec[(freqs < 3000) if band == "high" else (freqs > 1500)] = 0
    x = np.fft.irfft(spec, n)
    return 0.3 * x / np.max(np.abs(x))


def test_fricative_cog_higher_for_high_passed_noise():
    zones = [zone("s", "fricative", 0, 300, "s")]
    lead = np.zeros(int(0.1 * RATE))
    hi = measure_word(wav_bytes(np.concatenate([lead, noise(0.5, "high")])), zones)
    lo = measure_word(wav_bytes(np.concatenate([lead, noise(0.5, "low")])), zones)
    assert hi["zones"]["s"]["cogHz"] > lo["zones"]["s"]["cogHz"] + 1000


def test_nasal_low_band_ratio():
    x = np.concatenate([np.zeros(int(0.1 * RATE)), buzz(0.6, 120)])
    r = measure_word(wav_bytes(x), [zone("n", "nasal", 100, 400, "n")])
    assert 0 <= r["zones"]["n"]["lowBandRatio"] <= 1
    assert r["zones"]["n"]["voicedFraction"] > 0.5


def test_zone_windows_outside_clip_or_without_times_are_omitted():
    x = np.concatenate([np.zeros(int(0.2 * RATE)), buzz(0.8)])
    zones = [
        zone("ok", "vowel", 0, 300),
        zone("late", "vowel", 5000, 5400),
        zone("none", "vowel", None, None),
        zone("half", "vowel", 100, None),
        zone("short", "vowel", 100, 110),
        zone("stop", "stop", 0, 300, "t"),
    ]
    r = measure_word(wav_bytes(x), zones)
    assert list(r["zones"]) == ["ok"]


def test_liquid_f3_drop_is_relative_to_vowel_f3():
    x = np.concatenate([np.zeros(int(0.1 * RATE)), buzz(1.2)])
    r = measure_word(wav_bytes(x), [zone("v", "vowel", 0, 500), zone("r", "liquid", 500, 900, "r")])
    liquid = r["zones"]["r"]
    assert set(liquid) == {"f3Hz", "f3MinHz", "f3Drop"}
    if liquid["f3Drop"] is not None:
        assert liquid["f3MinHz"] / r["zones"]["v"]["f3Hz"] == pytest.approx(liquid["f3Drop"], abs=0.2)


@pytest.mark.parametrize("data", [b"garbage", b"", b"RIFF" + bytes(60), wav_bytes(buzz(0.5), width=1)])
def test_garbage_and_8bit_return_none(data):
    assert measure_word(data, [zone("v", "vowel", 0, 300)]) is None


def test_seven_second_clip_is_fast():
    x = np.concatenate([np.zeros(int(0.25 * RATE)), buzz(6.0), np.zeros(int(0.75 * RATE))])
    wav = wav_bytes(x)
    zones = [zone("v", "vowel", 0, 2000), zone("r", "liquid", 2000, 3000, "r"), zone("s", "fricative", 3000, 4000, "s")]
    measure_word(wav, zones)
    t0 = time.perf_counter()
    r = measure_word(wav, zones)
    elapsed = time.perf_counter() - t0
    print(f"7 s clip measured in {elapsed * 1000:.0f} ms")
    assert r is not None and elapsed < 1.0


# ---- orchestrator wiring ----

REAL = wav_bytes(np.concatenate([np.zeros(int(0.2 * RATE)), buzz(0.8)]))
AUDIO = {"format": "wav", "data": base64.b64encode(REAL).decode("ascii"), "durationMs": 1000}
CLEAR = {"source": "praat", "speech": {"clear": True, "voicedMs": 600, "onsetMs": 200, "clipMs": 1000}, "zones": {}}
UNCLEAR = {"source": "praat", "speech": {"clear": False, "voicedMs": 0, "onsetMs": None, "clipMs": 1000}, "zones": {}}


def body(audio=True, **kw):
    b = coach_body(attempt_dict(**{**MISSING_CK, **kw}))
    if audio:
        b["attemptAudio"] = AUDIO
    return b


def anthropic_client(tmp_path, fake, **s):
    app = create_app(make_settings(tmp_path, anthropic_api_key="k", **s))
    app.state.live_client = fake
    return TestClient(app)


def anthropic_text(call):
    return call["messages"][0]["content"]


def openai_text(call):
    content = call["messages"][1]["content"]
    return content if isinstance(content, str) else content[0]["text"]


def payload(text):
    return json.loads(text[text.index("{"):])


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_acoustics_in_word_message_when_audio_sent(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: CLEAR)
    if provider == "anthropic":
        fake = FakeClient(word_decision())
        r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())
        text = anthropic_text(fake.calls[0])
    else:
        fake = FakeOpenAI(word_decision())
        r = client_for(tmp_path, fake).post("/v1/live/coach", json=body())
        text = openai_text(fake.calls[0])
    assert r.status_code == 200 and r.json()["source"] == "agent"
    assert payload(text)["acoustics"] == CLEAR
    assert "acoustics" in r.json()["timingsMs"]


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_no_acoustics_without_audio(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: pytest.fail("measured without audio"))
    if provider == "anthropic":
        fake = FakeClient(word_decision())
        anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body(audio=False))
        text = anthropic_text(fake.calls[0])
    else:
        fake = FakeOpenAI(word_decision())
        client_for(tmp_path, fake).post("/v1/live/coach", json=body(audio=False))
        text = openai_text(fake.calls[0])
    assert "acoustics" not in payload(text)


def test_real_measurement_reaches_the_model(tmp_path):
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())
    assert r.status_code == 200
    ac = payload(anthropic_text(fake.calls[0]))["acoustics"]
    assert ac["source"] == "praat" and ac["speech"]["clear"] is True


def test_setting_off_skips_acoustics(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: pytest.fail("measured while disabled"))
    fake = FakeClient(word_decision())
    anthropic_client(tmp_path, fake, word_acoustics_enabled=False).post("/v1/live/coach", json=body())
    assert "acoustics" not in payload(anthropic_text(fake.calls[0]))


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_unclear_speech_with_usable_board_skips_the_model(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: UNCLEAR)
    fake = FakeClient(word_decision()) if provider == "anthropic" else FakeOpenAI(word_decision())
    c = anthropic_client(tmp_path, fake) if provider == "anthropic" else client_for(tmp_path, fake)
    data = c.post("/v1/live/coach", json=body()).json()
    assert not fake.calls
    assert data["source"] == "fallback" and data["nextAction"] == "retry" and data["cueId"] is None
    assert data["word"]["verdict"] == "insufficient"
    assert "clear and steady" in data["caption"]


def test_unclear_speech_with_unclear_board_quality_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: UNCLEAR)
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body(quality="unclear", reason="silence"))
    assert r.json()["word"]["verdict"] == "insufficient"


def test_measure_raising_or_timing_out_coaches_without_acoustics(tmp_path, monkeypatch):
    def boom(wav, zones, *_):
        raise RuntimeError("praat")

    monkeypatch.setattr(orchestrator, "measure_word", boom)
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())
    assert r.json()["source"] == "agent" and "acoustics" not in payload(anthropic_text(fake.calls[0]))

    monkeypatch.setattr(orchestrator, "_ACOUSTICS_TIMEOUT_S", 0.05)
    monkeypatch.setattr(orchestrator, "measure_word", lambda wav, zones, *_: time.sleep(0.4) or CLEAR)
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())
    assert r.json()["source"] == "agent" and "acoustics" not in payload(anthropic_text(fake.calls[0]))
