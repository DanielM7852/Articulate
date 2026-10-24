"""Attempt control, timeouts, and the offline coaching loop."""

import asyncio
import time

import pytest

from app.errors import CoachValidationError, StaleAttemptError
from app.reasoning.validate import PREFERRED_ACTION
from app.schemas import CoachOutput
from tests.support import analyzed_pair, build_orchestrator, make_settings


class RecordingCoach:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, **kwargs) -> CoachOutput:
        self.calls += 1
        cue = kwargs["cues"][0]
        return CoachOutput(
            evidence_ids=[kwargs["evidence"][0].evidence_id],
            finding=kwargs["finding"],
            selected_cue_id=cue.cue_id,
            observation="The ending pitch movement does not match the reference example.",
            instruction=cue.instruction_text,
            next_action=PREFERRED_ACTION[kwargs["finding"]],  # type: ignore[arg-type]
            limitations=[],
        )


class SlowCoach:
    async def complete(self, **kwargs) -> CoachOutput:
        del kwargs
        await asyncio.sleep(2)
        raise AssertionError("timeout should win")


class BadCoach:
    async def complete(self, **kwargs) -> CoachOutput:
        cue = kwargs["cues"][0]
        return CoachOutput(
            evidence_ids=[kwargs["evidence"][0].evidence_id],
            finding=kwargs["finding"],
            selected_cue_id=cue.cue_id,
            observation="Your tongue is too far back.",
            instruction=cue.instruction_text,
            next_action=PREFERRED_ACTION[kwargs["finding"]],  # type: ignore[arg-type]
            limitations=[],
        )


def _job(session: str, attempt: str, filename: str = "learner.wav"):
    from app.reasoning.orchestrate import ComparisonJob

    return ComparisonJob(
        session_id=session,
        attempt_id=attempt,
        reference_id="intonation-rising-ready",
        audio=b"not-read",
        filename=filename,
    )


async def test_grounded_fallback_when_claude_is_not_configured(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    orchestrator = build_orchestrator(settings, loaded, learner)
    result = await orchestrator.compare(_job("session-a", "attempt-a"))
    assert result.status == "partial"
    assert result.finding == "ending_direction_mismatch"
    assert result.feedback.cue_id == "cue-rise-ending-draft"
    assert result.feedback.instruction.startswith("At the end of the phrase")
    assert result.feedback.spoken_text
    assert "tongue" not in result.feedback.spoken_text
    assert result.audio_retained is False
    assert result.content_verified is False
    assert result.claims_limited is True
    assert result.retrieval is not None
    assert result.retrieval.disclosed_fallback is True
    assert result.reasoning is not None
    assert result.reasoning.source == "deterministic_fallback"
    assert result.reasoning.rejection_reason == "anthropic_not_configured"
    assert result.reference_contour is not None
    assert result.learner_contour is not None
    assert result.metrics is not None
    assert result.metrics.learner_ending_direction == "falling"
    stages = [event.stage for event in orchestrator.progress._history["attempt-a"]]
    assert stages[:5] == ["received", "analyzing_audio", "aligning", "comparing", "selecting_cue"]
    assert stages[-1] == "partial"


async def test_duplicate_attempt_does_not_reanalyze(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    orchestrator = build_orchestrator(settings, loaded, learner)
    calls = {"n": 0}
    original = orchestrator.analyze_audio

    def counting(data, filename, active):
        calls["n"] += 1
        return original(data, filename, active)

    orchestrator.analyze_audio = counting
    first = await orchestrator.compare(_job("session-b", "attempt-b"))
    second = await orchestrator.compare(_job("session-b", "attempt-b"))
    assert calls["n"] == 1
    assert second.model_dump() == first.model_dump()


async def test_stale_attempt_is_not_saved(tmp_path):
    settings = make_settings(tmp_path, audio_timeout_s=5)
    loaded, learner = analyzed_pair(settings, "falling")
    orchestrator = build_orchestrator(settings, loaded, learner)
    started = asyncio.Event()

    def analyze(data, filename, active):
        del data, active
        if filename.startswith("slow"):
            started.set()
            time.sleep(0.6)
        return learner

    orchestrator.analyze_audio = analyze
    slow = asyncio.create_task(orchestrator.compare(_job("session-c", "attempt-slow", "slow.wav")))
    await asyncio.wait_for(started.wait(), timeout=2)
    fast = await orchestrator.compare(_job("session-c", "attempt-fast", "fast.wav"))
    with pytest.raises(StaleAttemptError):
        await slow
    assert fast.attempt_id == "attempt-fast"
    assert orchestrator.store.get_result("session-c", "attempt-slow") is None
    assert orchestrator.store.get_result("session-c", "attempt-fast") is not None


async def test_reasoning_timeout_returns_measurements_and_fallback_cue(tmp_path):
    settings = make_settings(tmp_path, reasoning_timeout_s=0.2, overall_timeout_s=5)
    loaded, learner = analyzed_pair(settings, "falling")
    orchestrator = build_orchestrator(settings, loaded, learner, coach=SlowCoach())
    result = await orchestrator.compare(_job("session-d", "attempt-d"))
    assert result.status == "partial"
    assert result.metrics is not None
    assert result.metrics.learner_ending_direction == "falling"
    assert result.feedback.cue_id == "cue-rise-ending-draft"
    assert result.reasoning is not None
    assert result.reasoning.rejection_reason == "reasoning_timeout"
    assert result.reasoning.source == "deterministic_fallback"


async def test_invalid_claude_output_uses_fallback(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    orchestrator = build_orchestrator(settings, loaded, learner, coach=BadCoach())
    result = await orchestrator.compare(_job("session-e", "attempt-e"))
    assert result.status == "partial"
    assert result.reasoning is not None
    assert result.reasoning.rejection_reason == "anatomical_claim"
    assert "tongue" not in result.feedback.spoken_text
    assert result.feedback.cue_id == "cue-rise-ending-draft"


async def test_validated_claude_output_can_complete(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "falling")
    coach = RecordingCoach()
    orchestrator = build_orchestrator(settings, loaded, learner, coach=coach)
    result = await orchestrator.compare(_job("session-f", "attempt-f"))
    assert coach.calls == 1
    assert result.status == "complete"
    assert result.reasoning is not None
    assert result.reasoning.source == "claude"
    assert result.reasoning.validated is True
    assert result.feedback.cue_id == "cue-rise-ending-draft"
    assert result.feedback.reference_segment_replay is not None


async def test_insufficient_audio_does_not_call_the_model(tmp_path):
    settings = make_settings(tmp_path)
    loaded, learner = analyzed_pair(settings, "silence")
    coach = RecordingCoach()
    orchestrator = build_orchestrator(settings, loaded, learner, coach=coach)
    result = await orchestrator.compare(_job("session-g", "attempt-g"))
    assert coach.calls == 0
    assert result.status == "insufficient_audio"
    assert result.feedback.cue_id == "cue-rerecord-draft"
    assert result.feedback.next_action == "rerecord"
    assert result.feedback.spoken_text == result.feedback.instruction


def test_validation_error_code_is_stable():
    assert CoachValidationError("anatomical_claim").code == "anatomical_claim"
