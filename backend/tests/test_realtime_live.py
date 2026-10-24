"""Live check: mint a real Realtime client secret with the configured session. Skips without OPENAI_API_KEY."""

import pytest

from app.realtime.routes import mint_client_secret
from app.realtime.settings import RealtimeSettings

_settings = RealtimeSettings()

pytestmark = pytest.mark.skipif(not _settings.openai_configured, reason="OPENAI_API_KEY not set")


async def test_mints_ephemeral_secret_with_text_only_session():
    data = await mint_client_secret(_settings)
    assert data["value"].startswith("ek_")
    assert int(data["expires_at"]) > 0
    session = data["session"]
    assert session["model"] == _settings.realtime_model
    assert session["output_modalities"] == ["text"]
    td = session["audio"]["input"]["turn_detection"]
    assert td["type"] == "semantic_vad"
    assert td["create_response"] is True and td["interrupt_response"] is True
    assert [t["name"] for t in session["tools"]] == ["get_coaching", "start_practice", "end_practice"]
