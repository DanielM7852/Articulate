"""Azure Speech Pronunciation Assessment (REST API for short audio) for one short clip.

Docs: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
      https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment

assess() never raises: not configured, timeout, transport error, non-200 or a failed recognition all return None.
Only status codes and exception types are logged, never the key, the audio or the response body.

Dashboard telemetry (docs/telemetry.md, kind-routed, backend -> db): azure.request {word} before the call,
azure.result {ms, ok, accuracy} after a parsed assessment, azure.error {ms, error} on a failure. Callers emit
azure.skipped {reason} when they do not call. No transcript, audio or per-phoneme score is ever sent.
"""

import base64
import io
import json
import logging
import time
import wave
from dataclasses import dataclass, field
from typing import Any

import httpx
import numpy as np

from app import telemetry
from app.audio.word_acoustics import _read_pcm16
from app.config import Settings

logger = logging.getLogger(__name__)

TARGET_RATE = 16000
_TICKS_PER_MS = 10_000  # Azure offsets and durations are 100 ns units
_R_PHONEMES = {"r", "ɹ", "ɻ", "ɾ", "ʀ", "ʁ"}


@dataclass
class AzureAssessment:
    accuracy: float | None = None
    fluency: float | None = None
    completeness: float | None = None
    pron: float | None = None
    words: list[dict[str, Any]] = field(default_factory=list)  # {word, errorType, accuracy}
    phonemes: list[dict[str, Any]] = field(default_factory=list)  # {phoneme, accuracy, offsetMs, durationMs, nbest}


def configured(settings: Settings) -> bool:
    return bool(settings.azure_speech_key and settings.azure_speech_region)


def _emit(kind: str, label: str, payload: dict[str, Any]) -> None:
    try:
        telemetry.emit("backend", "db", kind, label, payload)
    except Exception:  # noqa: BLE001 - telemetry never affects the assessment
        pass


def emit_skipped(reason: str, **extra: Any) -> None:
    """azure.skipped {reason, ...}: the caller decided not to call Azure, or gave up waiting. Never raises."""
    _emit("azure.skipped", f"azure skipped: {reason}", {"reason": reason, **extra})


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def to_16k_mono_wav(wav: bytes) -> bytes:
    """PCM16 WAV at 16 kHz mono. Already-conforming input is returned unchanged."""
    with wave.open(io.BytesIO(wav), "rb") as handle:
        if handle.getframerate() == TARGET_RATE and handle.getnchannels() == 1 and handle.getsampwidth() == 2:
            return wav
    samples, rate = _read_pcm16(wav)
    if rate != TARGET_RATE and samples.size and rate > 0:
        n = max(1, int(round(samples.size * TARGET_RATE / rate)))
        samples = np.interp(np.linspace(0, samples.size - 1, n), np.arange(samples.size), samples)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(TARGET_RATE)
        out.writeframes(pcm)
    return buf.getvalue()


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _pa(node: dict[str, Any]) -> dict[str, Any]:
    """Scores sit on the node itself (short-audio REST) or under PronunciationAssessment (SDK-shaped JSON)."""
    inner = node.get("PronunciationAssessment")
    return {**node, **inner} if isinstance(inner, dict) else node


def parse_response(data: Any) -> AzureAssessment | None:
    if not isinstance(data, dict) or data.get("RecognitionStatus") != "Success":
        return None
    nbest = data.get("NBest")
    if not isinstance(nbest, list) or not nbest or not isinstance(nbest[0], dict):
        return None
    top = _pa(nbest[0])
    result = AzureAssessment(
        accuracy=_num(top.get("AccuracyScore")),
        fluency=_num(top.get("FluencyScore")),
        completeness=_num(top.get("CompletenessScore")),
        pron=_num(top.get("PronScore")),
    )
    for word in nbest[0].get("Words") or []:
        if not isinstance(word, dict):
            continue
        w = _pa(word)
        result.words.append({"word": str(word.get("Word", "")), "errorType": w.get("ErrorType"), "accuracy": _num(w.get("AccuracyScore"))})
        for ph in word.get("Phonemes") or []:
            if not isinstance(ph, dict):
                continue
            p = _pa(ph)
            alts = [
                {"phoneme": str(a.get("Phoneme", "")), "score": _num(a.get("Score"))}
                for a in (p.get("NBestPhonemes") or [])
                if isinstance(a, dict)
            ]
            offset, duration = _num(ph.get("Offset")), _num(ph.get("Duration"))
            result.phonemes.append({
                "phoneme": str(ph.get("Phoneme", "")),
                "accuracy": _num(p.get("AccuracyScore")),
                "offsetMs": None if offset is None else int(round(offset / _TICKS_PER_MS)),
                "durationMs": None if duration is None else int(round(duration / _TICKS_PER_MS)),
                "nbest": alts,
            })
    return result


def _header(reference_text: str) -> str:
    params = {
        "ReferenceText": reference_text,
        "GradingSystem": "HundredMark",
        "Granularity": "Phoneme",
        "Dimension": "Comprehensive",
        "EnableMiscue": True,
        "PhonemeAlphabet": "IPA",
        "NBestPhonemeCount": 5,
    }
    return base64.b64encode(json.dumps(params, separators=(",", ":")).encode("utf-8")).decode("ascii")


async def assess(
    wav_bytes: bytes,
    reference_text: str,
    settings: Settings,
    http: httpx.AsyncClient | None = None,
) -> AzureAssessment | None:
    if not configured(settings):
        return None
    own = http is None
    client = http or httpx.AsyncClient(timeout=settings.azure_pronunciation_timeout_s)
    word = str(reference_text)[:40]
    _emit("azure.request", f"azure assess {word}", {"word": word})
    started = time.perf_counter()
    try:
        audio = to_16k_mono_wav(wav_bytes)
        url = f"https://{settings.azure_speech_region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1"
        response = await client.post(
            url,
            params={"language": "en-US", "format": "detailed"},
            headers={
                "Ocp-Apim-Subscription-Key": settings.azure_speech_key or "",
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Accept": "application/json",
                "Pronunciation-Assessment": _header(reference_text),
            },
            content=audio,
            timeout=settings.azure_pronunciation_timeout_s,
        )
        if response.status_code != 200:
            logger.warning("azure pronunciation status %s", response.status_code)
            _emit("azure.error", f"azure status {response.status_code}",
                  {"ms": _elapsed_ms(started), "error": "HTTPStatusError", "status": response.status_code})
            return None
        parsed = parse_response(response.json())
        if parsed is None:
            logger.warning("azure pronunciation recognition failed")
            _emit("azure.error", "azure recognition failed", {"ms": _elapsed_ms(started), "error": "RecognitionFailed"})
            return parsed
        result: dict[str, Any] = {"ms": _elapsed_ms(started), "ok": True}
        if parsed.accuracy is not None:
            result["accuracy"] = parsed.accuracy
        _emit("azure.result", "azure assessed" if parsed.accuracy is None else f"azure accuracy {round(parsed.accuracy)}",
              result)
        return parsed
    except Exception as exc:  # noqa: BLE001 - timeout, transport, bad audio or bad JSON all mean "no assessment"
        logger.warning("azure pronunciation error: %s", type(exc).__name__)
        _emit("azure.error", f"azure error {type(exc).__name__}", {"ms": _elapsed_ms(started), "error": type(exc).__name__})
        return None
    finally:
        if own:
            await client.aclose()


def part_phonemes(assessment: AzureAssessment, part: str) -> list[dict[str, Any] | None]:
    """The practised part's phonemes of "track" (IPA t ɹ æ k); None marks one Azure did not return."""
    ph = assessment.phonemes
    if part == "ck":
        ks = [p for p in ph if p["phoneme"] == "k"]
        return [ks[-1] if ks else None]
    t = next((p for p in ph if p["phoneme"] == "t"), None)
    r = next((p for p in ph if p["phoneme"] in _R_PHONEMES), None)
    return [t, r]


def part_score(assessment: AzureAssessment, part: str) -> tuple[float, list[dict[str, Any]]]:
    """(min accuracy of the part's phonemes, those phonemes). A missing phoneme or an omitted word scores 0."""
    found = part_phonemes(assessment, part)
    present = [p for p in found if p is not None]
    omitted = any(w.get("errorType") == "Omission" for w in assessment.words)
    scores = [p["accuracy"] for p in present]
    if omitted or len(present) != len(found) or any(s is None for s in scores):
        return 0.0, present
    return float(min(scores)), present
