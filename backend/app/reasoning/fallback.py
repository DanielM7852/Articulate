"""Deterministic cue choice when Claude is unavailable or its output is rejected."""

from app.reasoning.validate import PREFERRED_ACTION
from app.schemas import CoachOutput, Cue, EvidenceItem

OBSERVATIONS = {
    "ending_direction_mismatch": "The ending pitch movement does not match the reference example.",
    "ending_range_smaller": "The ending movement is smaller than the reference example.",
    "ending_range_larger": "The ending movement is larger than the reference example.",
    "contour_close": "The pitch shape is close to the reference example.",
    "contour_differs": "The pitch shape differs from the reference example.",
    "insufficient_usable_pitch": "There was not enough usable pitch to compare this take.",
    "capture_problem": "The recording had a capture problem, so the pitch comparison is limited.",
    "alignment_failed": "The two recordings could not be lined up reliably.",
    "reference_unusable": "The reference example could not be measured for this comparison.",
}


def fallback_output(
    *,
    finding: str,
    evidence: list[EvidenceItem],
    cues: list[Cue],
) -> CoachOutput:
    cue = cues[0] if cues else None
    instruction = cue.instruction_text if cue else "Record the phrase again."
    cue_id = cue.cue_id if cue else "none"
    evidence_ids = [item.evidence_id for item in evidence] or ["ev-content"]
    return CoachOutput(
        evidence_ids=evidence_ids,
        finding=finding,  # type: ignore[arg-type]
        selected_cue_id=cue_id,
        observation=OBSERVATIONS[finding],
        instruction=instruction,
        next_action=PREFERRED_ACTION[finding],  # type: ignore[arg-type]
        limitations=[],
    )
