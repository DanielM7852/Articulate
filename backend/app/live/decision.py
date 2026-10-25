"""Evidence, validation, and the deterministic fallback for one live coaching decision.

The model only chooses wording, the cue, the next action, and which evidence fields to cite.
Everything it says is checked here, and any failure means the deterministic fallback is used.
"""

import re
from typing import Any

from app.live.scoring import practice_scope
from app.live.schemas import AudioScore, ClientSummary, CoachDecision, EvidenceItem, VideoScore, WordAttempt, WordScore
from app.live.targets import SOUND_CUE, SOUND_SPELLING
from app.live.words import ZONE_CUE, ZoneInfo, word_info

CAPTION_MAX = 240
CAPTION_MAX_SENTENCES = 3
OBSERVATION_MAX = 400


class DecisionError(ValueError):
    pass


_SHAMING = re.compile(r"\b(wrong|bad|fail(?:ed|s|ure)?|incorrect|terrible|awful|poor)\b", re.IGNORECASE)
_BODY = re.compile(r"\b(lips?|jaw)\b", re.IGNORECASE)
_TONGUE = re.compile(r"\btongue\b", re.IGNORECASE)
_TONGUE_CLAIM = re.compile(
    r"\btongue\s+(?:\w+\s+)?(?:was|were|is|are|has|had|stayed|moved|went|did|sat|touched|rose|dropped|\w+ed)\b",
    re.IGNORECASE,
)
_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def evidence_candidates(audio: AudioScore, video: VideoScore | None, client: ClientSummary) -> dict[str, float | str]:
    """Every value the model may cite, keyed by field name. Values come only from the scores."""
    raw: dict[str, Any] = {
        "audio.verdict": audio.verdict,
        "audio.voicedFrames": audio.voicedFrames,
        "audio.inTargetFraction": audio.inTargetFraction,
        "audio.f1Offset": audio.f1Offset,
        "audio.f2Offset": audio.f2Offset,
        "client.usableVoicedSec": client.usableVoicedSec,
        "client.timeInTargetSec": client.timeInTargetSec,
        "client.longestHoldSec": client.longestHoldSec,
    }
    if video is not None:
        raw.update(
            {
                "video.verdict": video.verdict,
                "video.roundingMean": video.roundingMean,
                "video.spreadMean": video.spreadMean,
                "video.lipOpeningMean": video.lipOpeningMean,
                "video.jawDropMean": video.jawDropMean,
            }
        )
    out: dict[str, float | str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        out[key] = round(value, 2) if isinstance(value, float) else value
    return out


def _number_tokens(candidates: dict[str, float | str], fields: list[str]) -> set[str]:
    tokens: set[str] = set()
    for name in fields:
        value = candidates.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            tokens.update({f"{round(value, 2):g}", f"{round(value, 1):g}", str(int(round(value))), f"{value:.2f}", f"{value:.1f}"})
            if name.endswith("Fraction"):  # audio.inTargetFraction, word.<zone>.inBandFraction, ...
                tokens.add(str(int(round(value * 100))))
    return tokens


def _sentences(text: str) -> int:
    return len([s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()])


def validate_decision(
    decision: CoachDecision,
    sound: str,
    audio: AudioScore,
    video: VideoScore | None,
    candidates: dict[str, float | str],
) -> list[EvidenceItem]:
    """Raise DecisionError on any rule violation; otherwise return server-built evidence."""
    if decision.cueId not in (None, SOUND_CUE[sound]):
        raise DecisionError("cue_not_for_sound")
    if audio.verdict == "insufficient" and (decision.cueId is not None or decision.nextAction != "retry"):
        raise DecisionError("insufficient_capture_needs_retry")
    fields = list(dict.fromkeys(decision.evidenceFields))
    if any(f not in candidates for f in fields):
        raise DecisionError("unknown_evidence_field")
    if not fields:
        fields = ["audio.verdict"]
    observation = decision.observation.strip()
    caption = decision.caption.strip()
    if not observation or len(observation) > OBSERVATION_MAX:
        raise DecisionError("observation_length")
    if not caption or len(caption) > CAPTION_MAX or _sentences(caption) > CAPTION_MAX_SENTENCES:
        raise DecisionError("caption_length")
    text = f"{observation} {caption}"
    allowed = _number_tokens(candidates, fields)
    if any(n not in allowed for n in _NUMBER.findall(text)):
        raise DecisionError("number_not_in_evidence")
    if _SHAMING.search(text):
        raise DecisionError("shaming_language")
    if (video is None or video.verdict == "insufficient") and _BODY.search(text):
        raise DecisionError("body_claim_without_video")
    if _TONGUE.search(text) and (decision.cueId is None or _TONGUE_CLAIM.search(text)):
        raise DecisionError("tongue_claim")
    return [EvidenceItem(field=f, value=candidates[f]) for f in fields]


def show_side_view(cue_id: str | None, next_action: str) -> bool:
    return cue_id is not None and next_action == "retry"


def fallback_decision(
    sound: str,
    audio: AudioScore,
    video: VideoScore | None,
    candidates: dict[str, float | str],
    recent: list[dict[str, Any]],
) -> tuple[CoachDecision, list[EvidenceItem]]:
    """Wording built only from the scores. Never makes a tongue claim, and mentions lips/jaw only with usable video."""
    spelled = SOUND_SPELLING[sound]
    cue = SOUND_CUE[sound]
    body_ok = video is not None and video.verdict != "insufficient"
    fields = ["audio.verdict"]

    if audio.verdict == "insufficient":
        observation = f"I could not hear enough steady voice to measure your {spelled}."
        caption = f"Let's try again. Hold a clear {spelled} and keep your face toward the screen."
        cue_id, action = None, "retry"
    elif audio.verdict == "on_target":
        observation = f"Your {spelled} landed in the target area."
        caption = "Nice and steady. Ready for the next sound when you are."
        cue_id, action = None, "next_sound"
        fields.append("audio.inTargetFraction")
    else:
        near = audio.verdict == "close"
        observation = (
            f"Your {spelled} was close to the target area." if near else f"Your {spelled} sat away from the target area."
        )
        caption = "Watch the demo, then try once more."
        if body_ok and video is not None and video.verdict in ("partly", "mismatch"):
            if sound == "u":
                observation += " The camera saw your lips only partly rounded."
                caption = "Round your lips a little more, then try again."
            elif sound == "i":
                observation += " The camera saw your lips only partly spread."
                caption = "Spread your lips a little wider, then try again."
            else:
                observation += " The camera saw your jaw only partly open."
                caption = "Open your jaw a little more, then try again."
            fields.append("video.verdict")
        elif body_ok and video is not None and video.verdict == "matches":
            observation += " The camera saw the lip shape this sound needs."
            fields.append("video.verdict")
        cue_id, action = cue, "retry"
        misses = [a for a in recent[:3] if a.get("sound") == sound and a.get("audioVerdict") == "off"]
        if audio.verdict == "off" and len(misses) >= 2:
            action = "rest"
            caption = "Let's take a short break, then come back to it."
    fields = [f for f in fields if f in candidates]
    decision = CoachDecision(observation=observation, caption=caption, cueId=cue_id, nextAction=action, evidenceFields=fields)
    return decision, [EvidenceItem(field=f, value=candidates[f]) for f in fields]


# How many earlier tries may repeat one instruction before the next line steps down.
SAME_INSTRUCTION_LIMIT = 2


def _still_missing(attempt: dict[str, Any]) -> bool:
    verdict = attempt.get("wordVerdict") or attempt.get("audioVerdict")
    return verdict in ("off", "close")


def _same_instruction(attempt: dict[str, Any], sound: str, decision: CoachDecision) -> bool:
    if attempt.get("sound") != sound or attempt.get("cueId") != decision.cueId:
        return False
    if attempt.get("nextAction") not in (None, "retry"):
        return False
    focus = decision.focusZoneId
    if focus and attempt.get("focusZoneId") not in (None, focus):
        return False
    return _still_missing(attempt)


def ease_repeated_instruction(
    decision: CoachDecision,
    *,
    sound: str,
    recent: list[dict[str, Any]],
    word: WordAttempt | None = None,
) -> CoachDecision | None:
    """Replace a cue that has already been given twice without the target landing.

    The learner hears a shorter task instead of the same instruction again.
    Returns None when this decision should stand.
    """
    if decision.nextAction != "retry":
        return None
    repeated = [a for a in recent if _same_instruction(a, sound, decision)]
    if len(repeated) < SAME_INSTRUCTION_LIMIT:
        return None
    if word is None:
        spelled = SOUND_SPELLING[sound]
        caption = f"Let's make this easier. Hold a short {spelled} for just a moment, with the picture in front of you."
        observation = f"The same cue has come up again, and the {spelled} has not landed in the target area yet."
    else:
        info = zone_info(word, decision.focusZoneId) if decision.focusZoneId else None
        if info is not None:
            caption = f"Let's make this easier. Leave {word.word} for now and shape only the {info.label}."
            observation = f"The same cue for the {info.label} has come up again, and that part of {word.word} has not landed yet."
        else:
            caption = f"Let's make this easier. Say {word.word} in two short pieces instead of all at once."
            observation = f"The same cue has come up again, and {word.word} has not landed yet."
    return decision.model_copy(update={"observation": observation, "caption": caption})


# ---- Word mode ----
#
# Evidence field names are flattened: word.verdict, word.hitCount, word.zoneCount, word.weakestZoneId,
# word.durationMs, and per zone word.<zoneId>.verdict, word.<zoneId>.dwellMs and word.<zoneId>.<key> for every
# key in that zone's evidence (f1Median, inBandFraction, burstDetected, spreadMean, ...).

WORD_CAPTION_MAX = 200
WORD_CAPTION_MAX_SENTENCES = 2
WORD_PRAISE_MAX_SENTENCES = 1

_PRAISE = re.compile(
    r"\b(nice|great|good|well done|lovely|excellent|perfect|beautiful|awesome|brilliant|wonderful|fantastic|amazing|super)\b",
    re.IGNORECASE,
)
# Deaf and hard-of-hearing learners: instructions are about the body and the board, never about listening.
_LISTEN = re.compile(r"\b(listen\w*|hear\w*|sounds? like)\b", re.IGNORECASE)
# Advisory parts (liquid, fricative, nasal) are never judged, so a line about one may not praise or grade it.
_JUDGE = re.compile(r"\b(right|correct|nailed|hit|missed?|landed|reached|got it|spot on)\b", re.IGNORECASE)
_QUOTES_OPEN = "\"'“‘"
_QUOTES_CLOSE = "\"'”’"


def word_evidence_candidates(word: WordAttempt, score: WordScore) -> dict[str, float | str]:
    raw: dict[str, Any] = {
        "word.verdict": score.verdict,
        "word.hitCount": score.hitCount,
        "word.zoneCount": score.zoneCount,
        "word.weakestZoneId": score.weakestZoneId,
        "word.durationMs": int(round(word.durationMs)),
    }
    for zone in word.zones:
        raw[f"word.{zone.zoneId}.verdict"] = zone.verdict
        raw[f"word.{zone.zoneId}.dwellMs"] = int(round(zone.dwellMs))
        for key, value in zone.evidence.items():
            raw[f"word.{zone.zoneId}.{key}"] = value
    out: dict[str, float | str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        out[key] = round(value, 2) if isinstance(value, float) else value
    return out


def zone_info(word: WordAttempt, zone_id: str) -> ZoneInfo | None:
    """Server copy of the zone (label, hint, position); a generic entry for words the server does not know."""
    info = word_info(word.word)
    if info is not None:
        found = info.zone(zone_id)
        if found is not None:
            return found
    zone = next((z for z in word.zones if z.zoneId == zone_id), None)
    if zone is None:
        return None
    generic = "Watch the side view, then try once more."
    return ZoneInfo(zone.zoneId, zone.phoneme, zone.phoneme, zone.kind, generic, generic, "")


def _mentions_label(text: str, label: str) -> bool:
    """A zone label counts as mentioned when quoted, or written as "the <label>" or "<label> sound"."""
    lab = re.escape(label)
    pattern = rf"([{_QUOTES_OPEN}]{lab}[{_QUOTES_CLOSE}])|\bthe\s+{lab}\b|\b{lab}\s+sound\b"
    return re.search(pattern, text, re.IGNORECASE) is not None


def validate_word_decision(
    decision: CoachDecision,
    word: WordAttempt,
    score: WordScore,
    candidates: dict[str, float | str],
    practice: list[str] | None = None,
) -> list[EvidenceItem]:
    """Every vowel-mode rule that applies to words, plus the word rules. Raises DecisionError on any violation.

    `practice` (practiceZoneIds): the focus zone must come from that list.
    """
    zone_ids = set(practice_scope(word, practice))
    focus = decision.focusZoneId
    if focus is not None and focus not in zone_ids:
        raise DecisionError("focus_zone_unknown")
    if decision.cueId is not None and (focus is None or ZONE_CUE.get(focus) != decision.cueId):
        raise DecisionError("cue_not_for_zone")
    if score.verdict == "insufficient" and (decision.cueId is not None or decision.nextAction != "retry"):
        raise DecisionError("insufficient_capture_needs_retry")
    fields = list(dict.fromkeys(decision.evidenceFields))
    if any(f not in candidates for f in fields):
        raise DecisionError("unknown_evidence_field")
    if not fields:
        fields = ["word.verdict"]
    observation = decision.observation.strip()
    caption = decision.caption.strip()
    if not observation or len(observation) > OBSERVATION_MAX:
        raise DecisionError("observation_length")
    if not caption or len(caption) > WORD_CAPTION_MAX or _sentences(caption) > WORD_CAPTION_MAX_SENTENCES:
        raise DecisionError("caption_length")
    text = f"{observation} {caption}"
    allowed = _number_tokens(candidates, fields)
    if any(n not in allowed for n in _NUMBER.findall(text)):
        raise DecisionError("number_not_in_evidence")
    if _SHAMING.search(text):
        raise DecisionError("shaming_language")
    if not word.lipUsable and _BODY.search(text):
        raise DecisionError("body_claim_without_video")
    # Tongue instructions are the point of word coaching; claims about what the tongue did are not measured.
    if _TONGUE_CLAIM.search(text):
        raise DecisionError("tongue_claim")
    if _LISTEN.search(text):
        raise DecisionError("listening_language")
    focus_zone = next((z for z in word.zones if z.zoneId == focus), None)
    if focus_zone is not None and focus_zone.is_advisory and (_JUDGE.search(text) or _PRAISE.search(text)):
        raise DecisionError("judged_advisory_zone")
    sentences = [x for x in re.split(r"(?<=[.!?])\s+", caption) if x.strip()]
    if sum(1 for x in sentences if _PRAISE.search(x)) > WORD_PRAISE_MAX_SENTENCES:
        raise DecisionError("too_much_praise")
    mentions_word = re.search(rf"\b{re.escape(word.word)}\b", caption, re.IGNORECASE) is not None
    if focus is not None:
        info = zone_info(word, focus)
        if not (mentions_word or (info is not None and _mentions_label(caption, info.label))):
            raise DecisionError("caption_misses_focus")
    elif not mentions_word:
        raise DecisionError("caption_misses_word")
    return [EvidenceItem(field=f, value=candidates[f]) for f in fields]


def word_show_side_view(focus_zone_id: str | None, next_action: str) -> bool:
    """Word coaching is about the tongue, so any retry with a focus zone turns Ava to the side cutaway."""
    return focus_zone_id is not None and next_action == "retry"


_INSUFFICIENT = {
    "clipped": ("The capture was too loud to read clearly.", "That was a bit loud for me. Say {word} once more, a little softer."),
    "too-short": ("The capture was too short to read every part.", "That went by quickly. Say {word} once more, at an easy pace."),
}
_INSUFFICIENT_DEFAULT = (
    "The capture did not have enough clear voice to read.",
    "I couldn't catch {word} that time. Say it once more, clear and steady.",
)


def _first_sentence(text: str) -> str:
    parts = [x for x in re.split(r"(?<=[.!?])\s+", text.strip()) if x.strip()]
    return parts[0] if parts else text.strip()


def word_fallback_line(
    word: WordAttempt, score: WordScore, practice: list[str] | None = None
) -> tuple[str, str, str | None]:
    """(observation, caption, focusZoneId) built only from the verdicts and the zone hints.

    web/src/live/wordCoach.ts builds the same caption when the backend cannot be reached; keep them in sync.
    """
    name = word.word
    if score.verdict == "insufficient":
        obs, cap = _INSUFFICIENT.get(word.qualityReason or "", _INSUFFICIENT_DEFAULT)
        return obs, cap.format(word=name), None
    if score.weakestZoneId is None:
        if practice is not None:
            return (
                f"The board marked the practised part of {name} as hit.",
                f"That part of {name} landed. Nice work.",
                None,
            )
        return f"The board marked every part of {name} as hit.", f"Every part of {name} landed. Nice work.", None
    zone_id = score.weakestZoneId
    zone = next(z for z in word.zones if z.zoneId == zone_id)
    info = zone_info(word, zone_id)
    assert info is not None
    where = f" {info.position}" if info.position else ""
    hint = _first_sentence(info.hint if word.lipUsable else info.hint_no_camera)
    if zone.is_advisory:
        # Cue-only part: taught from the hint and the side view, never graded.
        return (
            f"The {info.label}{where} is a part the board does not judge.",
            f"Let's work on the {info.label}{where}. {hint}",
            zone_id,
        )
    if zone.verdict == "partial":
        observation = f"The board marked the {info.label}{where} as partly there."
        lead = f"The {info.label}{where} was faint." if zone.kind == "stop" else f"The {info.label}{where} was nearly there."
    else:
        observation = f"The board marked the {info.label}{where} as missed."
        lead = (
            f"The {info.label}{where} went missing."
            if zone.kind == "stop" or zone.verdict == "skipped"
            else f"The {info.label}{where} didn't reach its target yet."
        )
    return observation, f"{lead} {hint}", zone_id


def word_fallback_decision(
    word: WordAttempt,
    score: WordScore,
    candidates: dict[str, float | str],
    practice: list[str] | None = None,
) -> tuple[CoachDecision, list[EvidenceItem]]:
    observation, caption, focus = word_fallback_line(word, score, practice)
    action = "next_sound" if score.verdict == "on_target" else "retry"
    cue = ZONE_CUE.get(focus) if focus is not None and action == "retry" else None
    wanted = ["word.verdict"] + ([f"word.{focus}.verdict"] if focus else [])
    fields = [f for f in wanted if f in candidates]
    decision = CoachDecision(
        observation=observation, caption=caption, cueId=cue, nextAction=action, evidenceFields=fields, focusZoneId=focus
    )
    return decision, [EvidenceItem(field=f, value=candidates[f]) for f in fields]
