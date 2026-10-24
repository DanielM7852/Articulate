"""Settings for the realtime persona, kept apart from app.config so that file need not change.

Reads the same env files as app.config.Settings (backend/.env, backend/.env.secrets) plus the process
environment. The key is only ever sent to OpenAI; it is never logged or returned.
"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_DIR


class RealtimeSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BACKEND_DIR / ".env", BACKEND_DIR / ".env.secrets"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str | None = None
    realtime_model: str = "gpt-realtime-2.1-mini"
    realtime_transcription_model: str = "gpt-4o-mini-transcribe"
    realtime_vad_eagerness: str = "medium"
    realtime_secret_ttl_s: int = Field(default=600, ge=10, le=7200)
    realtime_timeout_s: float = 10.0
    realtime_therapist_name: str = "Ava"

    @property
    def openai_configured(self) -> bool:
        return bool(self.openai_api_key)


@lru_cache(maxsize=1)
def get_realtime_settings() -> RealtimeSettings:
    return RealtimeSettings()
