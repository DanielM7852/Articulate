"""Deterministic articulation features from a SPARC/Silero bundle, and a corroboration gate.

A tongue claim is emitted only when SPARC and the acoustic formants agree. SPARC is compared with a
reference range of correct productions (articulation_reference.json, built from Cartesia voices) and,
when the learner has on_target attempts, also with those. When in doubt, no claim. No model involved.
"""

import json
import math
import statistics
from functools import lru_cache
from pathlib import Path
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
# SPARC distance (EMA units) a try must lie beyond the min/max of the reference voices' values to count as
# clearly outside the range of correct productions. Within the margin of a range edge: no claim.
# Clear ee productions left out of the reference (Ava's voice, a Windows TTS voice) measured ~0.6 below the
# reference minimum, so the margin sits above that: only large misses (e.g. an ah-shaped ee) are claimed.
REF_MARGIN = 0.7
MIN_REFERENCE_VOICES = 3
REFERENCE_VERSION = 1
REFERENCE_PATH = Path(__file__).with_name("articulation_reference.json")
_DEFAULT = object()
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


def _claim(dimension: str, direction: str, basis: str, ids: list, sparc: float, formant: float) -> dict:
    return {
        "part": "tongue", "dimension": dimension, "direction": direction, "basis": basis, "comparedTo": ids,
        "sparcDelta": round(sparc, 3), "formantDelta": round(formant, 3),
    }


@lru_cache(maxsize=4)
def _load(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("v") != REFERENCE_VERSION or not isinstance(data.get("sounds"), dict):
        return None
    return data


def load_reference(path: Path | None = None) -> dict | None:
    """The reference ranges, or None when the file is missing, unreadable or of another version. Never raises."""
    try:
        return _load(Path(path) if path is not None else REFERENCE_PATH)
    except Exception:  # noqa: BLE001
        return None


def _ref_range(reference: Any, sound: Any, feature: str) -> tuple[float, float] | None:
    sounds = reference.get("sounds") if isinstance(reference, dict) else None
    entry = sounds.get(sound) if isinstance(sounds, dict) and isinstance(sound, str) else None
    if not isinstance(entry, dict):
        return None
    n, stats = _num(entry.get("n")), entry.get(feature)
    if n is None or n < MIN_REFERENCE_VOICES or not isinstance(stats, dict):
        return None
    lo, hi = _num(stats.get("min")), _num(stats.get("max"))
    return None if lo is None or hi is None or lo > hi else (lo, hi)


def _reference_claims(attempt: dict, reference: Any) -> dict[str, dict]:
    artic = attempt["artic"]
    sound = attempt.get("sound")
    f1, f2 = _num(attempt.get("f1Offset")), _num(attempt.get("f2Offset"))
    height, front = _num(artic.get("tongueHeight")), _num(artic.get("tongueFront"))
    out: dict[str, dict] = {}
    rng = _ref_range(reference, sound, "tongueHeight")
    if rng and height is not None and f1 is not None:
        lo, hi = rng
        if height < lo - REF_MARGIN and f1 >= FORMANT_DELTA:
            out["height"] = _claim("height", "lower", "reference", ["reference"], height - lo, f1)
        elif height > hi + REF_MARGIN and f1 <= -FORMANT_DELTA:
            out["height"] = _claim("height", "higher", "reference", ["reference"], height - hi, f1)
    rng = _ref_range(reference, sound, "tongueFront")
    if rng and front is not None and f2 is not None:
        lo, hi = rng
        if front < lo - REF_MARGIN and f2 <= -FORMANT_DELTA:
            out["frontness"] = _claim("frontness", "further_back", "reference", ["reference"], front - lo, f2)
        elif front > hi + REF_MARGIN and f2 >= FORMANT_DELTA:
            out["frontness"] = _claim("frontness", "further_forward", "reference", ["reference"], front - hi, f2)
    return out


def _claims(attempt: dict, older: list[Any], reference: Any = None) -> list[dict]:
    if attempt.get("audioVerdict") not in CLAIM_VERDICTS:
        return []
    own = _self_claims(attempt, older)
    ref = _reference_claims(attempt, reference) if reference else {}
    claims = []
    for dim in ("height", "frontness"):
        s, r = own.get(dim), ref.get(dim)
        if s and r:
            if s["direction"] == r["direction"]:
                claims.append({**s, "basis": "both", "comparedTo": ["reference", *s["comparedTo"]]})
        elif r:
            claims.append(r)
        elif s and _beyond_reference(attempt, reference, s):
            claims.append(s)
    return claims


_DIM_FEATURE = {"height": "tongueHeight", "frontness": "tongueFront"}
_DIRECTION_SIGN = {"lower": -1, "further_back": -1, "higher": 1, "further_forward": 1}


def _beyond_reference(attempt: dict, reference: Any, claim: dict) -> bool:
    """A self-only claim survives a usable reference only if the learner is past the range edge in that direction.

    Inside the range of correct productions, SPARC does not explain the miss, so no tongue advice is given.
    """
    feature = _DIM_FEATURE[claim["dimension"]]
    rng = _ref_range(reference, attempt.get("sound"), feature) if reference else None
    if not rng:
        return True
    value = _num(attempt["artic"].get(feature))
    if value is None:
        return False
    lo, hi = rng
    return value < lo if _DIRECTION_SIGN[claim["direction"]] < 0 else value > hi


def _self_claims(attempt: dict, older: list[Any]) -> dict[str, dict]:
    artic = attempt["artic"]
    f1, f2 = _num(attempt.get("f1Offset")), _num(attempt.get("f2Offset"))
    height, front = _num(artic.get("tongueHeight")), _num(artic.get("tongueFront"))
    anchors = [
        o for o in older
        if isinstance(o, dict) and o.get("sound") == attempt.get("sound") and o.get("audioVerdict") == "on_target"
        and _artic_ok(o.get("artic")) and _num(o.get("f1Offset")) is not None and _num(o.get("f2Offset")) is not None
    ][:ANCHOR_COUNT]
    if not anchors:
        return {}
    ids = [a.get("attemptId") for a in anchors]
    base_h = _anchor_median([a["artic"].get("tongueHeight") for a in anchors])
    base_x = _anchor_median([a["artic"].get("tongueFront") for a in anchors])
    base_f1 = _anchor_median([a["f1Offset"] for a in anchors])
    base_f2 = _anchor_median([a["f2Offset"] for a in anchors])
    claims: dict[str, dict] = {}

    if None not in (height, f1, base_h, base_f1):
        dh, d1 = height - base_h, f1 - base_f1
        if dh <= -TONGUE_DELTA and d1 >= FORMANT_DELTA:
            claims["height"] = _claim("height", "lower", "self", ids, dh, d1)
        elif dh >= TONGUE_DELTA and d1 <= -FORMANT_DELTA:
            claims["height"] = _claim("height", "higher", "self", ids, dh, d1)

    if None not in (front, f2, base_x, base_f2):
        dx, d2 = front - base_x, f2 - base_f2
        if dx <= -TONGUE_DELTA and d2 <= -FORMANT_DELTA:
            claims["frontness"] = _claim("frontness", "further_back", "self", ids, dx, d2)
        elif dx >= TONGUE_DELTA and d2 >= FORMANT_DELTA:
            claims["frontness"] = _claim("frontness", "further_forward", "self", ids, dx, d2)
    return claims


def annotate_attempts(attempts: list[dict], reference: Any = _DEFAULT) -> list[dict]:
    """Replace each attempt's "artic" with "articulation" (newest-first input; input not mutated).

    reference: loaded reference ranges; by default the packaged file (if any); None disables it.
    """
    if reference is _DEFAULT:
        reference = load_reference()
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
            new["articulation"] = {"quality": "ok", "claims": _claims(attempt, items[i + 1:], reference)}
        out.append(new)
    return out
