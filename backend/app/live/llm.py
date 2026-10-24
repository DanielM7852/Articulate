"""Claude Sonnet 5.5 calls for live coaching and learner notes (structured output, adaptive thinking)."""

import asyncio
from typing import TypeVar

from pydantic import BaseModel

from app.config import Settings
from app.live.decision import DecisionError

T = TypeVar("T", bound=BaseModel)

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
- Use only facts in the input. Do not write digits. Never claim what the tongue did. Never use the words wrong, bad, fail or incorrect. Keep it kind and neutral."""


class ModelRefusal(DecisionError):
    pass


def build_client(settings: Settings, timeout_s: float):
    from anthropic import Anthropic

    return Anthropic(api_key=settings.anthropic_api_key, max_retries=0, timeout=timeout_s)


def _parse(client, settings: Settings, system: str, user: str, output_format: type[T], effort: str, max_tokens: int) -> T:
    response = client.messages.parse(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=output_format,
        output_config={"effort": effort},
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
) -> T:
    """Run one structured call off the event loop with a hard timeout. Raises on any failure."""
    active = client or build_client(settings, timeout_s)
    return await asyncio.wait_for(
        asyncio.to_thread(_parse, active, settings, system, user, output_format, effort, max_tokens),
        timeout=timeout_s,
    )
