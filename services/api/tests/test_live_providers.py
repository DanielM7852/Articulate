import os
from uuid import uuid4

import pytest

from app.config import Settings
from app.decisions import validate_decision
from app.features import summarize, synthetic_frame
from app.providers import CueRepository, Reasoner, Speech
from app.schemas import CoachingContext


@pytest.mark.live
@pytest.mark.skipif(
    os.getenv("LIVE_PROVIDERS") != "1", reason="Set LIVE_PROVIDERS=1 to opt into paid provider calls"
)
async def test_live_retrieval_decision_and_tts():
    settings = Settings(mock_mode=False)
    if not all(
        (
            settings.moss_project_id,
            settings.moss_project_key,
            settings.anthropic_api_key,
            settings.claude_model,
            settings.cartesia_api_key,
            settings.cartesia_model,
            settings.cartesia_voice,
        )
    ):
        pytest.skip("Live-provider credentials/model/voice missing")
    repo, reasoner, speech = CueRepository(settings), Reasoner(settings), Speech(settings)
    if not repo.eligible("i"):
        pytest.skip("No approved /i/ cue corpus; unreviewed seeds cannot be used")
    try:
        await repo.startup()
        cues = await repo.query("i")
        assert cues
        summary = summarize(
            uuid4(), "i", [synthetic_frame("i", n) for n in range(20)], 24000, 19200, "synthetic"
        )
        generation = uuid4()
        decision = validate_decision(
            await reasoner.decide(summary, generation, cues, CoachingContext()), summary, generation, cues
        )
        cue = next(c for c in cues if c.id == decision.cue_id)
        size = 0
        async for kind, value in speech.stream(decision.observation + " " + cue.text, generation):
            if kind == "audio":
                size += len(value)
        assert size > 0
    finally:
        await speech.close()
        await reasoner.close()
