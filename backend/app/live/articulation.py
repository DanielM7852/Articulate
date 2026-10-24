"""Deterministic articulation features from a SPARC/Silero bundle, and a corroboration gate.

A tongue claim is emitted only when SPARC and the acoustic formants agree, relative to the
learner's own on_target attempts. When in doubt, no claim. No model involved.
"""

import math
import statistics
from typing import Any

SCHEMA = "articulate.articulation/1"
FEATURE_VERSION = 1

MIN_FRAMES = 25  # 0.5 s of 20 ms EMA frames
# Contract said 0.4, but the 3.6 s calibration clips (three words with silence between) measure 0.33-0.37.
MIN_SPEECH_FRACTION = 0.25
MAX_CLIPPED_FRACTION = 0.01
# Interquartile range of tongue-body height (TBY) across selected frames. The word-level synthetic
# fixtures (heed/hod/who'd, consonants included) measure 0.86-2.25, so 3.0 only rejects trajectories
# wandering far more than a sustained vowel plus its consonants would.
MAX_IQR = 3.0

# Minimum SPARC change (EMA units) versus the learner's own on_target anchor to count as a real shift.
TONGUE_DELTA = 0.35
# Minimum log-ratio formant change versus the anchor (~8%) that must agree in direction with SPARC.
FORMANT_DELTA = 0.08
ANCHOR_COUNT = 3
CLAIM_VERDICTS = ("close", "off")

_FEATURES = ("tongueHeight", "tongueFront", "jawOpen", "lipForward", "lipAperture")
_CHANNELS = ("TBX", "TBY", "LIY", "ULX", "ULY", "LLX", "LLY")


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _r(value: float | None) -> float | None:
    return None if value is None else round(float(value), 3)


def _iqr(values: list[float]) -> float:
    q = statistics.quantiles(values, n=4, method="inclusive")
    return q[2] - q[0]


def _empty(vad: bool, speech_ms: float | None, fraction: float | None, reason: str) -> dict:
    return {
        "v": FEATURE_VERSION, "frames": 0, "speechMs": _r(speech_ms), "speechFraction": _r(fraction),
        "vad": vad, **{k: None for k in _FEATURES}, "tongueHeightIqr": None, "tongueFrontIqr": None,
        "quality": "insufficient", "reason": reason,
    }


def _speech_frames(ema: dict, segments: list[tuple[float, float]] | None) -> list[list[float]]:
    channels = ema.get("channels")
    values, stamps, within = ema.get("values"), ema.get("timestampsMs"), ema.get("withinAudio")
    if not (isinstance(channels, list) and isinstance(values, list) and isinstance(stamps, list)):
        return []
    if not isinstance(within, list) or any(n not in channels for n in _CHANNELS):
        return []
    idx = [channels.index(n) for n in _CHANNELS]
    rows = []
    for i, row in enumerate(values):
        t = _num(stamps[i]) if i < len(stamps) else None
        if t is None or not isinstance(row, list) or i >= len(within) or within[i] is not True:
            continue
        if segments is not None and not any(a <= t <= b for a, b in segments):
            continue
        try:
            picked = [_num(row[j]) for j in idx]
        except IndexError:
            continue
        if None not in picked:
            rows.append(picked)
    return rows


def _segments(vad_model: dict) -> list[tuple[float, float]]:
    out = []
    for s in vad_model.get("segments") or []:
        if not isinstance(s, dict):
            continue
        a, b = _num(s.get("startMs")), _num(s.get("endMs"))
        if a is not None and b is not None and b >= a:
            out.append((a, b))
    return out


def extract_features(bundle: dict) -> dict | None:
    """Compact per-attempt articulation features, or None when SPARC is unavailable."""
    if not isinstance(bundle, dict) or bundle.get("schemaVersion") != SCHEMA:
        return None
    models = bundle.get("models")
    sparc = models.get("sparc") if isinstance(models, dict) else None
    if not isinstance(sparc, dict) or sparc.get("status") != "ok":
        return None
    series = sparc.get("series")
    ema = series.get("ema") if isinstance(series, dict) else None
    if not isinstance(ema, dict) or not ema.get("values"):
        return None

    audio = bundle.get("audio") if isinstance(bundle.get("audio"), dict) else {}
    duration = _num(audio.get("durationMs"))
    clipped = _num(audio.get("clippedFraction")) or 0.0

    vad_model = models.get("silero_vad")
    vad = isinstance(vad_model, dict) and vad_model.get("status") == "ok"
    segments: list[tuple[float, float]] | None = None
    speech_ms = fraction = None
    if vad:
        segments = _segments(vad_model)
        speech_ms = sum(b - a for a, b in segments)
        fraction = speech_ms / duration if duration else 0.0

    rows = _speech_frames(ema, segments)
    if not rows:
        return _empty(vad, speech_ms, fraction, "no_speech" if vad and not segments else "no_frames")

    tbx, tby, liy, ulx, uly, llx, lly = (list(c) for c in zip(*rows))
    med = statistics.median
    height_iqr = _iqr(tby)
    out = {
        "v": FEATURE_VERSION, "frames": len(rows), "speechMs": _r(speech_ms), "speechFraction": _r(fraction),
        "vad": vad,
        "tongueHeight": _r(med(tby)), "tongueFront": _r(-med(tbx)), "jawOpen": _r(-med(liy)),
        "lipForward": _r(-med([(a + b) / 2 for a, b in zip(ulx, llx)])),
        "lipAperture": _r(med([a - b for a, b in zip(uly, lly)])),
        "tongueHeightIqr": _r(height_iqr), "tongueFrontIqr": _r(_iqr(tbx)),
        "quality": "ok", "reason": None,
    }
    reason = None
    if len(rows) < MIN_FRAMES:
        reason = "too_short"
    elif fraction is not None and fraction < MIN_SPEECH_FRACTION:
        reason = "low_speech"
    elif clipped > MAX_CLIPPED_FRACTION:
        reason = "clipped"
    elif height_iqr > MAX_IQR:
        reason = "unstable_tongue"
    if reason:
        out.update(quality="insufficient", reason=reason)
    return out


def _artic_ok(a: Any) -> bool:
    return isinstance(a, dict) and a.get("quality") == "ok"


def _anchor_median(values: list[Any]) -> float | None:
    nums = [v for v in (_num(x) for x in values) if v is not None]
    return statistics.median(nums) if nums else None


def _claim(dimension: str, direction: str, ids: list, sparc: float, formant: float) -> dict:
    return {
        "part": "tongue", "dimension": dimension, "direction": direction, "comparedTo": ids,
        "sparcDelta": round(sparc, 3), "formantDelta": round(formant, 3),
    }


def _claims(attempt: dict, older: list[Any]) -> list[dict]:
    if attempt.get("audioVerdict") not in CLAIM_VERDICTS:
        return []
    artic = attempt["artic"]
    f1, f2 = _num(attempt.get("f1Offset")), _num(attempt.get("f2Offset"))
    height, front = _num(artic.get("tongueHeight")), _num(artic.get("tongueFront"))
    anchors = [
        o for o in older
        if isinstance(o, dict) and o.get("sound") == attempt.get("sound") and o.get("audioVerdict") == "on_target"
        and _artic_ok(o.get("artic")) and _num(o.get("f1Offset")) is not None and _num(o.get("f2Offset")) is not None
    ][:ANCHOR_COUNT]
    if not anchors:
        return []
    ids = [a.get("attemptId") for a in anchors]
    base_h = _anchor_median([a["artic"].get("tongueHeight") for a in anchors])
    base_x = _anchor_median([a["artic"].get("tongueFront") for a in anchors])
    base_f1 = _anchor_median([a["f1Offset"] for a in anchors])
    base_f2 = _anchor_median([a["f2Offset"] for a in anchors])
    claims = []

    if None not in (height, f1, base_h, base_f1):
        dh, d1 = height - base_h, f1 - base_f1
        if dh <= -TONGUE_DELTA and d1 >= FORMANT_DELTA:
            claims.append(_claim("height", "lower", ids, dh, d1))
        elif dh >= TONGUE_DELTA and d1 <= -FORMANT_DELTA:
            claims.append(_claim("height", "higher", ids, dh, d1))

    if None not in (front, f2, base_x, base_f2):
        dx, d2 = front - base_x, f2 - base_f2
        if dx <= -TONGUE_DELTA and d2 <= -FORMANT_DELTA:
            claims.append(_claim("frontness", "further_back", ids, dx, d2))
        elif dx >= TONGUE_DELTA and d2 >= FORMANT_DELTA:
            claims.append(_claim("frontness", "further_forward", ids, dx, d2))
    return claims


def annotate_attempts(attempts: list[dict]) -> list[dict]:
    """Replace each attempt's "artic" with "articulation" (newest-first input; input not mutated)."""
    items = list(attempts) if isinstance(attempts, list) else []
    out = []
    for i, attempt in enumerate(items):
        if not isinstance(attempt, dict) or "artic" not in attempt:
            out.append(attempt)
            continue
        new = {k: v for k, v in attempt.items() if k != "artic"}
        artic = attempt["artic"]
        if not _artic_ok(artic):
            reason = artic.get("reason") if isinstance(artic, dict) else None
            new["articulation"] = {"quality": "insufficient", "reason": reason or "no_features"}
        else:
            new["articulation"] = {"quality": "ok", "claims": _claims(attempt, items[i + 1:])}
        out.append(new)
    return out
