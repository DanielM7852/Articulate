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
    r"\b(best|strongest|good)\b[^.!?]{0,30}\b(tries|attempts|ones)\b|\bearlier\b"
    r"|\b(?:the\s+)?model\b|\ba clear (?:ee|oo|ah)\b",
    re.IGNORECASE,
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
    """Attempts as sent to the model: articulation claims keep only part/dimension/direction/basis (no numeric deltas)."""
    out = []
    for a in attempts:
        art = a.get("articulation")
        if not isinstance(art, dict):
            out.append(a)
            continue
        claims = [
            {k: c[k] for k in ("part", "dimension", "direction", "basis") if k in c}
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


WORD_VOWEL_SOUND = {"iy": "i", "uw": "u", "aa": "a"}


def word_vowel_misses(word_attempts: list[dict[str, Any]]) -> dict[str, tuple[int, str | None]]:
    """Per practice sound: (usable word turns whose matching vowel zone was missed, newest such attemptId)."""
    out: dict[str, tuple[int, str | None]] = {}
    for a in word_attempts:
        if a.get("quality") != "usable":
            continue
        sounds = {
            WORD_VOWEL_SOUND[z.get("phoneme")]
            for z in a.get("zones") or []
            if isinstance(z, dict)
            and z.get("kind") == "vowel"
            and z.get("inScope")
            and not z.get("advisory")
            and z.get("verdict") == "miss"
            and z.get("phoneme") in WORD_VOWEL_SOUND
        }
        for sound in sounds:
            count, last = out.get(sound, (0, None))
            out[sound] = (count + 1, last or a.get("attemptId"))
    return out


def practice_miss_counts(context: Any) -> dict[str, tuple[int, str | None]]:
    """Vowel-turn misses plus word-turn vowel misses; the last id is the newer one by timeline order."""
    merged = dict(miss_counts(context.attempts))
    order = {t.get("attemptId"): i for i, t in enumerate(context.timeline) if t.get("attemptId") is not None}
    for sound, (wcount, wlast) in word_vowel_misses(context.word_attempts).items():
        if sound not in merged:
            merged[sound] = (wcount, wlast)
            continue
        vcount, vlast = merged[sound]
        last = vlast
        if wlast in order and (vlast not in order or order[wlast] < order[vlast]):
            last = wlast  # newest first: smaller index is newer
        merged[sound] = (vcount + wcount, last)
    return merged


def fallback_notes(
    profile_id: str,
    attempts: list[dict[str, Any]],
    counts: dict[str, tuple[int, str | None]] | None = None,
    word_attempts: list[dict[str, Any]] | None = None,
) -> LearnerNotes:
    word_attempts = word_attempts or []
    counts = miss_counts(attempts) if counts is None else counts
    struggles = []
    for sound, (count, last) in sorted(counts.items(), key=lambda kv: -kv[1][0])[:6]:
        video_miss = any(a.get("sound") == sound and a.get("videoVerdict") == "mismatch" for a in attempts)
        audio_miss = any(a.get("sound") == sound and a.get("audioVerdict") == "off" for a in attempts)
        word_miss = sound in word_vowel_misses(word_attempts)
        parts = []
        if audio_miss:
            parts.append("sound often lands away from the target area")
        if video_miss:
            parts.append("mouth shape often differs from what the sound needs")
        if word_miss:
            parts.append("the vowel in practice words is often off target")
        struggles.append(Struggle(sound=sound, pattern="; ".join(parts)[:120], count=count, lastAttemptId=last))
    if struggles:
        top = struggles[0]
        summary = f"Most recent practice: the {SOUND_SPELLING[top.sound]} sound needed the most extra tries."
    elif attempts or word_attempts:
        summary = "No repeated difficulties in recent practice."
    else:
        summary = "No practice recorded yet."
    return LearnerNotes(
        profileId=profile_id,
        summary=summary[:400],
        struggles=struggles,
        habits=[],
        attemptsConsidered=len(attempts) + len(word_attempts),
        source="fallback",
    )


def _validate(
    draft: NotesDraft,
    attempts: list[dict[str, Any]],
    counts: dict[str, tuple[int, str | None]] | None = None,
    word_attempts: list[dict[str, Any]] | None = None,
) -> NotesDraft:
    known = {a.get("attemptId") for a in attempts} | {a.get("attemptId") for a in word_attempts or []}
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
    counts = miss_counts(attempts) if counts is None else counts
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
    word_attempts = context.word_attempts
    counts = practice_miss_counts(context)
    has_turns = bool(attempts or word_attempts)
    notes = fallback_notes(profile_id, attempts, counts, word_attempts)

    # The model reads vowel turns only; with word turns alone the deterministic notes are the better summary.
    if attempts and deps.model_available:
        payload = json.dumps(
            {"recentAttempts": _model_attempts(attempts), "previousNotes": context.notes}, separators=(",", ":")
        )
        try:
            draft = await llm.ask(
                deps.settings,
                deps.llm_client,
                llm.NOTES_SYSTEM,
                payload,
                NotesDraft,
                deps.settings.live_notes_effort,
                max(deps.settings.live_coach_timeout_s, _NOTES_TIMEOUT_FLOOR_S),
                max_tokens=12000,
                model=deps.settings.live_notes_model,
                purpose="notes",
            )
            draft = _validate(draft, attempts, counts, word_attempts)
            # Keep counted struggles the model did not name (for example word-lesson vowel misses it never saw).
            named = {s.sound for s in draft.struggles}
            extra = [s for s in notes.struggles if s.sound not in named]
            notes = LearnerNotes(
                profileId=profile_id,
                summary=draft.summary,
                struggles=[*draft.struggles, *extra][:6],
                habits=draft.habits,
                attemptsConsidered=len(attempts) + len(word_attempts),
                source="agent",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("notes used fallback: %s", type(exc).__name__)

    if has_turns:
        stored = notes.model_dump(exclude={"persisted"})
        try:
            notes.persisted = await history.save_notes(profile_id, stored)
        except Exception as exc:  # noqa: BLE001
            logger.warning("notes persist failed: %s", type(exc).__name__)
    return notes
