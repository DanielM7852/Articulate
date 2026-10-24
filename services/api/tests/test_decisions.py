from uuid import uuid4

import pytest

from app.decisions import fallback, validate_decision
from app.features import summarize, synthetic_frame


@pytest.fixture
def context(runtime):
    summary = summarize(uuid4(), "i", [synthetic_frame("i", i) for i in range(20)], 24000, 19200, "synthetic")
    cues = [c.model_copy(update={"review_status": "approved"}) for c in runtime.repository.eligible("i")]
    generation = uuid4()
    return summary, generation, cues, fallback(summary, generation, cues)


@pytest.mark.parametrize(
    "changes",
    [
        {"cue_id": "unknown"},
        {"evidence_fields": ["tongue_position"]},
        {"pose_id": "vowel-u"},
        {"attempt_id": uuid4()},
        {"generation_id": uuid4()},
        {"cue_version": 999},
        {"observation": "Your tongue is too far back"},
        {"narration": "Open your throat"},
        {"next_action": "next_target"},
    ],
)
def test_reject_unsupported_decisions(context, changes):
    s, g, cues, decision = context
    with pytest.raises(ValueError):
        validate_decision(decision.model_copy(update=changes), s, g, cues)


def test_empty_eligible_cues_pause(context):
    s, g, _, _ = context
    assert validate_decision(fallback(s, g, []), s, g, []).next_action == "pause"


def test_unreviewed_cue_is_rejected_outside_explicit_mock_mode(context):
    s, g, cues, decision = context
    with pytest.raises(ValueError):
        validate_decision(
            decision, s, g, [c.model_copy(update={"review_status": "demo_unreviewed"}) for c in cues]
        )


def test_repair_is_not_pronunciation_failure(runtime):
    s = summarize(uuid4(), "u", [], 24000, 0, "microphone")
    g = uuid4()
    d = validate_decision(fallback(s, g, []), s, g, [])
    assert d.next_action == "repair_capture" and d.cue_id is None


def test_cue_filters_and_versions(runtime):
    repo = runtime.repository
    assert repo.eligible("i")
    assert not repo.eligible("i", language="fr")
    assert not repo.eligible("i", difficulty="standard")
    assert not repo.eligible("i", revision=1)
    assert not repo.eligible("i", excluded=[c.id for c in repo.eligible("i")])
    repo.settings.mock_mode = False
    assert not repo.eligible("i")  # unreviewed seed cues never enter real retrieval


async def test_retrieval_cache_respects_history(runtime):
    first = await runtime.repository.query("i")
    second = await runtime.repository.query("i", excluded=[first[0].id], history_revision=1)
    assert all(c.id != first[0].id for c in second)
