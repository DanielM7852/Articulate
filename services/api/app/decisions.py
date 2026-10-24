from uuid import UUID

from .schemas import TARGETS, AttemptSummary, CoachingDecision, Cue

REPAIR = "There was not enough usable speech to measure this attempt."
MEASURED = "This attempt contains enough usable audio to compare its acoustic position."

VISUAL_OBSERVATIONS = {
    ("u", True): "Camera tracking shows clear lip rounding and forward puckering for /u/.",
    ("u", False): "Camera tracking shows your lips stayed relatively wide; try rounding and puckering them into a tighter circle for /u/.",
    ("i", True): "Camera tracking shows clear horizontal lip spreading for /i/.",
    ("i", False): "Camera tracking shows your mouth corners stayed relaxed; try spreading your lips gently outward like a small smile for /i/.",
    ("aa", True): "Camera tracking shows a wide vertical mouth and jaw opening for /ɑ/.",
    ("aa", False): "Camera tracking shows a narrow vertical mouth opening; try dropping your jaw wider for /ɑ/.",
}


def observation(summary: AttemptSummary):
    return MEASURED if "target_distance" in summary.evidence_fields else REPAIR


def visual_observation(summary: AttemptSummary) -> str | None:
    if "lip_opening_mean" not in summary.evidence_fields or "target_distance" not in summary.evidence_fields:
        return None
    target = summary.target_id
    if target == "u":
        matched = (summary.lip_rounding_mean is not None and summary.lip_rounding_mean >= 0.35) or (
            summary.lip_width_mean is not None and summary.lip_width_mean <= 0.68
        )
    elif target == "i":
        matched = (summary.lip_spread_mean is not None and summary.lip_spread_mean >= 0.25) or (
            summary.lip_width_mean is not None and summary.lip_width_mean >= 0.78
        )
    else:  # "aa"
        matched = (summary.lip_opening_mean is not None and summary.lip_opening_mean >= 0.28) or (
            summary.jaw_drop_mean is not None and summary.jaw_drop_mean >= 1.15
        )
    return VISUAL_OBSERVATIONS[(target, bool(matched))]


def fallback(summary: AttemptSummary, generation: UUID, cues: list[Cue]):
    usable = "target_distance" in summary.evidence_fields
    cue = cues[0] if usable and cues else None
    vis_obs = visual_observation(summary) if usable else None
    ev = ["usable_duration_ms"]
    if vis_obs is not None and "lip_opening_mean" in summary.evidence_fields:
        ev.append("lip_opening_mean")
    return CoachingDecision(
        attempt_id=summary.attempt_id,
        generation_id=generation,
        observation=observation(summary),
        visual_observation=vis_obs,
        evidence_fields=ev,
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
    expected_vis = visual_observation(summary)
    if decision.visual_observation not in (None, expected_vis):
        raise ValueError("unsupported visual observation")
    if decision.visual_observation is not None and "lip_opening_mean" not in decision.evidence_fields:
        raise ValueError("visual observation requires lip_opening_mean in evidence_fields")
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
