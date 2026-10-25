"""Parselmouth pitch and formant table for one take, compared with a Cartesia reference.

Pitch is stored so later coaching can see the contour. Mouth and tongue cues come only from
formant or duration differences against the reference. A pitch difference by itself never
becomes a tongue or jaw instruction.
"""

import asyncio
import io
import logging
import math
import time
import wave
from typing import Any

import numpy as np

from app.audio.extract import emit_pitch_extract, emit_pitch_result, f0_summary
from app.config import Settings
from app.integrations.cartesia import cached_speech_wav

logger = logging.getLogger(__name__)

REFERENCE_WORDS = {"i": "heed", "u": "food", "a": "father"}
TIME_STEP_S = 0.01
MAX_ROWS = 40
MIN_VOICED = 8
FORMANT_RATIO = 0.15
SHORT_RATIO = 0.65

_CUES = {
    "finish": "Compared with the reference {word}, the sound stopped early. Keep going through the end of the word.",
    "mouth_more_open": "Compared with the reference {word}, your mouth stayed a little more closed. Open your mouth a little more.",
    "mouth_less_open": "Compared with the reference {word}, your mouth opened a little more. You can close it a little.",
    "tongue_forward": "Compared with the reference {word}, your tongue sat a little further back. Move your tongue a little forward.",
    "tongue_back": "Compared with the reference {word}, your tongue sat a little further forward. Move your tongue a little back.",
}


def read_pcm16(wav: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(wav), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        if handle.getsampwidth() != 2:
            raise ValueError("pcm16")
        raw = handle.readframes(handle.getnframes())
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def _finite(value: float) -> float | None:
    if value is None or not math.isfinite(value) or value <= 0:
        return None
    return round(float(value), 1)


def extract_table(samples: np.ndarray, rate: int, pitch_out: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """One row per 10 ms: time, pitch, F1, F2, voiced. Missing measurements stay null.

    When `pitch_out` is given it is filled with f0_summary() over every frame (not only the stored rows),
    for telemetry only.
    """
    if samples.size < int(rate * 0.06):
        return None
    import parselmouth

    sound = parselmouth.Sound(samples, sampling_frequency=rate)
    ceiling = 5500 if rate >= 11025 else 5000
    try:
        pitch = sound.to_pitch_ac(time_step=TIME_STEP_S, pitch_floor=75, pitch_ceiling=500)
        formants = sound.to_formant_burg(
            time_step=TIME_STEP_S,
            max_number_of_formants=5,
            maximum_formant=ceiling,
            window_length=0.025,
            pre_emphasis_from=50,
        )
    except parselmouth.PraatError:
        return None
    measured = []
    count = pitch.get_number_of_frames()
    for index in range(1, count + 1):
        t = pitch.get_time_from_frame_number(index)
        hz = _finite(pitch.get_value_at_time(t))
        f1 = _finite(formants.get_value_at_time(1, t))
        f2 = _finite(formants.get_value_at_time(2, t))
        if f1 is not None and not (150 <= f1 <= 1300):
            f1 = None
        if f2 is not None and not (f1 or 0) + 150 < f2 <= 4000:
            f2 = None
        measured.append({"tMs": round(t * 1000), "f0Hz": hz, "f1Hz": f1, "f2Hz": f2, "voiced": hz is not None})
    voiced_rows = [row for row in measured if row["voiced"]]
    if pitch_out is not None:
        pitch_out.update(f0_summary(np.array([row["f0Hz"] or 0.0 for row in measured], dtype=np.float64)))
    step = max(1, math.ceil(len(measured) / MAX_ROWS))
    return {
        "rows": measured[::step][:MAX_ROWS],
        "voicedFrames": len(voiced_rows),
        "voicedMs": round(len(voiced_rows) * TIME_STEP_S * 1000),
        "f0Hz": _median([row["f0Hz"] for row in voiced_rows]),
        "f1Hz": _median([row["f1Hz"] for row in voiced_rows]),
        "f2Hz": _median([row["f2Hz"] for row in voiced_rows]),
    }


def _median(values: list[float | None]) -> float | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    mid = len(clean) // 2
    if len(clean) % 2:
        return clean[mid]
    return round((clean[mid - 1] + clean[mid]) / 2, 1)


def choose_cue(learner: dict, reference: dict | None) -> str | None:
    """The one instruction the measurements support, or None."""
    if reference is None or learner.get("voicedFrames", 0) < MIN_VOICED or reference.get("voicedFrames", 0) < MIN_VOICED:
        return None
    learner_ms = learner.get("voicedMs") or 0
    reference_ms = reference.get("voicedMs") or 0
    if reference_ms > 0 and learner_ms / reference_ms < SHORT_RATIO:
        return "finish"
    gaps = []
    f1_l, f1_r = learner.get("f1Hz"), reference.get("f1Hz")
    f2_l, f2_r = learner.get("f2Hz"), reference.get("f2Hz")
    if f1_l and f1_r:
        ratio = (f1_l - f1_r) / f1_r
        if ratio <= -FORMANT_RATIO:
            gaps.append((abs(ratio), "mouth_more_open"))
        elif ratio >= FORMANT_RATIO:
            gaps.append((abs(ratio), "mouth_less_open"))
    if f2_l and f2_r:
        ratio = (f2_l - f2_r) / f2_r
        if ratio <= -FORMANT_RATIO:
            gaps.append((abs(ratio), "tongue_forward"))
        elif ratio >= FORMANT_RATIO:
            gaps.append((abs(ratio), "tongue_back"))
    if not gaps:
        return None
    gaps.sort(reverse=True)
    return gaps[0][1]


def cue_line(word: str, cue: str) -> str:
    return _CUES[cue].format(word=word)


def compare_wav(settings: Settings, wav: bytes, sound: str, word: str | None = None) -> dict[str, Any] | None:
    """Learner table plus the Cartesia reference table for this word, when a key is configured."""
    stats: dict[str, Any] = {}
    try:
        samples, rate = read_pcm16(wav)
        emit_pitch_extract(round(samples.size / rate, 2) if rate else None, "praat", "praat measure")
        started = time.perf_counter()
        learner = extract_table(samples, rate, stats)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pitch table skipped: %s", type(exc).__name__)
        return None
    if learner is None:
        return None
    if stats:
        emit_pitch_result(
            {**stats, "f1Hz": learner.get("f1Hz"), "f2Hz": learner.get("f2Hz")}, time.perf_counter() - started, "praat"
        )
    word = word or REFERENCE_WORDS.get(sound, sound)
    reference = _reference_table(settings, word)
    cue = choose_cue(learner, reference)
    return {
        "source": "parselmouth",
        "word": word,
        "learner": learner,
        "reference": reference,
        "cue": cue,
    }


def _reference_table(settings: Settings, word: str) -> dict[str, Any] | None:
    if not settings.cartesia_api_key:
        return None
    try:
        wav = cached_speech_wav(settings, word)
        samples, rate = read_pcm16(wav)
        return extract_table(samples, rate)
    except Exception as exc:  # noqa: BLE001
        logger.warning("reference pitch table skipped: %s", type(exc).__name__)
        return None


WORD_MATCH = "head"
_NO_REFERENCE = "I saved your take of {word}, but the reference voice is not available, so I will not guess a mouth or tongue change."
_TOO_QUIET = "I did not catch enough of {word} to compare it with the reference. Try the word once more."
_CLOSE = "Compared with the reference {word}, this take is close enough that I would not change your mouth or tongue yet."


def _brief(table: dict[str, Any] | None) -> dict[str, Any] | None:
    if not table:
        return None
    return {key: table.get(key) for key in ("voicedMs", "voicedFrames", "f0Hz", "f1Hz", "f2Hz")}


async def advise_word(settings: Settings, client, wav: bytes, word: str = WORD_MATCH) -> dict[str, Any]:
    """Compare one word with the Cartesia reference and keep the table for storage."""
    if word != WORD_MATCH:
        raise ValueError("word")
    table = await asyncio.to_thread(compare_wav, settings, wav, "a", word)
    if table is None or table["learner"].get("voicedFrames", 0) < MIN_VOICED:
        return {
            "word": word,
            "advice": _TOO_QUIET.format(word=word),
            "source": "fallback",
            "cue": None,
            "learner": _brief(None if table is None else table["learner"]),
            "reference": None,
            "features": None if table is None else features_from_table(table),
        }
    cue = table["cue"]
    if table["reference"] is None:
        advice, source = _NO_REFERENCE.format(word=word), "fallback"
    elif cue is None:
        advice, source = _CLOSE.format(word=word), "fallback"
    else:
        advice, source = await phrase_cue(settings, client, word, cue)
    return {
        "word": word,
        "advice": advice,
        "source": source,
        "cue": cue,
        "learner": _brief(table["learner"]),
        "reference": _brief(table["reference"]),
        "features": features_from_table(table),
    }


def features_from_table(table: dict[str, Any]) -> dict[str, Any]:
    """Shape stored on the attempt. Claims stay empty: this path does not invent a SPARC claim."""
    return {"quality": "ok", "source": "parselmouth", "claims": [], "pitchTable": table}


_ALLOWED = {
    "finish": ("end", "through", "finish"),
    "mouth_more_open": ("open", "mouth"),
    "mouth_less_open": ("close", "mouth"),
    "tongue_forward": ("forward", "tongue"),
    "tongue_back": ("back", "tongue"),
}
_FORBIDDEN = {
    "finish": ("tongue", "mouth"),
    "mouth_more_open": ("tongue",),
    "mouth_less_open": ("tongue",),
    "tongue_forward": ("mouth",),
    "tongue_back": ("mouth",),
}


def line_ok(text: str, cue: str, word: str) -> bool:
    lowered = (text or "").lower()
    if not lowered or len(lowered) > 280 or any(ch.isdigit() for ch in lowered):
        return False
    if word.lower() not in lowered and "reference" not in lowered:
        return False
    if any(word in lowered for word in ("wrong", "bad", "fail", "incorrect")):
        return False
    if any(word in lowered for word in _FORBIDDEN[cue]):
        return False
    return all(word in lowered for word in _ALLOWED[cue])


async def phrase_cue(settings: Settings, client, word: str, cue: str) -> tuple[str, str]:
    """Claude may rephrase the chosen cue. A line that adds another body part is dropped."""
    template = cue_line(word, cue)
    if client is None and not settings.anthropic_configured:
        return template, "fallback"
    from pydantic import BaseModel, Field

    from app.live import llm

    class Draft(BaseModel):
        say: str = Field(max_length=280)

    prompt = (
        "Rewrite the coach line in one or two sentences. Keep the same comparison and the same instruction. "
        "Do not add a body part that is not already in the line. Do not write digits. "
        f"Line: {template}"
    )
    try:
        draft = await llm.ask(
            settings,
            client,
            "You rephrase a speech-practice cue. You do not add new advice.",
            prompt,
            Draft,
            settings.live_coach_effort,
            settings.live_coach_timeout_s,
            400,
        )
        say = draft.say.strip()
        if line_ok(say, cue, word):
            return say, "agent"
    except Exception as exc:  # noqa: BLE001
        logger.warning("pitch cue used template: %s", type(exc).__name__)
    return template, "fallback"
