"""POST /v1/live/consonant: energy guard, audio model call, gate and fallback. No network."""

import base64
import json
import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.live.consonant import ConsonantDraft
from app.main import create_app
from tests.support import make_settings
from tests.test_openai_coach import FakeOpenAI

RATE = 16000


def wav_b64(samples: np.ndarray) -> str:
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def silent() -> str:
    return wav_b64(np.zeros(RATE))


def burst() -> str:
    """Voiceless noise burst (120 ms) after 300 ms of near silence."""
    rng = np.random.default_rng(1)
    x = rng.normal(0, 0.0004, RATE)
    x[4800:6720] = rng.normal(0, 0.15, 1920)
    return wav_b64(x)


def draft(verdict="try_again", caption="Tongue tip just behind the top teeth, then let a puff out.", cue="Pop the t, then slide into r"):
    return ConsonantDraft(verdict=verdict, caption=caption, cue=cue)


def client_for(tmp_path, fake, **settings):
    settings.setdefault("live_coach_provider", "openai")
    settings.setdefault("openai_api_key", "k")
    app = create_app(make_settings(tmp_path, **settings))
    app.state.live_openai_client = fake
    return TestClient(app)


def post(c, audio=None, **kw):
    body = {"word": "track", "part": "tr", "audioWav": audio or burst()}
    body.update(kw)
    return c.post("/v1/live/consonant", json=body)


def test_silent_clip_is_unclear_without_model(tmp_path):
    fake = FakeOpenAI(draft())
    r = post(client_for(tmp_path, fake), silent())
    j = r.json()
    assert r.status_code == 200 and j["verdict"] == "unclear" and j["fallback"] is False and j["model"] is None
    assert fake.calls == []


def test_voiceless_burst_passes_guard_and_sends_audio(tmp_path):
    fake = FakeOpenAI(draft())
    r = post(client_for(tmp_path, fake))
    j = r.json()
    assert r.status_code == 200 and j["acoustics"]["activeMs"] >= 40 and j["acoustics"]["peak"] > 0.003
    call = fake.calls[0]
    assert call["model"] == "gpt-audio-1.5"
    assert any(p.get("type") == "input_audio" for p in call["messages"][1]["content"])
    assert set(j["timingsMs"]) == {"acoustics", "model", "total"}


def test_got_it_is_returned(tmp_path):
    fake = FakeOpenAI(draft("got_it", "Nice, a clear t into r. Keep that quick puff of air.", "Keep it quick"))
    j = post(client_for(tmp_path, fake)).json()
    assert j["verdict"] == "got_it" and j["fallback"] is False and j["model"] == "gpt-audio-1.5"


@pytest.mark.parametrize("exc", [RuntimeError("boom"), TimeoutError()])
def test_model_failure_falls_back(tmp_path, exc):
    r = post(client_for(tmp_path, FakeOpenAI(exc=exc)), part="ck")
    j = r.json()
    assert r.status_code == 200 and j["verdict"] == "try_again" and j["fallback"] is True and j["model"] is None
    assert j["cue"] == "Finish with a small k puff"


@pytest.mark.parametrize("verdict,caption,cue", [
    ("try_again", "Your tongue stayed low on that one.", "Lift the tongue"),
    ("try_again", "Your lips were closed.", "Open up"),
    ("try_again", "I hear a d at the start.", "Try again"),
    ("try_again", "Great try, now lift the back of the tongue.", "Lift the back up"),
    ("try_again", "That was bad, try again.", "Try again"),
    ("try_again", "x" * 201, "Try again"),
])
def test_gate_rejections_fall_back(tmp_path, verdict, caption, cue):
    j = post(client_for(tmp_path, FakeOpenAI(draft(verdict, caption, cue)))).json()
    assert j["fallback"] is True and j["verdict"] == "try_again" and "Great" not in j["caption"]


def test_length_overruns_are_trimmed_not_rejected(tmp_path):
    caption = "Lift the back of the tongue. Stop the air. Then let it pop."
    cue = "Raise the back of your tongue, then release the air."
    j = post(client_for(tmp_path, FakeOpenAI(draft("try_again", caption, cue)))).json()
    assert j["fallback"] is False
    assert j["caption"] == "Lift the back of the tongue. Stop the air."
    assert j["cue"] == "Raise the back of your tongue, then release"


def test_validation_errors(tmp_path):
    c = client_for(tmp_path, FakeOpenAI(draft()))
    assert post(c, part="zz").status_code == 422
    assert post(c, audio="not base64!!").status_code == 422
    assert post(c, history=[{"verdict": "nope", "caption": ""}]).status_code == 422
    assert post(c, history=[{"verdict": "got_it", "caption": "x"}] * 7).status_code == 422


def test_history_reaches_model(tmp_path):
    fake = FakeOpenAI(draft())
    post(client_for(tmp_path, fake), history=[{"verdict": "try_again", "caption": "Puff of air."}])
    assert "Puff of air." in fake.calls[0]["messages"][1]["content"][0]["text"]


def test_non_openai_provider_falls_back_without_call(tmp_path):
    fake = FakeOpenAI(draft())
    c = client_for(tmp_path, fake, live_coach_provider="anthropic", anthropic_api_key="k")
    j = post(c).json()
    assert j["fallback"] is True and j["verdict"] == "try_again" and fake.calls == []


# ---- Azure Pronunciation Assessment guard ----

import httpx  # noqa: E402

from tests.test_azure_pronunciation import raise_timeout, sample  # noqa: E402


def azure_client(tmp_path, monkeypatch, fake, handler, calls=None, **settings):
    """Route the Azure client's HTTP through a mock transport. No real network."""
    real = httpx.AsyncClient

    def wrapped(request):
        if calls is not None:
            calls.append(request)
        return handler(request)

    class Mocked(real):
        def __init__(self, *a, **kw):
            kw["transport"] = httpx.MockTransport(wrapped)
            super().__init__(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", Mocked)
    settings.setdefault("azure_speech_key", "k")
    settings.setdefault("azure_speech_region", "westus2")
    return client_for(tmp_path, fake, **settings)


def ok(**kw):
    return lambda r: httpx.Response(200, json=sample(**kw))


def model_text(fake):
    return fake.calls[0]["messages"][1]["content"][0]["text"]


def test_azure_not_configured_makes_no_call_and_reports_unavailable(tmp_path):
    j = post(client_for(tmp_path, FakeOpenAI(draft()))).json()
    assert j["azure"] == {"available": False, "partScore": None, "phonemes": [], "accuracy": None,
                          "fluency": None, "completeness": None, "pron": None, "errorType": None}
    assert "azure" not in j["timingsMs"]


def test_azure_scores_reach_model_and_response(tmp_path, monkeypatch):
    fake, calls = FakeOpenAI(draft("got_it", "Nice, a clear t into r.", "Keep it quick")), []
    j = post(azure_client(tmp_path, monkeypatch, fake, ok(t=82, r=64), calls)).json()
    assert len(calls) == 1
    assert j["azure"]["available"] is True and j["azure"]["partScore"] == 64.0
    assert [p["phoneme"] for p in j["azure"]["phonemes"]] == ["t", "ɹ"]
    assert j["azure"]["phonemes"][0]["nbest"][1] == {"phoneme": "d", "score": 12.0}
    assert "azure" in j["timingsMs"]
    ev = json.loads(model_text(fake))["azure"]
    assert ev["partScore"] == 64.0 and ev["passScore"] == 60.0 and ev["phonemes"][0]["nbest"][1]["phoneme"] == "d"
    assert any(p.get("type") == "input_audio" for p in fake.calls[0]["messages"][1]["content"])


def test_low_azure_score_overrides_got_it_and_replaces_praise(tmp_path, monkeypatch):
    fake = FakeOpenAI(draft("got_it", "Nice, a clear t into r.", "Keep it quick"))
    j = post(azure_client(tmp_path, monkeypatch, fake, ok(t=82, r=40))).json()
    assert j["verdict"] == "try_again" and j["fallback"] is False
    assert "Nice" not in j["caption"] and j["cue"] == "Keep it quick"
    assert j["azure"]["partScore"] == 40.0


def test_omission_scores_zero_and_blocks_got_it(tmp_path, monkeypatch):
    fake = FakeOpenAI(draft("got_it", "Good, a clear k at the end.", "Keep it quick"))
    j = post(azure_client(tmp_path, monkeypatch, fake, ok(error="Omission")), part="ck").json()
    assert j["azure"]["partScore"] == 0.0 and j["verdict"] == "try_again"


def test_high_azure_score_keeps_got_it(tmp_path, monkeypatch):
    fake = FakeOpenAI(draft("got_it", "Nice, a clear t into r.", "Keep it quick"))
    j = post(azure_client(tmp_path, monkeypatch, fake, ok(t=82, r=70))).json()
    assert j["verdict"] == "got_it" and "Nice" in j["caption"]


def test_azure_try_again_is_not_changed(tmp_path, monkeypatch):
    j = post(azure_client(tmp_path, monkeypatch, FakeOpenAI(draft()), ok(r=10))).json()
    assert j["verdict"] == "try_again" and j["caption"] == draft().caption


@pytest.mark.parametrize("handler", [lambda r: httpx.Response(500, text="x"), raise_timeout])
def test_azure_failure_still_calls_model(tmp_path, monkeypatch, handler):
    fake = FakeOpenAI(draft("got_it", "Nice, a clear t into r.", "Keep it quick"))
    j = post(azure_client(tmp_path, monkeypatch, fake, handler)).json()
    assert j["azure"]["available"] is False and j["azure"]["partScore"] is None
    assert len(fake.calls) == 1 and "azure" not in json.loads(model_text(fake))
    assert j["verdict"] == "got_it"


def test_model_failure_keeps_azure_block(tmp_path, monkeypatch):
    j = post(azure_client(tmp_path, monkeypatch, FakeOpenAI(exc=RuntimeError("boom")), ok())).json()
    assert j["fallback"] is True and j["verdict"] == "try_again" and j["azure"]["available"] is True


def test_silent_clip_skips_azure_and_model(tmp_path, monkeypatch):
    fake, calls = FakeOpenAI(draft()), []
    j = post(azure_client(tmp_path, monkeypatch, fake, ok(), calls), silent()).json()
    assert j["verdict"] == "unclear" and calls == [] and fake.calls == [] and j["azure"]["available"] is False
