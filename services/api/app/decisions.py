"""Resolve model selections into canonical, evidence-grounded coaching content."""

from uuid import UUID

from .coaching import ACTION_MESSAGES, MEASURED, OBSERVATIONS, assess, plan
from .schemas import TARGETS, CoachingContext, CoachingDecision, CoachingProposal, AttemptSummary, Cue


def observation(summary: AttemptSummary):
    return assess(summary, CoachingContext())[0].text


def resolve_proposal(
    proposal: CoachingProposal,
    summary: AttemptSummary,
    generation: UUID,
    cues: list[Cue],
    context: CoachingContext | None = None,
    *,
    source="claude",
):
    context = context or CoachingContext()
    if proposal.attempt_id != summary.attempt_id or proposal.generation_id != generation:
        raise ValueError("stale decision identity")
    options = plan(summary, context, cues)
    selected = next((o for o in options.observations if o.id == proposal.observation_id), None)
    action = next((a for a in options.actions if a.action == proposal.next_action), None)
    if selected is None:
        raise ValueError("unsupported observation")
    if action is None or proposal.cue_id not in action.cue_ids:
        raise ValueError("unsupported action or cue/action combination")
    cue = next((c for c in cues if c.id == proposal.cue_id), None)
    if cue and (
        proposal.cue_version != cue.version
        or summary.target_id not in cue.target_ids
        or cue.language != "en"
        or cue.pose_id != TARGETS[summary.target_id].pose_id
    ):
        raise ValueError("ineligible cue/version/pose")
    if cue is None and (proposal.cue_id is not None or proposal.cue_version is not None):
        raise ValueError("unknown cue")
    evidence = list({(e.attempt_id, e.field): e for e in [*selected.evidence, *action.evidence]}.values())
    fields = list(dict.fromkeys(e.field for e in evidence if e.attempt_id == summary.attempt_id))
    return CoachingDecision(
        attempt_id=summary.attempt_id,
        generation_id=generation,
        observation=selected.text,
        observation_id=selected.id,
        evidence_fields=fields,
        evidence=evidence,
        cue_id=cue.id if cue else None,
        cue_version=cue.version if cue else None,
        pose_id=cue.pose_id if cue else "neutral",
        next_action=action.action,
        rationale=action.rationale,
        policy_version=context.policy.version,
        selection_source=source,
        policy=context.policy,
    )


def fallback(
    summary: AttemptSummary,
    generation: UUID,
    cues: list[Cue],
    context: CoachingContext | None = None,
    *,
    source="fallback",
):
    context = context or CoachingContext()
    options = plan(summary, context, cues)
    action = next(a for a in options.actions if a.action == options.preferred_action)
    cue_id = action.cue_ids[0]
    cue = next((c for c in cues if c.id == cue_id), None)
    proposal = CoachingProposal(
        attempt_id=summary.attempt_id,
        generation_id=generation,
        observation_id=options.preferred_observation_id,
        cue_id=cue_id,
        cue_version=cue.version if cue else None,
        next_action=action.action,
    )
    return resolve_proposal(proposal, summary, generation, cues, context, source=source)


def validate_decision(
    decision: CoachingDecision,
    summary: AttemptSummary,
    generation: UUID,
    cues: list[Cue],
    context: CoachingContext | None = None,
    *,
    allow_demo=False,
):
    if decision.observation_id is None:
        raise ValueError("missing supported observation ID")
    if decision.cue_id:
        cue = next((c for c in cues if c.id == decision.cue_id), None)
        statuses = {"approved", "demo_unreviewed"} if allow_demo else {"approved"}
        if cue is None or cue.review_status not in statuses:
            raise ValueError("unapproved cue")
    proposal = CoachingProposal(
        attempt_id=decision.attempt_id,
        generation_id=decision.generation_id,
        observation_id=decision.observation_id,
        cue_id=decision.cue_id,
        cue_version=decision.cue_version,
        next_action=decision.next_action,
    )
    expected = resolve_proposal(
        proposal, summary, generation, cues, context, source=decision.selection_source
    )
    if decision.model_dump() != expected.model_dump():
        raise ValueError("unsupported observation, evidence, pose, narration, or rationale")
    return expected


def caption_for(decision: CoachingDecision, cue: Cue | None):
    parts = [decision.observation]
    if cue:
        parts.append(cue.text)
    if decision.next_action in ACTION_MESSAGES:
        parts.append(ACTION_MESSAGES[decision.next_action])
    return " ".join(parts)


def prepared_captions(cue: Cue):
    """Pre-generate common repeat captions; history-specific coaching streams on demand."""
    return [
        text + " " + cue.text
        for text in (MEASURED, OBSERVATIONS["target.inside"], OBSERVATIONS["target.outside"])
    ]
