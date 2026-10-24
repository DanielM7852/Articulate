import asyncio
from uuid import uuid4

import pytest

from app.audio import HEADER, pack_frame, unpack_frame
from app.features import AcousticAdapter


def test_binary_framing_and_direction():
    identity = uuid4()
    binary = pack_frame(1, identity, 2, 960, 48000, b"\0" * 1920)
    assert HEADER.size == 44
    assert unpack_frame(binary, 1)[:4] == (identity, 2, 960, 48000)
    for data in (binary[:20], binary[:-1], binary + b"\0", binary[:4] + b"\x02" + binary[5:]):
        with pytest.raises(ValueError):
            unpack_frame(data, 1)


def test_upload_order_rate_attempt_and_queue_limits(runtime):
    runtime.session.state = "capturing"
    runtime.source = "microphone"
    runtime.attempt_id = uuid4()
    binary = pack_frame(1, runtime.attempt_id, 0, 0, 24000, b"\0" * 1920)
    runtime.upload(binary)
    with pytest.raises(ValueError):
        runtime.upload(binary)
    with pytest.raises(ValueError):
        runtime.upload(pack_frame(1, uuid4(), 1, 960, 24000, b"\0" * 1920))
    for i in range(1, 8):
        runtime.upload(pack_frame(1, runtime.attempt_id, i, i * 960, 24000, b"\0" * 1920))
    with pytest.raises(asyncio.QueueFull):
        runtime.upload(pack_frame(1, runtime.attempt_id, 8, 8 * 960, 24000, b"\0" * 1920))


def test_silence_and_clipping():
    adapter = AcousticAdapter(24000, 5500)
    assert "silence" in adapter.analyze(b"\0" * 1920, 0).quality_flags
    assert "clipping" in adapter.analyze(b"\xff\x7f" * 960, 960).quality_flags


def test_cache_identity_and_atomic_pair(runtime):
    cue = runtime.repository.eligible("i")[0]
    key = runtime.cache.key(cue.text, cue, "model", "voice")
    assert key != runtime.cache.key(cue.text + "!", cue, "model", "voice")
    assert key != runtime.cache.key(cue.text, cue, "model2", "voice")
    runtime.cache.put(key, cue.text, cue, "model", "voice", b"\0\0", [{"offset": 0}])
    manifest, pcm = runtime.cache.get(key)
    assert manifest.timings == [{"offset": 0}] and pcm == b"\0\0"
    assert runtime.cache.get("../secret") is None


async def test_delayed_audio_streams_and_cancellation_clears_queue(runtime):
    runtime.session.audio_enabled = True
    generation = runtime.generation_id = uuid4()
    queue = asyncio.Queue(maxsize=64)
    runtime.audio_subscribers.add(queue)
    cue = runtime.repository.eligible("i")[0]
    task = runtime.feedback_task = runtime.task(runtime.present_audio(cue.text, cue, generation))
    assert (await queue.get())["type"] == "audio.start"
    first = await queue.get()
    assert isinstance(first, bytes) and not task.done()  # first PCM arrives before synthesis completes
    await runtime.interrupt()
    assert task.cancelled()
    assert (await queue.get())["type"] == "audio.cancelled"
    assert queue.empty()
    await runtime.close()
