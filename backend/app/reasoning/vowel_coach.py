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

from app import telemetry
from app.config import Settings
from app.errors import CoachValidationError
from app.reasoning.lesson_difficulty import QuizPreferences, wants_easier
from app.reasoning.learner_progress import (
    LessonPlan,
    LessonProgress,
    ProgressStore,
    ProgressUnavailable,
    apply_attempt,
    build_progress_store,
    counts_for,
    empty_progress,
)

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
    "Write one or two short sentences and no markdown. "
    "Set plan_choice to one of the permitted values. "
    "Do not mention plan_choice, attempt counts, or the next lesson in the observation."
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
    learnerId: str | None = None
    plan: LessonPlan | None = None
    preferences: QuizPreferences | None = None


class VowelCoachResponse(BaseModel):
    attemptId: str
    source: Literal["agent", "local"]
    observation: str
    nextCue: str
    nextAction: NextAction
    evidence: list[str]
    plan: LessonPlan | None = None


class VowelPhrasing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observation: str = Field(min_length=1, max_length=500)
    plan_choice: Literal["keep", "simplify", "reduce", "advance"] | None = None


_NEXT_SOUND = {"i": "u", "u": "a", "a": "i"}
_LESS_HELP = {"cue-target": "target-only", "target-only": "none", "none": "none"}
PlanChoice = Literal["keep", "simplify", "reduce", "advance"]


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


def choose_plan(
    attempt: VowelAttempt,
    current: LessonPlan,
    progress: LessonProgress,
    preferences: QuizPreferences | None = None,
) -> tuple[PlanChoice, dict[PlanChoice, LessonPlan]]:
    """Return the default move and the moves Claude is allowed to pick."""

    counts = counts_for(progress, attempt.sound)
    usable = counts.usable + (1 if attempt.quality == "usable" and attempt.attemptId not in progress.counted_attempt_ids else 0)
    unclear_before = counts.unclear
    easier = wants_easier(preferences)
    options: dict[PlanChoice, LessonPlan] = {"keep": current}
    if attempt.feeling == "too-hard" or unclear_before >= 2:
        options["simplify"] = LessonPlan(sound=current.sound, pace="unhurried", assistance="cue-target")
    can_reduce = (
        attempt.quality == "usable"
        and attempt.kind == "guided"
        and attempt.usableVoicedSec >= 2
        and current.assistance != "none"
        and attempt.feeling != "too-hard"
        and (not easier or usable >= 2)
    )
    if can_reduce:
        options["reduce"] = current.model_copy(update={"assistance": _LESS_HELP[current.assistance]})
    can_advance = (
        attempt.quality == "usable"
        and current.assistance == "none"
        and usable >= (3 if easier else 2)
        and attempt.feeling != "too-hard"
    )
    if can_advance:
        options["advance"] = LessonPlan(sound=_NEXT_SOUND[current.sound], pace=current.pace, assistance="cue-target")
    if attempt.quality == "unclear":
        default: PlanChoice = "keep"
    elif "simplify" in options and attempt.feeling == "too-hard":
        default = "simplify"
    elif "reduce" in options:
        default = "reduce"
    elif "advance" in options:
        default = "advance"
    elif "simplify" in options:
        default = "simplify"
    else:
        default = "keep"
    return default, options


def _apply_plan(grounded: VowelCoachResponse, attempt: VowelAttempt, choice: PlanChoice, plan: LessonPlan) -> VowelCoachResponse:
    action: NextAction = {
        "keep": "repair-capture" if attempt.quality == "unclear" else "repeat",
        "simplify": "simplify",
        "reduce": "reduce-assistance",
        "advance": "next-context",
    }[choice]
    cue = grounded.nextCue
    spelled = _SOUNDS[attempt.sound]["spelled"]
    if choice == "simplify":
        cue = "Let’s keep it gentle: hold the sound for just a second or two, with the reference visible."
    elif choice == "reduce":
        cue = f"Next try stays on “{spelled}”, with fewer cues than this one."
    elif choice == "advance":
        nxt = _SOUNDS[plan.sound]
        cue = f"Next lesson is “{nxt['spelled']}”, as in “{nxt['example']}”, with the reference visible."
    return grounded.model_copy(update={"nextAction": action, "nextCue": cue, "plan": plan})


async def coach_attempt(
    settings: Settings, body: VowelCoachRequest, client=None, progress_store: ProgressStore | None = None
) -> VowelCoachResponse:
    store = progress_store if progress_store is not None else build_progress_store(settings)
    current = body.plan or LessonPlan(sound=body.attempt.sound, pace="unhurried", assistance=body.attempt.assistance)
    stored = None
    readable = True
    if body.learnerId:
        try:
            stored = await store.load(body.learnerId)
        except ProgressUnavailable as exc:
            readable = False  # never overwrite a record that could not be read
            logger.warning("learner progress unavailable, not saving: %s", type(exc).__name__)
    already = stored is not None and body.attempt.attemptId in stored.counted_attempt_ids and stored.plan is not None
    progress = stored or empty_progress(body.learnerId or "anonymous")
    if stored is None:
        for earlier in body.history[-20:]:
            bucket = progress.sounds.get(earlier.sound)
            if bucket is None or earlier.attemptId in progress.counted_attempt_ids:
                continue
            if earlier.quality == "usable":
                bucket.usable += 1
            else:
                bucket.unclear += 1
            progress.counted_attempt_ids.append(earlier.attemptId)
    if already:
        default, options = "keep", {"keep": stored.plan}
    else:
        default, options = choose_plan(body.attempt, current, progress, body.preferences)
    grounded = _apply_plan(local_response(body.attempt, body.history), body.attempt, default, options[default])
    choice = default
    if client is not None or settings.anthropic_configured:
        try:
            phrasing = await asyncio.wait_for(
                asyncio.to_thread(_phrase, settings, body.attempt, grounded, sorted(options), client),
                timeout=max(settings.reasoning_timeout_s, _VOWEL_TIMEOUT_S),
            )
            _check_phrasing(phrasing.observation, grounded.evidence)
            if phrasing.plan_choice in options:
                choice = phrasing.plan_choice
            grounded = _apply_plan(grounded, body.attempt, choice, options[choice]).model_copy(
                update={"observation": phrasing.observation.strip(), "source": "agent"}
            )
        except Exception as exc:  # noqa: BLE001 - any model failure keeps the screen's own wording
            logger.warning("vowel coach kept the local wording: %s", type(exc).__name__)
    if body.learnerId and readable and not already:
        updated = apply_attempt(stored, body.learnerId, body.attempt, options[choice], body.history)
        await store.save(updated)
    return grounded


def _phrase(settings: Settings, attempt: VowelAttempt, grounded: VowelCoachResponse, permitted: list[str], client):
    active = client or _build_client(settings)
    sound = _SOUNDS[attempt.sound]
    facts = "\n".join(
        [
            f"spelled={sound['spelled']}",
            f"example={sound['example']}",
            *grounded.evidence,
            f"next_action={grounded.nextAction}",
            f"permitted_plan_choices={','.join(permitted)}",
            "Write the observation from the measured facts only.",
        ]
    )
    response = telemetry.claude_call(settings.anthropic_model, "coach", lambda: active.messages.parse(
        model=settings.anthropic_model,
        max_tokens=400,
        system=_SYSTEM,
        messages=[{"role": "user", "content": facts}],
        output_format=VowelPhrasing,
    ))
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
