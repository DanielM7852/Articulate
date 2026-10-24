"""Vowel target regions on the F1/F2 plane.

Mirrors web/src/vowel/targets.ts exactly (centres in Hz, half-widths in natural-log units).
Keep the two in sync. Generic orientation regions, not speaker-normalised targets.
"""

import math

TARGETS: dict[str, dict[str, float]] = {
    "i": {"f1": 390.0, "f2": 2500.0, "rf1": 0.3, "rf2": 0.2},
    "u": {"f1": 420.0, "f2": 1050.0, "rf1": 0.3, "rf2": 0.25},
    "a": {"f1": 850.0, "f2": 1400.0, "rf1": 0.25, "rf2": 0.22},
}

SOUND_CUE = {"i": "spread-lips", "u": "round-lips", "a": "open-jaw"}
SOUND_SPELLING = {"i": "ee", "u": "oo", "a": "ah"}
SOUND_EXPECTATION = {"i": "spread lips", "u": "rounded lips", "a": "an open jaw"}


def normalized_distance(sound: str, f1: float, f2: float) -> float:
    """sqrt of the ellipse sum; <= 1 means inside the region."""
    t = TARGETS[sound]
    d1 = math.log(f1 / t["f1"]) / t["rf1"]
    d2 = math.log(f2 / t["f2"]) / t["rf2"]
    return math.sqrt(d1 * d1 + d2 * d2)


def in_target(sound: str, f1: float, f2: float) -> bool:
    t = TARGETS[sound]
    d1 = math.log(f1 / t["f1"]) / t["rf1"]
    d2 = math.log(f2 / t["f2"]) / t["rf2"]
    return d1 * d1 + d2 * d2 <= 1.0
