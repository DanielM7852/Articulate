import json
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.coaching import assess, distance_trend, excluded_cues
from app.decisions import fallback, resolve_proposal, validate_decision
from app.evaluation import CoachingSuite, evaluate
from app.schemas import CoachingContext, CoachingPolicy, CoachingProposal
from scripts.make_coaching_fixtures import ROOT, build_suite, summary

SUITE = CoachingSuite.model_validate_json((ROOT / "fixtures/coaching/scenarios.json").read_text("utf-8"))


@pytest.mark.parametrize("scenario", SUITE.scenarios, ids=lambda s: s.id)
async def test_fixture_decisions_are_grounded_and_adaptive(runtime, scenario):
    request = scenario.request
    excluded = excluded_cues(request.summary, request.context)
    cues = await runtime.repository.query(request.summary.target_id, excluded=excluded)
    decision = await runtime.reasoner.decide(request.summary, request.generation_id, cues, request.context)
    validated = validate_decision(
        decision, request.summary, request.generation_id, cues, request.context, allow_demo=True
    )
    assert validated.next_action == scenario.expected.action
    assert validated.observation_id == scenario.expected.observation_id
    assert validated.cue_id not in scenario.expected.forbidden_cue_ids
    assert validated.selection_source == "mock"
    assert validated.narration is None
    assert validated.rationale
    attempts = {a.attempt_id: a for a in request.context.attempt_history} | {
        request.summary.attempt_id: request.summary
    }
    for reference in validated.evidence:
        assert reference.field in attempts[reference.attempt_id].evidence_fields
        assert reference.value == getattr(attempts[reference.attempt_id], reference.field)


def test_checked_in_scenarios_match_generator():
    assert json.loads(
        (ROOT / "fixtures/coaching/scenarios.json").read_text("utf-8")
    ) == build_suite().model_dump(mode="json")


@pytest.mark.parametrize(
    "change",
    [
        {"observation_id": "trend.closer"},
        {"next_action": "reduce_assistance"},
        {"next_action": "pause"},
        {"next_action": "next_target"},
        {"cue_id": "invented"},
        {"cue_version": 999},
        {"attempt_id": uuid4()},
        {"generation_id": uuid4()},
    ],
)
def test_model_cannot_invent_progress_or_escape_allowed_actions(runtime, change):
    s = summary("guard", 2)
    cues = runtime.repository.eligible("i")
    generation = uuid4()
    initial = fallback(s, generation, cues)
    proposal = CoachingProposal(
        attempt_id=s.attempt_id,
        generation_id=generation,
        observation_id=initial.observation_id,
        cue_id=initial.cue_id,
        cue_version=initial.cue_version,
        next_action=initial.next_action,
    )
    with pytest.raises(ValueError):
        resolve_proposal(proposal.model_copy(update=change), s, generation, cues)


def test_model_cannot_add_free_text_or_anatomical_claims():
    with pytest.raises(ValidationError):
        CoachingProposal(
            attempt_id=uuid4(),
            generation_id=uuid4(),
            observation_id="target.inside",
            cue_id=None,
            cue_version=None,
            next_action="repeat",
            narration="Move your tongue back",
        )


@pytest.mark.parametrize(
    "change",
    [
        {"f1_mean": 0},
        {"f2_mean": float("nan")},
        {"target_distance": -1},
        {"quality_flags": ["x" * 65]},
        {"evidence_fields": ["x"] * 17},
        {"capture_start_sample": 24000},
        {"usable_duration_ms": 900},
    ],
)
def test_audio_agent_input_is_bounded_and_preserves_missing_measurements(change):
    data = summary("invalid-input", 2).model_dump()
    data.update(change)
    from app.schemas import AttemptSummary

    with pytest.raises(ValidationError):
        AttemptSummary.model_validate(data)


def test_reference_values_and_comparison_ids_cannot_be_forged(runtime):
    scenario = next(s for s in SUITE.scenarios if s.id == "moving_closer")
    r = scenario.request
    cues = runtime.repository.eligible("i")
    decision = fallback(r.summary, r.generation_id, cues, r.context)
    forged = decision.model_copy(
        update={"evidence": [ref.model_copy(update={"value": 999}) for ref in decision.evidence]}
    )
    with pytest.raises(ValueError):
        validate_decision(forged, r.summary, r.generation_id, cues, r.context, allow_demo=True)


def test_repeated_attempt_id_cannot_count_as_three_successes():
    old = summary("duplicate", 0.3)
    current = summary("duplicate-current", 0.3)
    context = CoachingContext(attempt_history=[old, old])
    assert "progress.ready_to_reduce" not in {o.id for o in assess(current, context)}


def test_assistance_change_breaks_comparison_and_progress():
    old = summary("guided-old", 0.2)
    current = summary("reduced-new", 0.2, assistance="reduced")
    observations = assess(current, CoachingContext(attempt_history=[old]))
    assert not any(o.id.startswith("trend.") or o.id.startswith("progress.") for o in observations)


def test_region_match_is_about_average_position_not_stability():
    observations = assess(summary("average", 0.2), CoachingContext())
    assert observations[0].text == "Your average acoustic position is inside the demonstration region."
    assert not any("stable" in o.text or "tongue" in o.text for o in observations)


@pytest.mark.parametrize(
    "current,expected",
    [(1.9, "trend.similar"), (2.1, "trend.similar"), (1.8, "trend.closer"), (2.2, "trend.farther")],
)
def test_distance_change_threshold_tolerates_floating_point_roundoff(current, expected):
    assert distance_trend(2, current, CoachingPolicy()) == expected


def test_region_claim_cannot_change_independently_of_the_displayed_target_ellipse():
    with pytest.raises(ValidationError):
        CoachingPolicy(region_distance=2)


def test_missing_acoustics_does_not_claim_recording_contained_insufficient_speech():
    current = summary("missing-acoustics", 2).model_copy(update={"target_distance": None})
    observation = assess(current, CoachingContext())[0]
    assert observation.id == "capture.unavailable"
    assert "not enough usable speech" not in observation.text


async def test_evaluator_reports_mock_mode_and_never_claims_live_claude(settings):
    report = await evaluate(SUITE, settings)
    assert report["passed"] == report["total"] == 15
    assert report["claude_called"] is False and report["claude_requests"] == 0
    assert report["provider_errors"] == 0


async def test_live_evaluator_fails_closed_without_credentials(settings):
    settings.mock_mode = False
    settings.anthropic_api_key = settings.moss_project_id = settings.moss_project_key = ""
    with pytest.raises(ValueError, match="Missing live evaluation"):
        await evaluate(SUITE, settings)


async def test_unreviewed_cue_never_reaches_real_claude(runtime):
    runtime.settings.mock_mode = False
    with pytest.raises(ValueError, match="Ineligible cue"):
        await runtime.reasoner.decide(
            summary("unreviewed", 2), uuid4(), [runtime.repository.cues[0]], CoachingContext()
        )
    assert runtime.reasoner.calls == 0


def test_reduction_always_includes_the_evidence_for_its_action(runtime):
    r = next(s.request for s in SUITE.scenarios if s.id == "reduce_after_three_guided_region_matches")
    cues = runtime.repository.eligible("i")
    proposal = CoachingProposal(
        attempt_id=r.summary.attempt_id,
        generation_id=r.generation_id,
        observation_id="capture.usable",
        cue_id=cues[0].id,
        cue_version=cues[0].version,
        next_action="reduce_assistance",
    )
    decision = resolve_proposal(proposal, r.summary, r.generation_id, cues, r.context)
    assert len({e.attempt_id for e in decision.evidence if e.field == "target_distance"}) == 3
