import asyncio
from uuid import uuid4

from app.coaching import context_from_records
from app.controller import restore
from app.decisions import fallback
from app.features import synthetic_frame
from app.schemas import Command, TARGETS


async def attempt(runtime, distance=3):
    async def send(payload):
        await runtime.command(
            Command(command_id=uuid4(), expected_revision=runtime.session.revision, payload=payload)
        )

    await send({"type": "attempt.start", "source": "synthetic"})
    runtime.fixture_task.cancel()
    await asyncio.gather(runtime.fixture_task, return_exceptions=True)
    target = TARGETS[runtime.session.target_id]
    runtime.frames = [
        synthetic_frame(target.id, i).model_copy(
            update={"f1": target.f1 + distance * target.radius_f1, "f2": target.f2}
        )
        for i in range(20)
    ]
    runtime.processed_sample = 19200
    await send({"type": "attempt.end", "final_sample": 0})
    await runtime.feedback_task


async def test_session_switches_cue_after_two_failed_retries_and_pauses_when_exhausted(runtime):
    for _ in range(3):
        await attempt(runtime)
    assert runtime.latest_decision["next_action"] == "change_cue"
    assert runtime.latest_decision["cue_id"] == "demo-i-2"
    assert [o["result"] for o in runtime.outcomes[:2]] == ["no_improvement", "no_improvement"]
    await attempt(runtime)
    assert runtime.latest_decision["next_action"] == "repeat"
    assert runtime.latest_decision["cue_id"] == "demo-i-2"
    await attempt(runtime)
    assert runtime.latest_decision["next_action"] == "pause"
    assert runtime.latest_decision["cue_id"] is None
    assert runtime.session.state == "paused"
    await runtime.close()


async def test_unjustified_model_reduction_falls_back_without_changing_assistance(runtime):
    async def unsupported(summary, generation, cues, context):
        return fallback(summary, generation, cues, context).model_copy(
            update={"next_action": "reduce_assistance"}
        )

    runtime.reasoner.decide = unsupported
    await attempt(runtime, 0.3)
    assert runtime.latest_decision["next_action"] == "repeat"
    assert runtime.latest_decision["selection_source"] == "fallback"
    assert runtime.session.assistance_level == "guided"
    await runtime.close()


async def test_journal_recovers_cue_effects_if_snapshot_lags(runtime):
    await attempt(runtime)
    before = runtime.snapshot()
    await attempt(runtime)
    runtime.outbox.save(runtime.session.id, runtime.token_hash, before, runtime.expires)
    recovered = restore(
        runtime.settings,
        runtime.repository,
        runtime.reasoner,
        runtime.outbox,
        runtime.cache,
        runtime.session.id,
    )
    assert len(recovered.history) == 2 and len(recovered.outcomes) == 2
    assert recovered.outcomes[0]["result"] == "no_improvement"
    assert recovered.outcomes[-1]["result"] == "awaiting_retry"
    context = context_from_records(recovered.history, recovered.outcomes, runtime.settings.coaching_policy)
    assert len(context.attempt_history) == 2
    await runtime.close()
    await recovered.close()
