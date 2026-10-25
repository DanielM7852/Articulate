"""Azure Pronunciation Assessment client: request shape, parsing, part scoring, never raises. No network."""

import asyncio
import base64
import io
import json
import wave

import httpx
import numpy as np
import pytest

from app.audio import azure_pronunciation as az
from tests.support import make_settings

RATE = 16000


def wav(rate=RATE, channels=1):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.ones(rate * channels // 2) * 1000).astype("<i2").tobytes())
    return buf.getvalue()


def ph(symbol, acc, nbest=None, offset=1_000_000, duration=500_000):
    return {
        "Phoneme": symbol, "Offset": offset, "Duration": duration,
        "PronunciationAssessment": {"AccuracyScore": acc, "NBestPhonemes": nbest or [{"Phoneme": symbol, "Score": 90.0}]},
    }


def sample(t=82.0, r=64.0, k=71.0, status="Success", error="None"):
    """Shaped after the Microsoft Learn short-audio pronunciation-assessment response, phoneme granularity."""
    return {
        "RecognitionStatus": status, "Offset": 700000, "Duration": 8400000, "DisplayText": "Track.",
        "NBest": [{
            "Confidence": 0.9, "Lexical": "track", "Display": "Track.",
            "AccuracyScore": 80.0, "FluencyScore": 100.0, "CompletenessScore": 100.0, "PronScore": 86.0,
            "Words": [{
                "Word": "track", "Offset": 700000, "Duration": 8000000, "AccuracyScore": 79.0, "ErrorType": error,
                "Phonemes": [
                    ph("t", t, [{"Phoneme": "t", "Score": 80.0}, {"Phoneme": "d", "Score": 12.0}]),
                    ph("ɹ", r), ph("æ", 90.0), ph("k", k),
                ],
            }],
        }],
    }


def settings(tmp_path, **kw):
    return make_settings(tmp_path, azure_speech_key="secret-key", azure_speech_region="westus2", **kw)


def run_assess(tmp_path, handler, audio=None, **kw):
    seen = []

    def wrapped(request):
        seen.append(request)
        return handler(request)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(wrapped)) as http:
            return await az.assess(audio or wav(), "track", settings(tmp_path, **kw), http=http)

    return asyncio.run(go()), seen


def raise_timeout(request):
    raise httpx.ReadTimeout("slow")


def test_not_configured_makes_no_call(tmp_path):
    def boom(request):
        raise AssertionError("no call expected")

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as http:
            return await az.assess(wav(), "track", make_settings(tmp_path, azure_speech_key="k"), http=http)

    assert asyncio.run(go()) is None


def test_request_shape_and_parse(tmp_path):
    result, seen = run_assess(tmp_path, lambda r: httpx.Response(200, json=sample()))
    req = seen[0]
    assert req.url.host == "westus2.stt.speech.microsoft.com"
    assert req.url.params["language"] == "en-US" and req.url.params["format"] == "detailed"
    assert req.headers["ocp-apim-subscription-key"] == "secret-key"
    assert req.headers["content-type"] == "audio/wav; codecs=audio/pcm; samplerate=16000"
    params = json.loads(base64.b64decode(req.headers["pronunciation-assessment"]))
    assert params == {
        "ReferenceText": "track", "GradingSystem": "HundredMark", "Granularity": "Phoneme", "Dimension": "Comprehensive",
        "EnableMiscue": True, "PhonemeAlphabet": "IPA", "NBestPhonemeCount": 5,
    }
    assert result.accuracy == 80.0 and result.fluency == 100.0 and result.completeness == 100.0 and result.pron == 86.0
    assert result.words == [{"word": "track", "errorType": "None", "accuracy": 79.0}]
    assert [p["phoneme"] for p in result.phonemes] == ["t", "ɹ", "æ", "k"]
    first = result.phonemes[0]
    assert first["accuracy"] == 82.0 and first["offsetMs"] == 100 and first["durationMs"] == 50
    assert first["nbest"][1] == {"phoneme": "d", "score": 12.0}


def test_resamples_to_16k_mono(tmp_path):
    _, seen = run_assess(tmp_path, lambda r: httpx.Response(200, json=sample()), audio=wav(48000, 2))
    with wave.open(io.BytesIO(seen[0].content), "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2)
        assert abs(w.getnframes() - 8000) <= 2


@pytest.mark.parametrize("handler", [
    lambda r: httpx.Response(500, text="x"),
    lambda r: httpx.Response(401, text="x"),
    raise_timeout,
    lambda r: httpx.Response(200, json=sample(status="NoMatch")),
    lambda r: httpx.Response(200, text="not json"),
])
def test_failures_return_none(tmp_path, handler):
    result, seen = run_assess(tmp_path, handler)
    assert result is None and len(seen) == 1


def test_part_scores():
    a = az.parse_response(sample(t=82, r=64, k=71))
    score, found = az.part_score(a, "tr")
    assert score == 64.0 and [p["phoneme"] for p in found] == ["t", "ɹ"]
    assert az.part_score(a, "ck")[0] == 71.0


def test_part_score_accepts_r_variant_and_zero_for_missing_or_omission():
    data = sample()
    data["NBest"][0]["Words"][0]["Phonemes"][1]["Phoneme"] = "r"
    assert az.part_score(az.parse_response(data), "tr")[0] == 64.0
    data["NBest"][0]["Words"][0]["Phonemes"] = data["NBest"][0]["Words"][0]["Phonemes"][:3]
    assert az.part_score(az.parse_response(data), "ck")[0] == 0.0
    assert az.part_score(az.parse_response(sample(error="Omission")), "tr")[0] == 0.0
