import asyncio
from uuid import uuid4

import pytest

from app.controller import Conflict
from app.features import synthetic_frame
from app.schemas import Command


async def command(r, kind, **extra):
    cmd = Command(command_id=uuid4(), expected_revision=r.session.revision, payload={"type": kind, **extra})
    await r.command(cmd)
    return cmd


async def usable_attempt(r):
    await command(r, "attempt.start", source="synthetic")
    r.fixture_task.cancel()
    await asyncio.gather(r.fixture_task, return_exceptions=True)
    r.frames = [synthetic_frame(r.session.target_id, i) for i in range(20)]
    r.processed_sample = 19200
    await command(r, "attempt.end", final_sample=0)


async def test_muted_vertical_slice_persists_summary_caption_pose(runtime):
    await usable_attempt(runtime)
    await runtime.feedback_task
    assert runtime.latest_decision["caption"] and runtime.latest_decision["pose_id"] == "vowel-i"
    assert runtime.session.state == "ready"
    assert len(runtime.history) == 1 and runtime.outbox.pending() >= 5
    assert not runtime.cache_keys
    await runtime.close()


async def test_slow_reasoner_does_not_block_feature_capture_and_stale_output(runtime):
    entered = asyncio.Event()

    async def slow(*args):
        entered.set()
        await asyncio.sleep(10)

    runtime.reasoner.decide = slow
    await usable_attempt(runtime)
    old_generation = runtime.generation_id
    await entered.wait()
    old_feedback = runtime.feedback_task
    await command(runtime, "attempt.start", source="synthetic")
    await asyncio.sleep(0.1)
    assert runtime.frames and runtime.generation_id != old_generation
    assert old_feedback.cancelled() and runtime.latest_decision is None
    await runtime.close()


async def test_timeout_and_malformed_model_fall_back(runtime):
    async def broken(*args):
        raise ValueError("bad model JSON")

    runtime.reasoner.decide = broken
    await usable_attempt(runtime)
    await runtime.feedback_task
    assert runtime.latest_decision["cue_id"] == "demo-i-1"

    async def timeout(*args):
        await asyncio.sleep(1)

    runtime.reasoner.decide = timeout
    await usable_attempt(runtime)
    await runtime.feedback_task
    assert runtime.latest_decision["selection_source"] == "fallback"
    assert runtime.latest_decision["observation_id"] == "trend.similar"
    await runtime.close()


async def test_target_change_pause_cancel_and_command_idempotence(runtime):
    cmd = await command(runtime, "attempt.start", source="synthetic")
    revision = runtime.session.revision
    await runtime.command(cmd)
    assert runtime.session.revision == revision
    await command(runtime, "session.configure", target_id="u", audio_enabled=False)
    assert runtime.session.target_id == "u" and runtime.session.state == "ready"
    await command(runtime, "session.pause")
    with pytest.raises(Conflict):
        await command(runtime, "attempt.start", source="synthetic")
    await command(runtime, "session.resume")
    with pytest.raises(Conflict):
        await runtime.command(
            Command(command_id=uuid4(), expected_revision=0, payload={"type": "feedback.cancel"})
        )
    await runtime.close()


async def test_audio_interrupts_during_synthesis(runtime):
    runtime.session.audio_enabled = True
    queue = asyncio.Queue(maxsize=64)
    runtime.audio_subscribers.add(queue)
    await usable_attempt(runtime)
    while not isinstance(await queue.get(), bytes):
        pass
    await command(runtime, "feedback.cancel")
    assert runtime.session.state == "ready"
    assert (await queue.get())["type"] == "audio.cancelled"
    assert queue.empty()
    await runtime.close()


async def test_next_action_reduces_assistance_and_pause_is_committed(runtime):
    for _ in range(3):
        await usable_attempt(runtime)
        await runtime.feedback_task
    assert runtime.session.assistance_level == "reduced"
    assert runtime.history[0]["assistance_level"] == "guided"

    assert runtime.latest_decision["next_action"] == "reduce_assistance"
    runtime.repository.cues = []
    runtime.repository.cache.clear()
    await usable_attempt(runtime)
    await runtime.feedback_task
    assert runtime.session.state == "paused"
    assert runtime.history[-1]["assistance_level"] == "reduced"
    await runtime.close()


async def test_capture_repair_does_not_mark_previous_cue_unsuccessful(runtime):
    await usable_attempt(runtime)
    await runtime.feedback_task
    await command(runtime, "attempt.start", source="synthetic")
    runtime.fixture_task.cancel()
    await asyncio.gather(runtime.fixture_task, return_exceptions=True)
    runtime.frames = []
    runtime.processed_sample = 0
    await command(runtime, "attempt.end", final_sample=0)
    await runtime.feedback_task
    assert runtime.latest_decision["next_action"] == "repair_capture"
    assert runtime.outcomes[0]["result"] == "awaiting_retry"
    await runtime.close()
