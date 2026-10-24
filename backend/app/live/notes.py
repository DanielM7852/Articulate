"""Learner notes: Claude (effort LIVE_NOTES_EFFORT) updates what the learner struggles with; code grounds the counts."""

import json
import logging
import re
from typing import Any

from app.live import llm
from app.live.decision import DecisionError
from app.live.orchestrator import LiveDeps
from app.live.schemas import LearnerNotes, NotesDraft, Struggle
from app.live.targets import SOUND_SPELLING

logger = logging.getLogger(__name__)

NOTES_ATTEMPT_LIMIT = 50
_NOTES_TIMEOUT_FLOOR_S = 30.0

_SHAMING = re.compile(r"\b(wrong|bad|fail(?:ed|s|ure)?|incorrect)\b", re.IGNORECASE)
_TONGUE_CLAIM = re.compile(r"\btongue\b", re.IGNORECASE)
_COMPARISON = re.compile(
    r"\b(best|strongest|good)\b[^.!?]{0,30}\b(tries|attempts|ones)\b|\bearlier\b", re.IGNORECASE
)
_OBSERVATION = re.compile(r"\bI\s+(?:can\s+|could\s+)?(?:see|saw|noticed|watched|spotted)\b", re.IGNORECASE)
_SENTENCE_SPLIT = re.compile(r"[.!?;]+")


def has_articulation_claims(attempts: list[dict[str, Any]]) -> bool:
    for a in attempts:
        art = a.get("articulation")
        if isinstance(art, dict) and art.get("quality") == "ok" and art.get("claims"):
            return True
    return False


def _model_attempts(attempts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attempts as sent to the model: articulation claims keep only part/dimension/direction (no numeric deltas)."""
    out = []
    for a in attempts:
        art = a.get("articulation")
        if not isinstance(art, dict):
            out.append(a)
            continue
        claims = [
            {k: c[k] for k in ("part", "dimension", "direction") if k in c}
            for c in (art.get("claims") or [])
            if isinstance(c, dict)
        ]
        out.append({**a, "articulation": {"quality": art.get("quality"), "claims": claims}})
    return out


def _tongue_text_ok(texts: list[str]) -> bool:
    for t in texts:
        if not _TONGUE_CLAIM.search(t):
            continue
        if _OBSERVATION.search(t):
            return False
        for sentence in _SENTENCE_SPLIT.split(t):
            if _TONGUE_CLAIM.search(sentence) and not _COMPARISON.search(sentence):
                return False
    return True


def _is_miss(attempt: dict[str, Any]) -> bool:
    return attempt.get("audioVerdict") == "off" or attempt.get("videoVerdict") == "mismatch"


def miss_counts(attempts: list[dict[str, Any]]) -> dict[str, tuple[int, str | None]]:
    """Per sound: (count of off/mismatch attempts, most recent such attempt id). Attempts are newest first."""
    out: dict[str, tuple[int, str | None]] = {}
    for a in attempts:
        sound = a.get("sound")
        if sound not in SOUND_SPELLING or not _is_miss(a):
            continue
        count, last = out.get(sound, (0, None))
        out[sound] = (count + 1, last or a.get("attemptId"))
    return out


def fallback_notes(profile_id: str, attempts: list[dict[str, Any]]) -> LearnerNotes:
    counts = miss_counts(attempts)
    struggles = []
    for sound, (count, last) in sorted(counts.items(), key=lambda kv: -kv[1][0])[:6]:
        video_miss = any(a.get("sound") == sound and a.get("videoVerdict") == "mismatch" for a in attempts)
        audio_miss = any(a.get("sound") == sound and a.get("audioVerdict") == "off" for a in attempts)
        parts = []
        if audio_miss:
            parts.append("sound often lands away from the target area")
        if video_miss:
            parts.append("mouth shape often differs from what the sound needs")
        struggles.append(Struggle(sound=sound, pattern="; ".join(parts)[:120], count=count, lastAttemptId=last))
    if struggles:
        top = struggles[0]
        summary = f"Most recent practice: the {SOUND_SPELLING[top.sound]} sound needed the most extra tries."
    elif attempts:
        summary = "No repeated difficulties in recent practice."
    else:
        summary = "No practice recorded yet."
    return LearnerNotes(
        profileId=profile_id,
        summary=summary[:400],
        struggles=struggles,
        habits=[],
        attemptsConsidered=len(attempts),
        source="fallback",
    )


def _validate(draft: NotesDraft, attempts: list[dict[str, Any]]) -> NotesDraft:
    known = {a.get("attemptId") for a in attempts}
    texts = [draft.summary, *draft.habits, *(s.pattern for s in draft.struggles)]
    joined = " ".join(texts)
    if re.search(r"\d", joined):
        raise DecisionError("digits_in_notes")
    if _SHAMING.search(joined):
        raise DecisionError("notes_language")
    if _TONGUE_CLAIM.search(joined) and not (has_articulation_claims(attempts) and _tongue_text_ok(texts)):
        raise DecisionError("notes_language")
    if any(s.lastAttemptId is not None and s.lastAttemptId not in known for s in draft.struggles):
        raise DecisionError("unknown_attempt_id")
    counts = miss_counts(attempts)
    grounded = []
    for s in draft.struggles:
        if s.sound not in counts:
            continue  # the model may not invent a struggle the data does not show
        count, last = counts[s.sound]
        grounded.append(s.model_copy(update={"count": count, "lastAttemptId": last}))
    return draft.model_copy(update={"struggles": grounded})


async def update_notes(deps: LiveDeps, profile_id: str) -> LearnerNotes:
    history = deps.get_history()
    try:
        context = await history.load(profile_id, NOTES_ATTEMPT_LIMIT)
    except Exception as exc:  # noqa: BLE001
        logger.warning("notes history load failed: %s", type(exc).__name__)
        from app.live.history import LearnerContext

        context = LearnerContext()
    attempts = context.attempts
    notes = fallback_notes(profile_id, attempts)

    if attempts and deps.model_available:
        payload = json.dumps(
            {"recentAttempts": _model_attempts(attempts), "previousNotes": context.notes}, separators=(",", ":")
        )
        try:
            draft = await llm.ask(
                deps.settings,
                deps.anthropic_client,
                llm.NOTES_SYSTEM,
                payload,
                NotesDraft,
                deps.settings.live_notes_effort,
                max(deps.settings.live_coach_timeout_s, _NOTES_TIMEOUT_FLOOR_S),
                max_tokens=12000,
                model=deps.settings.live_notes_model,
            )
            draft = _validate(draft, attempts)
            notes = LearnerNotes(
                profileId=profile_id,
                summary=draft.summary,
                struggles=draft.struggles,
                habits=draft.habits,
                attemptsConsidered=len(attempts),
                source="agent",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("notes used fallback: %s", type(exc).__name__)

    if attempts:
        stored = notes.model_dump(exclude={"persisted"})
        try:
            notes.persisted = await history.save_notes(profile_id, stored)
        except Exception as exc:  # noqa: BLE001
            logger.warning("notes persist failed: %s", type(exc).__name__)
    return notes
