"""Claude Sonnet 5.5 calls for live coaching and learner notes (structured output, adaptive thinking)."""

import asyncio
import base64
import logging
from typing import TypeVar

from pydantic import BaseModel

from app.config import Settings
from app import telemetry
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

WORD_COACH_SYSTEM = """You are Ava, a warm, concise speech coach for a deaf or hard-of-hearing adult practising one English word on a visual board.
You receive ONE finished word attempt: the word, its zones in order (each a sound part with a label, a kind, a body hint, an advisory flag, a code-computed verdict hit / partial / miss / skipped, and measured evidence), the weakest zone chosen by code, the practiceZoneIds when the learner is practising only part of the word, and the learner's notes.
The board draws a model "ghost path" for the word and the learner follows it. Vowels and liquids (r) are judged by how closely the learner's path follows the ghost: pathDistance is the mean distance from the ghost path in close-zone units (1 or less means inside the close zone), closeFraction the share of path points inside the close zone. Stops are judged by a detected release burst. Fricatives (sh) and nasals (n) cannot be judged from a microphone in real time.
Write the one short coaching line Ava says next. Rules:
- Use only facts in the user message. Never invent numbers, scores, durations or diagnoses. Prefer words over digits; any digit you write must be a value from the fields you list in evidenceFields.
- caption: what Ava says, at most 2 short sentences and 160 characters, in plain everyday language. Name the zone you coach by its label in the form "the <label>" (for example "the ck" or "the r"), or say the word itself.
- Give a body-based instruction: where the tongue, lips or jaw go, or what to do with the breath, usually from that zone's hint. Never tell the learner to listen or to hear anything, and never describe how something sounds.
- At most one sentence of praise. Never use the words wrong, bad, fail or incorrect.
- Mention lips or jaw ONLY when lipUsable is true. You may instruct the tongue (for example "back of the tongue up"), but never claim what the tongue did; it is not measured.
- focusZoneId: the zone id you coach, one of the zone ids given; normally weakestZone.id. null only when every zone was hit or the capture was unclear, or when you are speaking about the joined-up part. When practiceZoneIds is given, focus only on a zone in that list (or speak about the joined-up part when the list covers several zones, with focusZoneId null or the weakest of them); never coach a zone outside it.
- When practiceZoneIds is given, the learner says only that part on its own (for "track" with ["t","r"] they say just "tr"). Ask for that part by its joined labels ("the tr"), never ask them to say the whole word.
- Advisory zones (advisory true: liquid, fricative, nasal) are never judged and never count toward the verdict. Never say a fricative, nasal or liquid was right, wrong, hit, missed or good. When one is the focus, coach it only with its body hint and the 3D side view, with no verdict language and no praise.
- cueId: the cue given for the focus zone (focusZoneCue) when another try should show the mouth demo, else null. Tongue zones have no cue; Ava turns to the side view for them automatically.
- nextAction: "retry" (say the word, or the practised part, again), "next_sound" (every zone was hit; the word is done), or "rest" (several attempts with no progress). If the capture was unclear, use retry with cueId null and ask for one clear, steady try.
- observation: 1-2 plain sentences about what the board measured, for the record.
- evidenceFields: names chosen only from allowedEvidenceFields that support your message.
- acoustics, when present, was measured by code from a recording of this attempt (Praat). It is evidence, not a verdict: use it only to choose which zone's body instruction to give and how to word it. Never say a zone was right, wrong, hit or missed because of it, never claim where the tongue, lips or jaw were, and never write its numbers. liquid f3Drop is the r's lowest F3 divided by this take's vowel F3 (lower means a stronger r colour); fricative cogHz is the spectral centre of gravity (sh is usually lower than s); nasal lowBandRatio is the share of energy below 500 Hz.
- azure, when present, comes from an automatic pronunciation assessor trained on hearing speakers, run on this recording of the whole word. It is evidence, not a verdict, and the board's verdicts stand: use it only to choose which sound to focus on (zoneAccuracy is per zone id; below passScore marks the sound most worth coaching) and how to word the instruction. A phoneme's nbest lists what the assessor thought it heard instead; you may use that as a hint in body terms, but never put numbers or scores in the caption, the observation or the cue, never say an assessor or a score judged anything, and never claim where the tongue, lips or jaw were."""

WORD_COACH_AUDIO_NOTE = (
    "A recording of this attempt is attached. The board's verdicts and evidence are the measurement and they stand: "
    "never contradict a verdict, never say a zone was hit or missed because of the recording, and never describe how "
    "the recording sounds. Use the recording only to notice when no clear speech, or a different word, was said "
    "(then use nextAction retry with cueId null and ask for one clear try of the word), and to choose which body "
    "instruction from the hints best fits this try."
)

NOTES_SYSTEM = """You maintain short private coaching notes for one learner practising the vowels ee (i), oo (u) and ah (a).
You receive their recent attempts (code-computed verdicts and offsets) and the previous notes. Produce updated notes:
- summary: at most 400 characters, plain language, what the learner finds hard and what is improving.
- struggles: up to 6 items {sound, pattern, count, lastAttemptId}; pattern at most 120 characters, a recurring difficulty seen in the attempts (for example "often lands too far back"). Only sounds that appear in the attempts. lastAttemptId must be an attemptId from the input or null.
- habits: up to 6 short strings (each at most 120 characters) about behaviour seen in the data (for example "usually needs a second try").
- Use only facts in the input. Do not write digits. Mention the tongue only when an attempt has articulation.claims, and then only as a comparison: with the learner's best tries of that sound (for example "on some tries the tongue sat lower than on their best tries") or, when a claim has basis reference or both, with a clear ee, oo or ah (for example "on some tries the tongue sat lower than in a clear ee"), never as something you observed; otherwise never mention the tongue. Never use the words wrong, bad, fail or incorrect. Keep it kind and neutral."""


class ModelRefusal(DecisionError):
    pass


def is_openai(settings: Settings) -> bool:
    return settings.live_coach_provider == "openai"


def model_configured(settings: Settings, client=None) -> bool:
    """Whether a live model call can be attempted: an injected client, or the active provider's key."""
    if client is not None:
        return True
    return settings.openai_configured if is_openai(settings) else settings.anthropic_configured


def build_client(settings: Settings, timeout_s: float):
    from anthropic import Anthropic

    return Anthropic(api_key=settings.anthropic_api_key, max_retries=0, timeout=timeout_s)


def build_openai_client(settings: Settings, timeout_s: float):
    from openai import OpenAI

    return OpenAI(api_key=settings.openai_api_key, max_retries=0, timeout=timeout_s)


def _parse(
    client, settings: Settings, system: str, user: str, output_format: type[T], effort: str, max_tokens: int,
    model: str | None = None, thinking: str = "on", purpose: str = "decide", audio_wav: bytes | None = None,
) -> T:
    if audio_wav:
        _warn_once("audio:anthropic", "attempt audio is ignored by the Anthropic live path")
    model = model or settings.anthropic_model
    extra, effort = request_options(model, thinking, effort)
    response = telemetry.claude_call(model, purpose, lambda: client.messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=output_format,
        output_config={"effort": effort},
        **extra,
    ))
    if getattr(response, "stop_reason", None) == "refusal":
        raise ModelRefusal("model_refusal")
    parsed = getattr(response, "parsed_output", None)
    if parsed is None:
        raise DecisionError("empty_model_output")
    if isinstance(parsed, output_format):
        return parsed
    return output_format.model_validate(parsed)


_BACKGROUND_PURPOSES = ("notes", "insight")


def _parse_openai(
    client, settings: Settings, system: str, user: str, output_format: type[T], effort: str, max_tokens: int,
    purpose: str = "decide", audio_wav: bytes | None = None,
) -> T:
    if audio_wav:
        import openai

        model = settings.live_openai_audio_model
        data = base64.b64encode(audio_wav).decode("ascii")
        # gpt-audio takes no reasoning_effort and rejects text-only input, so this branch is audio only.
        kwargs: dict = dict(
            model=model,
            modalities=["text"],
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user},
                    {"type": "input_audio", "input_audio": {"data": data, "format": "wav"}},
                ]},
            ],
            tools=[openai.pydantic_function_tool(output_format, name="submit")],
            tool_choice={"type": "function", "function": {"name": "submit"}},
            max_completion_tokens=max_tokens,
        )
    else:
        model = settings.live_openai_background_model if purpose in _BACKGROUND_PURPOSES else settings.live_openai_model
        kwargs = dict(
            model=model,
            reasoning_effort="high" if effort in ("xhigh", "max") else effort,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format=output_format,
            max_completion_tokens=max_tokens,
        )
    response = telemetry.claude_call(model, purpose, lambda: client.chat.completions.parse(**kwargs), provider="openai")
    message = response.choices[0].message
    if getattr(message, "refusal", None):
        raise ModelRefusal("model_refusal")
    parsed = telemetry.parsed_of(response)
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
    purpose: str = "decide",
    audio_wav: bytes | None = None,
) -> T:
    """Run one structured call off the event loop with a hard timeout. Raises on any failure.

    `client` is the active provider's client. On OpenAI the Claude `model` and `thinking` are ignored.
    """
    if is_openai(settings):
        active = client or build_openai_client(settings, timeout_s)
        return await asyncio.wait_for(
            asyncio.to_thread(
                _parse_openai, active, settings, system, user, output_format, effort, max_tokens, purpose, audio_wav
            ),
            timeout=timeout_s,
        )
    active = client or build_client(settings, timeout_s)
    return await asyncio.wait_for(
        asyncio.to_thread(
            _parse, active, settings, system, user, output_format, effort, max_tokens, model, thinking, purpose, audio_wav
        ),
        timeout=timeout_s,
    )
