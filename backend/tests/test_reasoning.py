"""Coaching validation, fallback, and prompt bounds."""

from app.integrations.cues import load_cue_library
from app.reasoning.fallback import fallback_output
from app.reasoning.prompts import SYSTEM_PROMPT, render_user_message
from app.reasoning.validate import validate_coach_output
from app.schemas import CoachOutput, EvidenceItem


def _evidence() -> list[EvidenceItem]:
    return [
        EvidenceItem(
            evidence_id="ev-ending-direction",
            metric="ending_direction",
            value="rising|falling",
            detail="Reference direction, then learner direction.",
        )
    ]


def test_seed_cues_are_marked_draft():
    notice, cues = load_cue_library()
    assert "unreviewed" in notice.lower() or "draft" in notice.lower()
    assert len(cues) >= 8
    for cue in cues:
        assert cue.review_status == "draft"
        assert cue.cue_id
        assert cue.exercise
        assert cue.finding
        assert cue.language == "en"
        assert cue.difficulty
        assert cue.instruction_text
        assert cue.source
        assert not any(char.isdigit() for char in cue.instruction_text)


def test_valid_model_output_is_kept():
    _notice, cues = load_cue_library()
    cue = next(item for item in cues if item.cue_id == "cue-rise-ending-draft")
    output = validate_coach_output(
        CoachOutput(
            evidence_ids=["ev-ending-direction"],
            finding="ending_direction_mismatch",
            selected_cue_id=cue.cue_id,
            observation="The ending movement does not match the reference example.",
            instruction="  " + cue.instruction_text + "  ",
            next_action="isolate_segment",
            limitations=["listen again"],
        ),
        finding="ending_direction_mismatch",
        evidence=_evidence(),
        cues=[cue],
    )
    assert output.instruction == cue.instruction_text
    assert output.selected_cue_id == cue.cue_id


def test_anatomical_and_invented_outputs_are_rejected():
    _notice, cues = load_cue_library()
    cue = next(item for item in cues if item.cue_id == "cue-rise-ending-draft")
    from app.errors import CoachValidationError
    import pytest

    with pytest.raises(CoachValidationError) as anatomical:
        validate_coach_output(
            CoachOutput(
                evidence_ids=["ev-ending-direction"],
                finding="ending_direction_mismatch",
                selected_cue_id=cue.cue_id,
                observation="Your tongue is too far back.",
                instruction=cue.instruction_text,
                next_action="isolate_segment",
                limitations=[],
            ),
            finding="ending_direction_mismatch",
            evidence=_evidence(),
            cues=[cue],
        )
    assert anatomical.value.code == "anatomical_claim"
    with pytest.raises(CoachValidationError) as invented:
        validate_coach_output(
            CoachOutput(
                evidence_ids=["ev-ending-direction"],
                finding="ending_direction_mismatch",
                selected_cue_id=cue.cue_id,
                observation="The ending was 4 semitones low.",
                instruction=cue.instruction_text,
                next_action="isolate_segment",
                limitations=[],
            ),
            finding="ending_direction_mismatch",
            evidence=_evidence(),
            cues=[cue],
        )
    assert invented.value.code == "observation_bounds"
    with pytest.raises(CoachValidationError) as unknown_cue:
        validate_coach_output(
            CoachOutput(
                evidence_ids=["ev-ending-direction"],
                finding="ending_direction_mismatch",
                selected_cue_id="cue-does-not-exist",
                observation="The ending movement does not match the reference example.",
                instruction=cue.instruction_text,
                next_action="isolate_segment",
                limitations=[],
            ),
            finding="ending_direction_mismatch",
            evidence=_evidence(),
            cues=[cue],
        )
    assert unknown_cue.value.code == "unknown_cue_id"


def test_fallback_uses_only_the_supplied_cue(tmp_path):
    del tmp_path
    _notice, cues = load_cue_library()
    cue = next(item for item in cues if item.cue_id == "cue-rise-ending-draft")
    decision = fallback_output(finding="ending_direction_mismatch", evidence=_evidence(), cues=[cue])
    assert decision.selected_cue_id == cue.cue_id
    assert decision.instruction == cue.instruction_text
    assert decision.evidence_ids == ["ev-ending-direction"]
    assert "tongue" not in decision.observation.lower()


def test_prompt_is_bounded_and_treats_content_as_data():
    _notice, cues = load_cue_library()
    message = render_user_message(
        finding="ending_direction_mismatch",
        evidence=_evidence(),
        cues=cues[:3],
        history_summary="attempt-1|partial|ending_direction_mismatch|cue-rise-ending-draft|isolate_segment",
        content_verified=False,
        intended_pattern="rising",
        exercise="intonation_rising",
    )
    assert message.startswith("<data>")
    assert len(message) < 4000
    assert len(SYSTEM_PROMPT) < 2000
    assert "Do not invent measurements" in SYSTEM_PROMPT
