"""Deterministic learner model built from stored attempts. Pure: no I/O, no model calls.

Units are word-zone phonemes (shared across words) and "vowel:<sound>" practice turns. Only clear (usable) tries
count; unclear captures are neither a miss nor a break in a run of misses.
"""

import re
from typing import Any

from app.live.words import word_info

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
        if not isinstance(turn, dict):
            continue
        if turn.get("kind") == "word":
            usable = turn.get("quality") == "usable"
            zones = turn.get("zones")
            for z in zones if isinstance(zones, list) else []:
                if not isinstance(z, dict) or z.get("advisory") or not z.get("inScope", True):
                    continue
                if not isinstance(z.get("phoneme"), str) or not z["phoneme"]:
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


def persistent_units(
    model: dict[str, dict[str, Any]], exclude: Any = (), limit: int = 3
) -> list[tuple[str, dict[str, Any]]]:
    """Persistent units not in `exclude`, worst first, at most `limit`."""
    ranked = sorted(
        ((k, u) for k, u in model.items() if u["persistent"] and k not in exclude),
        key=lambda ku: (-ku[1]["missStreak"], -ku[1]["misses"]),
    )
    return ranked[:limit]


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
    view["otherStruggles"] = [
        {"unit": k, "words": u.get("words", []), "missStreak": u["missStreak"], "misses": u["misses"], "usable": u["usable"]}
        for k, u in persistent_units(model, exclude=current, limit=limit)
    ]
    return view


_LEAK = re.compile(r"\b(coach\w*|claude|gpt|relay\w*|supervisor)\b", re.I)
_ADVICE_MAX = 160
_MEMORY_HEAD = (
    "# What you remember about this learner\n"
    "These are your own notes from their earlier practice. Mention at most one, warmly, when it fits. "
    "Never quote numbers or say where the notes came from. When a sound below is still hard, explain the same "
    "movement another way (a new image or way to think about it) instead of repeating what you said before."
)


_VOWEL_SOUND = re.compile(r"^[a-z]{1,4}$")


def _memory_name(key: str, unit: dict[str, Any]) -> str | None:
    """Readable name for a unit, or None when no known word names it (stored keys and words are free text)."""
    if key.startswith("vowel:"):
        return f'the "{key[len("vowel:"):]}" sound'
    # Name the sound by the label the learner sees in each word ("ck", "a"), not the phoneme key ("k", "ae").
    # Only words the app knows are named: stored words are free text and this goes into a model prompt.
    by_label: dict[str, list[str]] = {}
    for w in (w for w in unit.get("words", []) if isinstance(w, str) and w):
        info = word_info(w)
        if info is None:
            continue
        label = next((z.label for z in info.zones if z.phoneme == key), None)
        if label is not None:
            by_label.setdefault(label, []).append(w)
    if not by_label:
        return None
    return " and ".join(f'the "{label}" in ' + ", ".join(f'"{w}"' for w in ws) for label, ws in by_label.items())


def memory_brief(model: dict[str, dict[str, Any]], limit: int = 3) -> str | None:
    """First-person notes for Ava's session instructions: persistent struggles and the last advice given."""
    lines = [_MEMORY_HEAD, ""]
    for k, u in persistent_units(model, limit=limit):
        if k.startswith("vowel:"):
            if not _VOWEL_SOUND.match(k[len("vowel:"):]):
                continue
        name = _memory_name(k, u)
        if name is None:
            continue
        line = f"- {name}: hard lately"
        advice = " ".join(str(u.get("lastAdvice") or "").split())
        if advice and not _LEAK.search(advice) and len(advice) <= _ADVICE_MAX:
            line += f'; last time you said: "{advice}"'
        lines.append(line)
    return "\n".join(lines) if len(lines) > 2 else None
