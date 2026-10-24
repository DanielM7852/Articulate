"""Insight lane: one validated therapist line that compares the learner's last try with a reference or their best tries.

This is the ONLY place the word "tongue" may reach a learner about their own attempt. A line exists only
when the articulation gate emitted a claim (SPARC and formants agree, versus the reference range of correct
productions and/or the learner's on_target anchors). The wording is a comparison ("Compared with a clear ee"
for basis reference/both, "Compared with your best ee tries" for basis self), the instruction matches the
claim's direction, and it never contradicts the sound's target facts (talk_prompts.ARTICULATION). Anything else
falls back to a template.

Claim -> text (direction describes where the tongue was relative to the comparison):

  direction        finding self / reference                          instruction words      allowed for
  lower            "was not quite as high" (both)                    lift/raise/higher      ee, oo  (ah dropped: lifting contradicts low)
  higher           "rose a little more than on those" / "...than mine"  lower/relax/drop    ee, oo, ah
  further_back     "sat a little closer to the throat" (both)        forward/front          ee, ah  (oo dropped: oo is back)
  further_forward  "sat a little closer to your teeth" (both)        back                   oo, ah  (ee dropped: ee is front)

A claim that is not allowed for its sound is dropped (no insight, status "none").
"""

import json
import logging
import re

from pydantic import BaseModel, Field

from app.config import Settings
from app.live import llm
from app.live import talk_prompts as tp
from app.live.decision import _SHAMING, _sentences
from app.live.session import _DIGIT, _JUNK, _OBSERVED, SAY_MAX, SAY_MAX_SENTENCES, _contradicts_articulation

logger = logging.getLogger(__name__)

INSIGHT_MAX_TOKENS = 6000
RECENT_MAX = 5

_COMPARISON = re.compile(
    r"\b(best|strongest|good)\b[^.!?]{0,30}\b(tries|attempts|ones|try)\b|\bearlier\b|\ba clear (?:ee|oo|ah)\b", re.IGNORECASE
)
_TONGUE = re.compile(r"\btongue\b", re.IGNORECASE)

# Instruction words per claim direction.
_WORDS = {
    "lower": r"lift|lifts|lifting|raise|raises|raising|higher",
    "higher": r"lower|relax|relaxes|relaxing|drop|drops|dropping",
    "further_back": r"forward|front",
    "further_forward": r"back",
}
_OPPOSITE = {"lower": "higher", "higher": "lower", "further_back": "further_forward", "further_forward": "further_back"}
_WORD_RE = {k: re.compile(rf"\b(?:{v})\b", re.IGNORECASE) for k, v in _WORDS.items()}

_FINDING = {
    "lower": "your tongue was not quite as high",
    "higher": "your tongue rose a little more than on those",
    "further_back": "your tongue sat a little closer to the throat",
    "further_forward": "your tongue sat a little closer to your teeth",
}
# Findings for claims compared with the reference voices (basis "reference" or "both"); "I" is the therapist,
# whose voice is part of the reference set, so beyond the whole range also means beyond the therapist.
_FINDING_REFERENCE = {
    "lower": "your tongue was not quite as high",
    "higher": "your tongue rose a little more",
    "further_back": "your tongue sat a little closer to the throat",
    "further_forward": "your tongue sat a little closer to your teeth",
}
_INSTRUCTION = {
    "lower": "Try lifting it a little higher.",
    "higher": "Try letting it relax a little lower.",
    "further_back": "Try bringing it a little more forward.",
    "further_forward": "Try bringing it a little further back.",
}
# (sound, direction) pairs whose instruction would contradict the sound's target facts.
_DROPPED = {("a", "lower"), ("u", "further_back"), ("i", "further_forward")}


class InsightDraft(BaseModel):
    say: str = Field(max_length=600)


def claim_allowed(sound: str, claim: dict) -> bool:
    if not isinstance(claim, dict):
        return False
    direction = claim.get("direction")
    return (
        sound in tp.SPELL
        and claim.get("part") == "tongue"
        and direction in _FINDING
        and (sound, direction) not in _DROPPED
    )


def finding_text(sound: str, claim: dict) -> str:
    if claim.get("basis") in ("reference", "both"):
        return f"Compared with a clear {tp.SPELL[sound]}, {_FINDING_REFERENCE[claim['direction']]}."
    return f"Compared with your best {tp.SPELL[sound]} tries, {_FINDING[claim['direction']]}."


def instruction_text(claim: dict) -> str:
    return _INSTRUCTION[claim["direction"]]


def template_line(sound: str, claim: dict) -> str:
    return f"I took a closer look at one of your recent {tp.SPELL[sound]} tries. {finding_text(sound, claim)} {instruction_text(claim)}"


def validate_insight(say: str, sound: str, claim: dict) -> None:
    """Raise ValueError(reason) unless the line is a safe, direction-matched comparison."""
    if not claim_allowed(sound, claim):
        raise ValueError("claim_not_allowed")
    direction = claim["direction"]
    text = (say or "").strip()
    if not text or len(text) > SAY_MAX or _sentences(text) > SAY_MAX_SENTENCES:
        raise ValueError("say_length")
    if _DIGIT.search(text) or _JUNK.search(text):
        raise ValueError("say_chars")
    if _SHAMING.search(text):
        raise ValueError("shaming")
    if not _TONGUE.search(text):
        raise ValueError("no_tongue")
    if not _COMPARISON.search(text):
        raise ValueError("no_comparison")
    if _OBSERVED.search(text):
        raise ValueError("observation")
    if not _WORD_RE[direction].search(text):
        raise ValueError("instruction_missing")
    if _WORD_RE[_OPPOSITE[direction]].search(text):
        raise ValueError("opposite_direction")
    if _contradicts_articulation(text, sound):
        raise ValueError("articulation_contradiction")


def _recent_payload(sound: str, recent: list[dict]) -> list[dict]:
    out = []
    for item in recent:
        if not isinstance(item, dict) or item.get("sound") != sound:
            continue
        out.append({k: item.get(k) for k in ("audioVerdict", "f1Offset", "f2Offset", "videoVerdict")})
        if len(out) >= RECENT_MAX:
            break
    return out


async def compose_line(settings: Settings, client, sound: str, claim: dict, recent: list[dict]) -> tuple[str, str]:
    """Return (say, source): the model's line if it validates ("agent"), else the template ("fallback")."""
    template = template_line(sound, claim)
    validate_insight(template, sound, claim)  # raises claim_not_allowed for a dropped pair; the template must pass
    if client is None and not settings.anthropic_configured:
        return template, "fallback"
    payload = json.dumps(
        {
            "therapistName": settings.live_therapist_name,
            "sound": tp.SPELL[sound],
            "finding": finding_text(sound, claim),
            "instruction": instruction_text(claim),
            "recentAttempts": _recent_payload(sound, recent),
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    try:
        draft = await llm.ask(
            settings,
            client,
            tp.INSIGHT_SYSTEM.format(therapist=settings.live_therapist_name),
            payload,
            InsightDraft,
            settings.live_insight_effort,
            settings.live_insight_timeout_s,
            INSIGHT_MAX_TOKENS,
            model=settings.live_insight_model,
        )
        say = draft.say.strip()
        validate_insight(say, sound, claim)
        return say, "agent"
    except Exception as exc:  # noqa: BLE001
        logger.warning("insight line used template: %s", type(exc).__name__)
        return template, "fallback"
