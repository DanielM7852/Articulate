"""Coach response for the practice-screen attempt summary.

The browser sends the fields it measured. This module returns the same
CoachResponse shape the screen already renders. Claude may rephrase the
observation from those fields. The action, cue, and evidence stay server-side.
"""

import asyncio
import logging
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings
from app.errors import CoachValidationError

logger = logging.getLogger(__name__)
_VOWEL_TIMEOUT_S = 25.0

SoundId = Literal["i", "u", "a"]
NextAction = Literal["repeat", "simplify", "change-cue", "reduce-assistance", "next-context", "repair-capture"]

_SOUNDS = {
    "i": {"spelled": "ee", "example": "see", "cue": "Tongue forward, lips gently spread."},
    "u": {"spelled": "oo", "example": "food", "cue": "Tongue back and high, lips rounded."},
    "a": {"spelled": "ah", "example": "father", "cue": "Jaw open, tongue low and relaxed."},
}

_BANNED = re.compile(
    r"\b(tongue|lips?|jaw|palate|velum|glottis|larynx|pharynx|articulators?|vocal folds?|pronunciation)\b",
    re.IGNORECASE,
)
_NUMBER = re.compile(r"\d+(?:\.\d+)?")

_SYSTEM = (
    "You write one observation for a vowel practice screen. "
    "Use only the facts in the user message. "
    "Do not add durations, scores, diagnoses, or descriptions of the body. "
    "Do not use the words tongue, lip, lips, jaw, palate, or pronunciation. "
    "Write one or two short sentences and no markdown."
)


class VowelAttempt(BaseModel):
    model_config = ConfigDict(extra="ignore")

    attemptId: str = Field(min_length=1, max_length=80)
    sound: SoundId
    kind: Literal["baseline", "guided", "independent"]
    assistance: Literal["cue-target", "target-only", "none"]
    startedAt: float
    durationSec: float
    usableVoicedSec: float
    timeInTargetSec: float | None = None
    longestHoldSec: float | None = None
    quality: Literal["usable", "unclear"]
    qualityReason: Literal["silence", "clipping", "too-short", "no-mic"] | None = None
    recognizedText: str | None = None
    feeling: Literal["too-hard", "okay", "ready"] | None = None


class VowelCoachRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    attempt: VowelAttempt
    history: list[VowelAttempt] = Field(default_factory=list)


class VowelCoachResponse(BaseModel):
    attemptId: str
    source: Literal["agent", "local"]
    observation: str
    nextCue: str
    nextAction: NextAction
    evidence: list[str]


class VowelPhrasing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observation: str = Field(min_length=1, max_length=500)


def local_response(attempt: VowelAttempt, history: list[VowelAttempt]) -> VowelCoachResponse:
    """Same wording as the practice screen's offline coach."""

    sound = _SOUNDS[attempt.sound]
    if attempt.quality == "unclear":
        if attempt.qualityReason == "clipping":
            reason = "The input was too loud and clipped. Try moving a little further from the microphone."
        elif attempt.qualityReason == "too-short":
            reason = "There was not quite enough voiced sound to describe. Try holding the sound a little longer."
        else:
            reason = "I couldn’t measure that clearly. Try moving closer to the microphone."
        return VowelCoachResponse(
            attemptId=attempt.attemptId,
            source="local",
            observation=f"{reason} Nothing was scored.",
            nextCue="Retry when you are ready, or change your device.",
            nextAction="repair-capture",
            evidence=[f"quality={attempt.qualityReason or 'unclear'}"],
        )

    previous = next(
        (
            item
            for item in reversed(history)
            if item.sound == attempt.sound and item.quality == "usable" and item.attemptId != attempt.attemptId
        ),
        None,
    )
    evidence = [f"usable_voiced={_one_decimal(attempt.usableVoicedSec)}s"]
    observation = (
        f"{_one_decimal(attempt.usableVoicedSec)} seconds of usable voice were captured for “{sound['spelled']}”."
    )
    if attempt.timeInTargetSec is not None:
        observation += f" The trace spent {_one_decimal(attempt.timeInTargetSec)} s in the target region"
        if attempt.longestHoldSec is not None:
            observation += f", with a longest stable hold of {_one_decimal(attempt.longestHoldSec)} s."
        else:
            observation += "."
        evidence.append(f"time_in_target={_one_decimal(attempt.timeInTargetSec)}s")
    if previous is not None:
        delta = attempt.usableVoicedSec - previous.usableVoicedSec
        if abs(delta) >= 0.3:
            direction = "more" if delta > 0 else "less"
            observation += (
                f" That is {_one_decimal(abs(delta))} s {direction} usable sound than your last try."
            )
            evidence.append(f"delta_vs_previous={_one_decimal(delta)}s")
    observation += " This describes the sound you made, not your tongue position or overall pronunciation."

    next_action: NextAction = "repeat"
    next_cue = f"For the next try, look at the reference: {sound['cue'].lower()} Choose one cue to explore comfortably."
    if attempt.kind == "independent":
        next_action = "next-context"
        next_cue = (
            f"When it feels comfortable, try the same “{sound['spelled']}” inside the word "
            f"“{sound['example']}”, or bring the visual guide back."
        )
    elif attempt.feeling == "too-hard":
        next_action = "simplify"
        next_cue = "Let’s keep it gentle: hold the sound for just a second or two, with the reference visible."
    elif attempt.kind == "guided" and attempt.usableVoicedSec >= 2:
        next_action = "reduce-assistance"
        next_cue += " If you’d like, try once with fewer cues."

    return VowelCoachResponse(
        attemptId=attempt.attemptId,
        source="local",
        observation=observation,
        nextCue=next_cue,
        nextAction=next_action,
        evidence=evidence,
    )


async def coach_attempt(settings: Settings, body: VowelCoachRequest, client=None) -> VowelCoachResponse:
    grounded = local_response(body.attempt, body.history)
    if client is None and not settings.anthropic_configured:
        return grounded
    try:
        phrasing = await asyncio.wait_for(
            asyncio.to_thread(_phrase, settings, body.attempt, grounded, client),
            timeout=max(settings.reasoning_timeout_s, _VOWEL_TIMEOUT_S),
        )
        _check_phrasing(phrasing.observation, grounded.evidence)
    except Exception as exc:  # noqa: BLE001 - any model failure keeps the screen's own wording
        logger.warning("vowel coach kept the local wording: %s", type(exc).__name__)
        return grounded
    return grounded.model_copy(update={"observation": phrasing.observation.strip(), "source": "agent"})


def _phrase(settings: Settings, attempt: VowelAttempt, grounded: VowelCoachResponse, client):
    active = client or _build_client(settings)
    sound = _SOUNDS[attempt.sound]
    facts = "\n".join(
        [
            f"spelled={sound['spelled']}",
            f"example={sound['example']}",
            *grounded.evidence,
            f"next_action={grounded.nextAction}",
            "Write the observation from these facts only.",
        ]
    )
    response = active.messages.parse(
        model=settings.anthropic_model,
        max_tokens=400,
        system=_SYSTEM,
        messages=[{"role": "user", "content": facts}],
        output_format=VowelPhrasing,
    )
    parsed = getattr(response, "parsed_output", None)
    if parsed is None:
        raise CoachValidationError("empty_model_output")
    if isinstance(parsed, VowelPhrasing):
        return parsed
    return VowelPhrasing.model_validate(parsed)


def _check_phrasing(observation: str, evidence: list[str]) -> None:
    text = observation.strip()
    if not text or len(text) > 500:
        raise CoachValidationError("observation_length")
    if _BANNED.search(text):
        raise CoachValidationError("observation_language")
    allowed = set(_NUMBER.findall(" ".join(evidence)))
    if any(number not in allowed for number in _NUMBER.findall(text)):
        raise CoachValidationError("observation_number")


def _build_client(settings: Settings):
    from anthropic import Anthropic

    return Anthropic(
        api_key=settings.anthropic_api_key,
        max_retries=0,
        timeout=max(settings.reasoning_timeout_s, _VOWEL_TIMEOUT_S),
    )


def _one_decimal(value: float) -> str:
    return f"{value:.1f}"
