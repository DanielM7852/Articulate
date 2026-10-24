"""Deterministic scoring of one attempt's audio (F1/F2) and lip frames. No model involved."""

import math
import statistics

from app.live.schemas import AudioFrame, AudioScore, LipFrame, VideoScore, WordAttempt, WordScore
from app.live.targets import SOUND_EXPECTATION, TARGETS, normalized_distance

MIN_VOICED_FRAMES = 8
MIN_OK_LIP_FRAMES = 6

# Audio verdict: share of voiced frames inside the target ellipse.
ON_TARGET_FRACTION = 0.5
# "close": at least this share inside, or the median frame is within this normalized distance
# (1.0 is the ellipse edge), so a near miss is not reported as "off".
CLOSE_FRACTION = 0.2
CLOSE_MEDIAN_DISTANCE = 1.3

# Lip thresholds. "matches" reuses the cv branch (services/api/app/decisions.py visual_observation):
#   u: rounding >= 0.35 or lipWidth <= 0.68
#   i: spread >= 0.25 or lipWidth >= 0.78
#   a: lipOpening >= 0.28 or jawDrop >= 1.15
# "partly" is a looser band defined here: roughly 60-70% of the way to the matching threshold.
#   u: rounding >= 0.20 or lipWidth <= 0.78
#   i: spread >= 0.12 or lipWidth >= 0.70
#   a: lipOpening >= 0.18 or jawDrop >= 0.80
# Anything below both is "mismatch".


def _voiced(frame: AudioFrame) -> bool:
    return bool(frame.valid and frame.f1 and frame.f2 and frame.f1 > 0 and frame.f2 > 0)


def score_audio(sound: str, frames: list[AudioFrame]) -> AudioScore:
    voiced = [f for f in frames if _voiced(f)]
    if len(voiced) < MIN_VOICED_FRAMES:
        return AudioScore(frames=len(frames), voicedFrames=len(voiced), verdict="insufficient")
    target = TARGETS[sound]
    dists = [normalized_distance(sound, f.f1, f.f2) for f in voiced]  # type: ignore[arg-type]
    inside = sum(1 for d in dists if d <= 1.0)
    fraction = inside / len(voiced)
    f1_med = statistics.median(f.f1 for f in voiced)  # type: ignore[misc]
    f2_med = statistics.median(f.f2 for f in voiced)  # type: ignore[misc]
    q = statistics.quantiles(dists, n=4, method="inclusive")
    if fraction >= ON_TARGET_FRACTION:
        verdict = "on_target"
    elif fraction >= CLOSE_FRACTION or normalized_distance(sound, f1_med, f2_med) <= CLOSE_MEDIAN_DISTANCE:
        verdict = "close"
    else:
        verdict = "off"
    return AudioScore(
        frames=len(frames),
        voicedFrames=len(voiced),
        f1Median=round(f1_med, 1),
        f2Median=round(f2_med, 1),
        inTargetFraction=round(fraction, 3),
        f1Offset=round(math.log(f1_med / target["f1"]), 3),
        f2Offset=round(math.log(f2_med / target["f2"]), 3),
        spread=round(q[2] - q[0], 3),
        verdict=verdict,
    )


def _mean(values: list[float | None]) -> float | None:
    clean = [v for v in values if v is not None and math.isfinite(v)]
    return round(sum(clean) / len(clean), 3) if clean else None


def _lip_verdict(sound: str, rounding, spread, width, opening, jaw) -> str:
    def ge(v, x):
        return v is not None and v >= x

    def le(v, x):
        return v is not None and v <= x

    if sound == "u":
        if ge(rounding, 0.35) or le(width, 0.68):
            return "matches"
        if ge(rounding, 0.20) or le(width, 0.78):
            return "partly"
    elif sound == "i":
        if ge(spread, 0.25) or ge(width, 0.78):
            return "matches"
        if ge(spread, 0.12) or ge(width, 0.70):
            return "partly"
    else:
        if ge(opening, 0.28) or ge(jaw, 1.15):
            return "matches"
        if ge(opening, 0.18) or ge(jaw, 0.80):
            return "partly"
    return "mismatch"


def score_video(sound: str, frames: list[LipFrame]) -> VideoScore | None:
    if not frames:
        return None
    ok = [f for f in frames if f.ok]
    expectation = SOUND_EXPECTATION[sound]
    if len(ok) < MIN_OK_LIP_FRAMES:
        return VideoScore(frames=len(frames), usableFrames=len(ok), expectation=expectation, verdict="insufficient")
    rounding = _mean([f.rounding for f in ok])
    spread = _mean([f.spread for f in ok])
    width = _mean([f.lipWidth for f in ok])
    opening = _mean([f.lipOpening for f in ok])
    jaw = _mean([f.jawDrop for f in ok])
    return VideoScore(
        frames=len(frames),
        usableFrames=len(ok),
        roundingMean=rounding,
        spreadMean=spread,
        opennessMean=_mean([f.openness for f in ok]),
        lipOpeningMean=opening,
        jawDropMean=jaw,
        expectation=expectation,
        verdict=_lip_verdict(sound, rounding, spread, width, opening, jaw),
    )


# ---- Word attempts (the board scores each zone on the device; the server only rolls them up) ----

# A skipped zone was never produced, so it counts as a miss for the roll-up and the weakest zone.
_MISSING = ("miss", "skipped")


def practice_scope(attempt: WordAttempt, practice: list[str] | None) -> list[str]:
    """Zone ids the coach may focus on: the practice list restricted to this attempt's zones, else every zone."""
    ids = [z.zoneId for z in attempt.zones]
    if practice is None:
        return ids
    return [i for i in ids if i in practice]


def score_word(attempt: WordAttempt, practice: list[str] | None = None) -> WordScore:
    """Zone verdicts pass through unchanged. weakestZoneId: first miss/skipped, else first partial, else None.

    Advisory zones (liquid, fricative, nasal) never count: not toward the verdict, the hit count, the zone count or
    the weakest zone. With `practice` the roll-up covers only the listed zones. When nothing scoreable is left
    (a cue-only part), the verdict is close with zero zones and weakestZoneId is the first practised advisory zone,
    so the coach still has a part to teach from its hint.

    verdict: insufficient when capture quality is unclear; on_target when every counted zone hit; close when nothing
    was missed but some zone was partial; off otherwise.
    """
    scope = set(practice_scope(attempt, practice))
    zones = [z for z in attempt.zones if z.zoneId in scope] if practice is not None else list(attempt.zones)
    counted = [z for z in zones if not z.is_advisory]
    hits = sum(1 for z in counted if z.verdict == "hit")
    out_zones = list(attempt.zones)
    if attempt.quality != "usable":
        return WordScore(word=attempt.word, verdict="insufficient", zoneCount=len(counted), hitCount=hits,
                         weakestZoneId=None, zones=out_zones, lipUsable=attempt.lipUsable)
    if not counted:
        first = zones[0].zoneId if zones else None
        return WordScore(word=attempt.word, verdict="close", zoneCount=0, hitCount=0,
                         weakestZoneId=first, zones=out_zones, lipUsable=attempt.lipUsable)
    missed = next((z.zoneId for z in counted if z.verdict in _MISSING), None)
    partial = next((z.zoneId for z in counted if z.verdict == "partial"), None)
    if missed is not None:
        verdict = "off"
    elif partial is not None:
        verdict = "close"
    else:
        verdict = "on_target"
    return WordScore(word=attempt.word, verdict=verdict, zoneCount=len(counted), hitCount=hits,
                     weakestZoneId=missed or partial, zones=out_zones, lipUsable=attempt.lipUsable)
