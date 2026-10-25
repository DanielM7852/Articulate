"""Starting lesson difficulty from the onboarding quiz.

The quiz score sets the hardest plan Claude may choose. Claude may pick that
plan or an easier one. A lower plan is not a judgment of ability.
"""

import asyncio
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings
from app.errors import CoachValidationError
from app.reasoning.learner_progress import LessonPlan

logger = logging.getLogger(__name__)

Difficulty = Literal["gentle", "supported", "open"]
_ORDER: tuple[Difficulty, ...] = ("gentle", "supported", "open")

_NOTES = {
    "gentle": "A gentler start: unhurried, with the reference visible.",
    "supported": "A supported start: the reference stays up while you settle the pace.",
    "open": "A more open start: the target is there, with fewer cues. The reference can come back.",
}


class QuizPreferences(BaseModel):
    model_config = ConfigDict(extra="ignore")

    goals: list[Literal["conversations", "sounds", "longer", "visual"]] = Field(default_factory=list)
    routine: Literal["exploring", "occasional", "regular", "partner"] = "occasional"
    pace: Literal["unhurried", "steady", "flexible"] = "unhurried"
    support: Literal["mouth", "words", "hear", "self"] = "mouth"
    guidance: Literal["guided", "explore"] = "guided"


class QuizPlanRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    preferences: QuizPreferences
    sound: Literal["i", "u", "a"] = "i"


class QuizPlanResponse(BaseModel):
    source: Literal["agent", "local"]
    difficulty: Difficulty
    plan: LessonPlan
    note: str


class DifficultyChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    difficulty: Difficulty


def quiz_ceiling(preferences: QuizPreferences) -> Difficulty:
    """Highest difficulty this quiz allows. Goals and a cautious routine pull it down."""

    score = 1
    if preferences.guidance == "explore":
        score += 1
    elif preferences.guidance == "guided":
        score -= 1
    if preferences.support == "self":
        score += 1
    elif preferences.support == "mouth":
        score -= 1
    if preferences.routine == "exploring":
        score -= 1
    elif preferences.routine == "regular":
        score += 1
    if preferences.pace == "unhurried":
        score -= 1
    elif preferences.pace == "flexible":
        score += 1
    if "visual" in preferences.goals:
        score -= 1
    if "longer" in preferences.goals:
        score -= 1
    if "conversations" in preferences.goals:
        score += 1
    if score <= 0:
        return "gentle"
    if score == 1:
        return "supported"
    return "open"


def lesson_options(preferences: QuizPreferences, sound: Literal["i", "u", "a"] = "i") -> tuple[Difficulty, dict[Difficulty, LessonPlan]]:
    ceiling = quiz_ceiling(preferences)
    supported_pace = preferences.pace if preferences.pace != "flexible" else "steady"
    plans: dict[Difficulty, LessonPlan] = {
        "gentle": LessonPlan(sound=sound, pace="unhurried", assistance="cue-target"),
        "supported": LessonPlan(sound=sound, pace=supported_pace, assistance="cue-target"),
        "open": LessonPlan(sound=sound, pace=preferences.pace, assistance="target-only"),
    }
    limit = _ORDER.index(ceiling)
    return ceiling, {name: plans[name] for name in _ORDER if _ORDER.index(name) <= limit}


def wants_easier(preferences: QuizPreferences | None) -> bool:
    """True when the quiz asked to keep the lesson easier during practice."""

    if preferences is None:
        return False
    return (
        quiz_ceiling(preferences) == "gentle"
        or "visual" in preferences.goals
        or "longer" in preferences.goals
        or preferences.routine == "exploring"
    )


async def propose_lesson_plan(settings: Settings, body: QuizPlanRequest, client=None) -> QuizPlanResponse:
    ceiling, options = lesson_options(body.preferences, body.sound)
    choice = ceiling
    source: Literal["agent", "local"] = "local"
    if client is not None or settings.anthropic_configured:
        try:
            parsed = await asyncio.wait_for(
                asyncio.to_thread(_choose, settings, body.preferences, sorted(options), client),
                timeout=max(settings.reasoning_timeout_s, 25.0),
            )
            if parsed.difficulty in options:
                choice = parsed.difficulty
                source = "agent"
        except Exception as exc:  # noqa: BLE001 - a model failure keeps the quiz's own ceiling
            logger.warning("lesson plan kept the quiz ceiling: %s", type(exc).__name__)
    return QuizPlanResponse(source=source, difficulty=choice, plan=options[choice], note=_NOTES[choice])


def _choose(settings: Settings, preferences: QuizPreferences, permitted: list[str], client) -> DifficultyChoice:
    active = client or _build_client(settings)
    facts = "\n".join(
        [
            f"goals={','.join(preferences.goals) or 'none'}",
            f"routine={preferences.routine}",
            f"pace={preferences.pace}",
            f"support={preferences.support}",
            f"guidance={preferences.guidance}",
            f"permitted_difficulties={','.join(permitted)}",
            "Pick one permitted difficulty. Prefer the easier one when a goal asks for time, visuals, or exploring.",
        ]
    )
    response = active.messages.parse(
        model=settings.anthropic_model,
        max_tokens=80,
        system=(
            "You choose a practice difficulty from the permitted list. "
            "Do not add a difficulty that is not listed. "
            "Return only the difficulty field."
        ),
        messages=[{"role": "user", "content": facts}],
        output_format=DifficultyChoice,
    )
    parsed = getattr(response, "parsed_output", None)
    if parsed is None:
        raise CoachValidationError("empty_model_output")
    if isinstance(parsed, DifficultyChoice):
        return parsed
    return DifficultyChoice.model_validate(parsed)


def _build_client(settings: Settings):
    from anthropic import Anthropic

    return Anthropic(api_key=settings.anthropic_api_key, max_retries=0, timeout=max(settings.reasoning_timeout_s, 25.0))
