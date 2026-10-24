from uuid import UUID

from .schemas import TARGETS, AttemptSummary, CoachingDecision, Cue

REPAIR = "There was not enough usable speech to measure this attempt."
MEASURED = "This attempt contains enough usable audio to compare its acoustic position."


def observation(summary: AttemptSummary):
    return MEASURED if "target_distance" in summary.evidence_fields else REPAIR


def fallback(summary: AttemptSummary, generation: UUID, cues: list[Cue]):
    usable = "target_distance" in summary.evidence_fields
    cue = cues[0] if usable and cues else None
    return CoachingDecision(
        attempt_id=summary.attempt_id,
        generation_id=generation,
        observation=observation(summary),
        evidence_fields=["usable_duration_ms"],
        cue_id=cue.id if cue else None,
        cue_version=cue.version if cue else None,
        pose_id=cue.pose_id if cue else "neutral",
        next_action="repeat" if cue else "repair_capture" if not usable else "pause",
    )


def validate_decision(
    decision: CoachingDecision,
    summary: AttemptSummary,
    generation: UUID,
    cues: list[Cue],
    *,
    allow_demo=False,
):
    if decision.attempt_id != summary.attempt_id or decision.generation_id != generation:
        raise ValueError("stale decision identity")
    if not decision.evidence_fields or not set(decision.evidence_fields) <= set(summary.evidence_fields):
        raise ValueError("unsupported evidence")
    # Wording is an allowlist. A schema-valid model response is not factual validation.
    if decision.observation != observation(summary) or decision.narration is not None:
        raise ValueError("unsupported observation or narration")
    if "target_distance" not in summary.evidence_fields:
        if decision.next_action != "repair_capture" or decision.cue_id or decision.pose_id != "neutral":
            raise ValueError("invalid capture requires repair")
    elif decision.cue_id is None:
        if decision.next_action != "pause" or decision.pose_id != "neutral":
            raise ValueError("no eligible cue")
    else:
        cue = next((c for c in cues if c.id == decision.cue_id), None)
        if (
            not cue
            or cue.version != decision.cue_version
            or cue.pose_id != decision.pose_id
            or summary.target_id not in cue.target_ids
            or cue.language != "en"
            or cue.pose_id != TARGETS[summary.target_id].pose_id
            or cue.review_status not in ({"approved", "demo_unreviewed"} if allow_demo else {"approved"})
        ):
            raise ValueError("ineligible cue/version/pose")
        if decision.next_action not in ("repeat", "change_cue", "simplify", "reduce_assistance", "pause"):
            raise ValueError("no approved next-target transition in this MVP")
    return decision
