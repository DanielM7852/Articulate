"""Builds the Realtime session config baked into the ephemeral client secret. No network here."""

from app.realtime.persona import TOOLS, instructions
from app.realtime.settings import RealtimeSettings

CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
CALLS_URL = "https://api.openai.com/v1/realtime/calls"


def turn_detection(eagerness: str = "medium") -> dict:
    """Semantic VAD that both creates and interrupts responses. The client sets it to null during practice."""
    return {"type": "semantic_vad", "eagerness": eagerness, "create_response": True, "interrupt_response": True}


def session_config(settings: RealtimeSettings, memory: str | None = None) -> dict:
    return {
        "type": "realtime",
        "model": settings.realtime_model,
        "output_modalities": ["text"],
        "instructions": instructions(settings.realtime_therapist_name) + (f"\n\n{memory}" if memory else ""),
        "audio": {
            "input": {
                "transcription": {"model": settings.realtime_transcription_model, "language": "en"},
                "turn_detection": turn_detection(settings.realtime_vad_eagerness),
            }
        },
        "tools": TOOLS,
        "tool_choice": "auto",
    }


def client_secret_request(settings: RealtimeSettings, memory: str | None = None) -> dict:
    return {
        "expires_after": {"anchor": "created_at", "seconds": settings.realtime_secret_ttl_s},
        "session": session_config(settings, memory),
    }
