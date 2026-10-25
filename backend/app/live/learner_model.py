"""Deterministic learner model built from stored attempts. Pure: no I/O, no model calls.

Units are word-zone phonemes (shared across words) and "vowel:<sound>" practice turns. Only clear (usable) tries
count; unclear captures are neither a miss nor a break in a run of misses.
"""

from typing import Any

STRUGGLE_STREAK = 2  # agreed with the user: 2 clear misses in a row
RECENT_OUTCOMES = 5

_RANK = {"miss": 0, "partial": 1, "hit": 2}
_WORD_OUTCOME = {"hit": "hit", "partial": "partial"}
_VOWEL_OUTCOME = {"on_target": "hit", "close": "partial", "off": "miss"}
_STAT_KEYS = ("usable", "misses", "recent", "missStreak", "persistent", "timesCoached", "helpedAfterCoaching", "cuesTried", "lastAdvice")
RULE = (
    "persistent means the learner's clear tries of that sound missed it several times in a row; "
    "unclear tries are not counted"
)


def _unit_turns(timeline: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Per unit, its turns newest first: {usable, outcome, coached, cueId, caption, word}."""
    units: dict[str, list[dict[str, Any]]] = {}
    for turn in timeline:
        if turn.get("kind") == "word":
            usable = turn.get("quality") == "usable"
            for z in turn.get("zones") or []:
                if z.get("advisory") or not z.get("inScope", True):
                    continue
                units.setdefault(z["phoneme"], []).append({
                    "usable": usable,
                    "outcome": _WORD_OUTCOME.get(z.get("verdict"), "miss"),
                    "coached": usable and turn.get("focusZoneId") == z.get("id"),
                    "cueId": turn.get("cueId"),
                    "caption": turn.get("caption"),
                    "word": turn.get("word"),
                })
        elif turn.get("sound"):
            verdict = turn.get("audioVerdict")
            units.setdefault(f"vowel:{turn['sound']}", []).append({
                "usable": verdict not in (None, "insufficient"),
                "outcome": _VOWEL_OUTCOME.get(verdict, "miss"),
                "coached": verdict not in (None, "insufficient")
                and turn.get("cueId") is not None and turn.get("nextAction") == "retry",
                "cueId": turn.get("cueId"),
                "caption": turn.get("caption"),
                "word": None,
            })
    return units


def _summarise(turns: list[dict[str, Any]], is_word: bool) -> dict[str, Any]:
    clear = [t for t in turns if t["usable"]]
    outcomes = [t["outcome"] for t in clear]
    streak = 0
    for o in outcomes:
        if o != "miss":
            break
        streak += 1
    coached = [t for t in clear if t["coached"]]
    helped = 0
    for i, t in enumerate(clear):
        if t["coached"] and i > 0 and _RANK[clear[i - 1]["outcome"]] > _RANK[t["outcome"]]:
            helped += 1
    out: dict[str, Any] = {
        "attempts": len(turns),
        "usable": len(clear),
        "unclear": len(turns) - len(clear),
        "misses": outcomes.count("miss"),
        "recent": outcomes[:RECENT_OUTCOMES],
        "missStreak": streak,
        "persistent": streak >= STRUGGLE_STREAK,
        "timesCoached": len(coached),
        "helpedAfterCoaching": helped,
        "cuesTried": list(dict.fromkeys(t["cueId"] for t in coached if t["cueId"] is not None)),
        "lastAdvice": coached[0]["caption"] if coached else None,
    }
    if is_word:
        out["words"] = list(dict.fromkeys(t["word"] for t in turns if t["word"]))
    return out


def build_learner_model(timeline: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per-unit stats from compact attempts, newest first."""
    return {key: _summarise(turns, not key.startswith("vowel:")) for key, turns in _unit_turns(timeline).items()}


def _stats(unit: dict[str, Any]) -> dict[str, Any]:
    return {k: unit[k] for k in _STAT_KEYS}


def prompt_view(
    model: dict[str, dict[str, Any]], *, word: Any = None, sound: str | None = None, limit: int = 3
) -> dict[str, Any]:
    """Small JSON-able view for the coach prompt: this word or sound, plus other persistent struggles."""
    view: dict[str, Any] = {"rule": RULE}
    current: set[str] = set()
    if word is not None:
        zones = []
        for z in word.zones:
            if z.is_advisory or z.phoneme not in model:
                continue
            current.add(z.phoneme)
            zones.append({"zoneId": z.zoneId, "phoneme": z.phoneme, **_stats(model[z.phoneme])})
        view["thisWord"] = zones
    elif sound is not None:
        key = f"vowel:{sound}"
        current.add(key)
        view["thisSound"] = _stats(model[key]) if key in model else None
    others = sorted(
        ((k, u) for k, u in model.items() if u["persistent"] and k not in current),
        key=lambda ku: (-ku[1]["missStreak"], -ku[1]["misses"]),
    )
    view["otherStruggles"] = [
        {"unit": k, "words": u.get("words", []), "missStreak": u["missStreak"], "misses": u["misses"], "usable": u["usable"]}
        for k, u in others[:limit]
    ]
    return view
