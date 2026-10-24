"""Claude Sonnet 5.5 calls for live coaching and learner notes (structured output, adaptive thinking)."""

import asyncio
import logging
from typing import TypeVar

from pydantic import BaseModel

from app.config import Settings
from app.live.decision import DecisionError

T = TypeVar("T", bound=BaseModel)

logger = logging.getLogger(__name__)

_EFFORTS = ("low", "medium", "high")
_warned: set[str] = set()


def _warn_once(key: str, message: str, *args) -> None:
    if key not in _warned:
        _warned.add(key)
        logger.warning(message, *args)


def request_options(model: str, thinking: str, effort: str) -> tuple[dict, str]:
    """Return (extra kwargs for messages.parse, effective effort). Thinking "on" omits the param (adaptive)."""
    extra: dict = {}
    if str(thinking).lower() == "off":
        if model == "claude-sonnet-5-5":
            extra["thinking"] = {"type": "between_tools"}
        elif model == "claude-haiku-5-5":
            extra["thinking"] = {"type": "disabled"}
        else:
            _warn_once(f"model:{model}", "thinking=off is not mapped for model %s; leaving thinking at its default", model)
        if extra and effort not in _EFFORTS:
            _warn_once(f"effort:{effort}", "effort %s is above high and cannot be combined with thinking off; sending high", effort)
            effort = "high"
    return extra, effort

COACH_SYSTEM = """You are a warm, concise speech coach for deaf and hard-of-hearing learners practising the vowels ee (i), oo (u) and ah (a).
You receive measurements for ONE finished attempt, computed by code, plus the learner's recent history and notes.
Decide what to tell the learner next. Rules:
- Use only facts in the user message. Never invent numbers, scores, durations or diagnoses.
- observation: 1-2 plain sentences about what was measured. caption: at most 3 short sentences, max 240 characters, addressed to the learner, plain everyday language.
- Any digit you write must be a value from the fields you list in evidenceFields. Prefer words over digits.
- cueId: either the cue for this sound (given as thisSoundCue) or null. Use the cue when another try should show the mouth demo; null when the sound is on target or the capture was unclear.
- nextAction: "retry" (try this sound again), "next_sound" (on target, move on), or "rest" (several off attempts in a row, suggest a break). If the capture was insufficient, use retry with cueId null and ask for a clear voice and the face in view.
- Mention lips or jaw ONLY when video.verdict is present and not "insufficient". Never claim anything about the tongue; do not describe what the tongue did.
- Never use the words wrong, bad, fail or incorrect. Be encouraging and specific. Use history to tailor wording (for example a habit the learner repeats), but do not quote history numbers.
- evidenceFields: names chosen only from allowedEvidenceFields that support your message."""

NOTES_SYSTEM = """You maintain short private coaching notes for one learner practising the vowels ee (i), oo (u) and ah (a).
You receive their recent attempts (code-computed verdicts and offsets) and the previous notes. Produce updated notes:
- summary: at most 400 characters, plain language, what the learner finds hard and what is improving.
- struggles: up to 6 items {sound, pattern, count, lastAttemptId}; pattern at most 120 characters, a recurring difficulty seen in the attempts (for example "often lands too far back"). Only sounds that appear in the attempts. lastAttemptId must be an attemptId from the input or null.
- habits: up to 6 short strings (each at most 120 characters) about behaviour seen in the data (for example "usually needs a second try").
- Use only facts in the input. Do not write digits. Mention the tongue only when an attempt has articulation.claims, and then only as a comparison with the learner's best tries of that sound (for example "on some tries the tongue sat lower than on their best tries"), never as something you observed; otherwise never mention the tongue. Never use the words wrong, bad, fail or incorrect. Keep it kind and neutral."""


class ModelRefusal(DecisionError):
    pass


def build_client(settings: Settings, timeout_s: float):
    from anthropic import Anthropic

    return Anthropic(api_key=settings.anthropic_api_key, max_retries=0, timeout=timeout_s)


def _parse(
    client, settings: Settings, system: str, user: str, output_format: type[T], effort: str, max_tokens: int,
    model: str | None = None, thinking: str = "on",
) -> T:
    model = model or settings.anthropic_model
    extra, effort = request_options(model, thinking, effort)
    response = client.messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=output_format,
        output_config={"effort": effort},
        **extra,
    )
    if getattr(response, "stop_reason", None) == "refusal":
        raise ModelRefusal("model_refusal")
    parsed = getattr(response, "parsed_output", None)
    if parsed is None:
        raise DecisionError("empty_model_output")
    if isinstance(parsed, output_format):
        return parsed
    return output_format.model_validate(parsed)


async def ask(
    settings: Settings,
    client,
    system: str,
    user: str,
    output_format: type[T],
    effort: str,
    timeout_s: float,
    max_tokens: int,
    model: str | None = None,
    thinking: str = "on",
) -> T:
    """Run one structured call off the event loop with a hard timeout. Raises on any failure."""
    active = client or build_client(settings, timeout_s)
    return await asyncio.wait_for(
        asyncio.to_thread(_parse, active, settings, system, user, output_format, effort, max_tokens, model, thinking),
        timeout=timeout_s,
    )
