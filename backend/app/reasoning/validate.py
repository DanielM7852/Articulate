"""Server-side checks for a coaching response.

Structured decoding guarantees JSON shape. These checks guarantee that the
content stays inside the measurements and the approved cue list.
"""

import re

from app.errors import CoachValidationError
from app.schemas import CoachOutput, Cue, EvidenceItem, FindingCode

_BANNED = re.compile(
    r"\b(tongue|lips?|jaw|palate|velum|glottis|larynx|pharynx|articulators?|vocal folds?)\b",
    re.IGNORECASE,
)
_DIGITS = re.compile(r"\d")

ALLOWED_ACTIONS: dict[str, set[str]] = {
    "insufficient_usable_pitch": {"rerecord"},
    "capture_problem": {"rerecord"},
    "alignment_failed": {"rerecord"},
    "reference_unusable": {"pause"},
    "ending_direction_mismatch": {"repeat", "isolate_segment"},
    "ending_range_smaller": {"repeat", "isolate_segment"},
    "ending_range_larger": {"repeat", "isolate_segment"},
    "contour_differs": {"repeat", "change_cue"},
    "contour_close": {"reduce_assistance", "repeat"},
}

PREFERRED_ACTION = {
    "insufficient_usable_pitch": "rerecord",
    "capture_problem": "rerecord",
    "alignment_failed": "rerecord",
    "reference_unusable": "pause",
    "ending_direction_mismatch": "isolate_segment",
    "ending_range_smaller": "isolate_segment",
    "ending_range_larger": "isolate_segment",
    "contour_differs": "repeat",
    "contour_close": "reduce_assistance",
}


def _normalize(text: str) -> str:
    return " ".join(text.split())


def validate_coach_output(
    output: CoachOutput,
    *,
    finding: FindingCode | str,
    evidence: list[EvidenceItem],
    cues: list[Cue],
) -> CoachOutput:
    if output.finding != finding:
        raise CoachValidationError("finding_not_supported")
    known_evidence = {item.evidence_id for item in evidence}
    if not output.evidence_ids or any(item not in known_evidence for item in output.evidence_ids):
        raise CoachValidationError("unknown_evidence_id")
    selected = next((cue for cue in cues if cue.cue_id == output.selected_cue_id), None)
    if selected is None:
        raise CoachValidationError("unknown_cue_id")
    if _normalize(output.instruction) != _normalize(selected.instruction_text):
        raise CoachValidationError("instruction_not_from_cue")
    if output.next_action not in ALLOWED_ACTIONS[output.finding]:
        raise CoachValidationError("next_action_incompatible")
    observation = output.observation.strip()
    if not observation or len(observation) > 280 or _DIGITS.search(observation):
        raise CoachValidationError("observation_bounds")
    if _BANNED.search(observation) or _BANNED.search(output.instruction):
        raise CoachValidationError("anatomical_claim")
    limitations = []
    for item in output.limitations[:4]:
        text = item.strip()
        if text and len(text) <= 160 and not _BANNED.search(text):
            limitations.append(text)
    return output.model_copy(
        update={
            "observation": observation,
            "instruction": selected.instruction_text,
            "limitations": limitations,
        }
    )
