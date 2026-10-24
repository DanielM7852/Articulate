"""Evidence, validation, and the deterministic fallback for one live coaching decision.

The model only chooses wording, the cue, the next action, and which evidence fields to cite.
Everything it says is checked here, and any failure means the deterministic fallback is used.
"""

import re
from typing import Any

from app.live.schemas import AudioScore, ClientSummary, CoachDecision, EvidenceItem, VideoScore
from app.live.targets import SOUND_CUE, SOUND_SPELLING

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
            if name == "audio.inTargetFraction":
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
