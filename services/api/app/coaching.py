"""Evidence assessment and admissible actions. All thresholds describe demo tasks, not clinical scores."""

import math

from .schemas import (
    ActionOption,
    AttemptSummary,
    CoachingContext,
    CoachingPlan,
    CoachingPolicy,
    Cue,
    CueOutcome,
    EvidenceReference,
    SupportedObservation,
)

REPAIR = "There was not enough usable speech to measure this attempt."
UNAVAILABLE = "I couldn't reliably compare the acoustic measurements for this attempt."
MEASURED = "This attempt contains enough usable audio to compare its acoustic position."
OBSERVATIONS = {
    "capture.insufficient": REPAIR,
    "capture.unavailable": UNAVAILABLE,
    "capture.usable": MEASURED,
    "target.inside": "Your average acoustic position is inside the demonstration region.",
    "target.outside": "Your average acoustic position is outside the demonstration region.",
    "trend.closer": "Your average acoustic position moved closer to the demonstration region than on your previous comparable attempt.",
    "trend.similar": "Your average acoustic distance was similar to your previous comparable attempt.",
    "trend.farther": "Your average acoustic position moved farther from the demonstration region than on your previous comparable attempt.",
}
ACTION_MESSAGES = {
    "repair_capture": "Check your microphone and try a short recording again.",
    "change_cue": "Let's try a different demonstration for the next attempt.",
    "simplify": "Let's bring back the target guide for the next attempt.",
    "reduce_assistance": "For the next attempt, we'll hide the target guide; captions will stay available.",
    "pause": "There is no eligible cue for this target right now. You can pause or choose another target.",
}


def usable(summary: AttemptSummary, policy: CoachingPolicy):
    return (
        summary.usable_duration_ms >= policy.min_usable_duration_ms
        and summary.usable_fraction >= policy.min_usable_fraction
        and summary.target_distance is not None
        and "target_distance" in summary.evidence_fields
        and {"usable_duration_ms", "usable_fraction"} <= set(summary.evidence_fields)
        and not {"insufficient_usable_speech", "incomplete_upload"}.intersection(summary.quality_flags)
    )


def compatible(a: AttemptSummary, b: AttemptSummary):
    return (a.target_id, a.target_version, a.source, a.assistance_level) == (
        b.target_id,
        b.target_version,
        b.source,
        b.assistance_level,
    )


def distance_trend(previous: float, current: float, policy: CoachingPolicy):
    delta = current - previous
    if abs(delta) <= policy.distance_change_threshold or math.isclose(
        abs(delta), policy.distance_change_threshold, rel_tol=1e-9, abs_tol=1e-9
    ):
        return "trend.similar"
    return "trend.closer" if delta < 0 else "trend.farther"


def recent_attempts(summary: AttemptSummary, context: CoachingContext):
    """Only a chronological, distinct, comparable suffix can establish progress.

    An invalid capture, source/target/version change or assistance change breaks the block.
    The controller passes prior attempts only; never count the current attempt twice.
    """
    recent, seen = [], {summary.attempt_id}
    for previous in reversed(context.attempt_history[-context.policy.history_limit :]):
        if previous.attempt_id in seen:
            break
        seen.add(previous.attempt_id)
        if not compatible(previous, summary) or not usable(previous, context.policy):
            break
        recent.append(previous)
    return list(reversed(recent))


def reference(summary: AttemptSummary, field: str):
    if field not in summary.evidence_fields or getattr(summary, field) is None:
        raise ValueError("observation references unavailable evidence")
    return EvidenceReference(attempt_id=summary.attempt_id, field=field, value=getattr(summary, field))


def assess(summary: AttemptSummary, context: CoachingContext):
    quality = [
        reference(summary, f)
        for f in ("usable_duration_ms", "usable_fraction")
        if f in summary.evidence_fields
    ]
    if not usable(summary, context.policy):
        insufficient = (
            summary.usable_duration_ms < context.policy.min_usable_duration_ms
            or summary.usable_fraction < context.policy.min_usable_fraction
        )
        key = "capture.insufficient" if insufficient else "capture.unavailable"
        return [SupportedObservation(id=key, text=OBSERVATIONS[key], evidence=quality)]
    distance = reference(summary, "target_distance")
    inside = summary.target_distance <= context.policy.region_distance
    position = "target.inside" if inside else "target.outside"
    observations = [
        SupportedObservation(id=position, text=OBSERVATIONS[position], evidence=[distance]),
        SupportedObservation(id="capture.usable", text=MEASURED, evidence=quality),
    ]
    recent = recent_attempts(summary, context)
    if recent:
        previous = recent[-1]
        key = distance_trend(previous.target_distance, summary.target_distance, context.policy)
        observations.insert(
            0,
            SupportedObservation(
                id=key, text=OBSERVATIONS[key], evidence=[reference(previous, "target_distance"), distance]
            ),
        )
    successes = [summary]
    for previous in reversed(recent):
        if previous.target_distance > context.policy.region_distance:
            break
        successes.append(previous)
    needed = context.policy.successful_attempts_to_reduce
    if inside and summary.assistance_level == "guided" and len(successes) >= needed:
        observations.insert(
            0,
            SupportedObservation(
                id="progress.ready_to_reduce",
                text=f"The average acoustic position was inside the demonstration region on {needed} comparable guided attempts.",
                evidence=[reference(a, "target_distance") for a in reversed(successes[:needed])],
            ),
        )
    return observations


def excluded_cues(summary: AttemptSummary, context: CoachingContext):
    ids = {a.attempt_id for a in recent_attempts(summary, context)} | {summary.attempt_id}
    blocked, previous_cue, failures = set(), None, 0
    for outcome in context.cue_history[-context.policy.history_limit :]:
        if (
            outcome.attempt_id not in ids
            or outcome.retry_attempt_id not in ids
            or outcome.source != summary.source
            or outcome.target_id != summary.target_id
            or outcome.target_version != summary.target_version
            or outcome.assistance_level != summary.assistance_level
        ):
            previous_cue, failures = None, 0
            continue
        if outcome.result == "no_improvement":
            failures = failures + 1 if previous_cue == outcome.cue_id else 1
            previous_cue = outcome.cue_id
            if failures >= context.policy.unsuccessful_retries_to_change:
                blocked.add(outcome.cue_id)
        else:
            previous_cue, failures = None, 0
            if outcome.result in ("improved", "region_match"):
                blocked.discard(outcome.cue_id)
    return sorted(blocked)


def plan(summary: AttemptSummary, context: CoachingContext, cues: list[Cue]):
    observations = assess(summary, context)
    preferred_observation = observations[0].id
    if not usable(summary, context.policy):
        actions = [
            ActionOption(
                action="repair_capture",
                cue_ids=[None],
                rationale="Capture quality or required acoustic evidence does not meet the configured requirements.",
            )
        ]
    elif not cues:
        actions = [
            ActionOption(
                action="pause",
                cue_ids=[None],
                rationale="No eligible, applicable cue is available for this attempt.",
            )
        ]
    else:
        ids = [c.id for c in cues]
        previous = context.cue_history[-1] if context.cue_history else None
        comparable_ids = {a.attempt_id for a in recent_attempts(summary, context)}
        if previous and previous.attempt_id not in comparable_ids:
            previous = None
        failed = excluded_cues(summary, context)
        if previous and previous.cue_id in failed:
            alternatives = [i for i in ids if i not in failed]
            if not alternatives:
                actions = [
                    ActionOption(
                        action="pause",
                        cue_ids=[None],
                        rationale="The current cue has not helped and no alternative is available.",
                    )
                ]
            else:
                actions = [
                    ActionOption(
                        action="change_cue",
                        cue_ids=alternatives,
                        rationale="The same cue did not reduce acoustic distance across the configured block of comparable retries.",
                    )
                ]
        else:
            repeat_ids = [previous.cue_id] if previous and previous.cue_id in ids else ids
            actions = [
                ActionOption(
                    action="repeat",
                    cue_ids=repeat_ids,
                    rationale="Another comparable attempt will help assess the current cue.",
                )
            ]
            if "progress.ready_to_reduce" in {o.id for o in observations}:
                actions.insert(
                    0,
                    ActionOption(
                        action="reduce_assistance",
                        cue_ids=ids,
                        rationale="Consecutive comparable guided attempts met the configured acoustic-region task criterion.",
                    ),
                )
            elif (
                summary.assistance_level == "reduced"
                and summary.target_distance > context.policy.region_distance
            ):
                actions.insert(
                    0,
                    ActionOption(
                        action="simplify",
                        cue_ids=ids,
                        rationale="The reduced-assistance attempt is outside the demonstration region; restore the optional target guide.",
                    ),
                )
    by_id = {a.attempt_id: a for a in recent_attempts(summary, context)} | {summary.attempt_id: summary}
    for action in actions:
        if action.action == "reduce_assistance":
            action.evidence = next(o.evidence for o in observations if o.id == "progress.ready_to_reduce")
        elif action.action == "simplify":
            action.evidence = [reference(summary, "target_distance")]
        elif action.action == "change_cue":
            attempts = []
            for outcome in context.cue_history:
                if outcome.result == "no_improvement" and outcome.cue_id in failed:
                    attempts += [outcome.attempt_id, outcome.retry_attempt_id]
            action.evidence = [
                reference(by_id[identity], "target_distance")
                for identity in dict.fromkeys(attempts)
                if identity in by_id
            ]
    return CoachingPlan(
        observations=observations,
        preferred_observation_id=preferred_observation,
        actions=actions,
        preferred_action=actions[0].action,
    )


def retry_outcome(summary: AttemptSummary, previous: CueOutcome, context: CoachingContext):
    if previous.result != "awaiting_retry" or not usable(summary, context.policy):
        return None
    recent = recent_attempts(summary, context)
    if not recent or recent[-1].attempt_id != previous.attempt_id:
        result = "inconclusive"
    elif summary.target_distance <= context.policy.region_distance:
        result = "region_match"
    elif previous.distance is None:
        result = "inconclusive"
    elif distance_trend(previous.distance, summary.target_distance, context.policy) == "trend.closer":
        result = "improved"
    else:
        result = "no_improvement"
    return previous.model_copy(update={"result": result, "retry_attempt_id": summary.attempt_id})


def context_from_records(attempts: list[dict], outcomes: list[dict], policy: CoachingPolicy):
    # Journal payloads may include persistence metadata; it is never reasoning evidence.
    return CoachingContext(
        policy=policy,
        attempt_history=[
            AttemptSummary.model_validate({k: v for k, v in a.items() if k in AttemptSummary.model_fields})
            for a in attempts[-policy.history_limit :]
        ],
        cue_history=[CueOutcome.model_validate(o) for o in outcomes[-policy.history_limit :]],
    )
