"""Runtime configuration.

Pitch thresholds below are engineering defaults for short intonation phrases.
They are not validated clinical standards.
"""

from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BACKEND_DIR / ".env", BACKEND_DIR / ".env.secrets"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-5-5"
    # Live coaching provider. "openai" runs every live model call on GPT; "anthropic" keeps the Claude path.
    live_coach_provider: Literal["anthropic", "openai"] = "openai"
    # Praat measurements of the word attempt WAV, added to the word coach message (both providers).
    word_acoustics_enabled: bool = True
    openai_api_key: str | None = None  # same OPENAI_API_KEY the realtime session reads
    live_openai_model: str = "gpt-5.4-mini"  # decide, word coach without audio, session, ask
    live_openai_background_model: str = "gpt-5.5"  # notes and insight
    live_openai_audio_model: str = "gpt-audio-1.5"  # word coach with the learner's attempt audio
    spacetime_uri: str = "https://maincloud.spacetimedb.com"
    spacetime_database: str | None = None
    spacetime_token: str | None = None
    live_coach_model: str = "claude-sonnet-5-5"
    live_coach_thinking: str = "on"  # "on" (adaptive, default) or "off"
    live_notes_model: str = "claude-sonnet-5-5"
    live_coach_effort: str = "medium"
    live_notes_effort: str = "high"
    live_talk_effort: str = "medium"
    live_insight_model: str = "claude-opus-5-5"
    live_insight_effort: str = "high"
    live_insight_timeout_s: float = 45.0
    insight_ttl_s: float = 900.0
    live_therapist_name: str = "Ava"
    live_session_ttl_s: float = 3600.0
    live_coach_timeout_s: float = 15.0
    live_history_limit: int = 12
    articulation_url: str = ""  # local collector (services/articulation); blank skips the SPARC collector
    pitch_table_enabled: bool = True  # Parselmouth pitch/formant table stored with the attempt
    articulation_timeout_s: float = 30.0
    articulation_models: str = "sparc,silero_vad"
    articulation_max_queue: int = 2
    # Opt in only after publishing the coordination reducers. API and workers share these settings.
    live_coordination: Literal["local", "spacetime"] = "local"
    live_identity_secret: str | None = None
    live_cookie_secure: bool = True
    live_identity_ttl_s: int = Field(default=2_592_000, ge=60, le=31_536_000)
    live_job_poll_s: float = Field(default=0.2, ge=0.05, le=5)
    live_worker_concurrency: int = Field(default=4, ge=1, le=64)
    live_global_concurrency: int = Field(default=32, ge=1, le=1000)
    live_job_lease_s: int = Field(default=60, ge=30, le=300)
    live_queue_limit: int = Field(default=1000, ge=1, le=10000)
    live_jobs_per_profile: int = Field(default=4, ge=1, le=16)
    live_job_retention_s: int = Field(default=3600, ge=300, le=86400)

    moss_project_id: str | None = None
    moss_project_key: str | None = None
    moss_index_name: str = "articulate-cues"
    cartesia_api_key: str | None = None
    cartesia_voice_id: str | None = None
    # Skylar, the public en-US example voice in the Sonic 3.6 docs. Used only when a key is set and no voice id is.
    # Ava's voice: Ella, chosen because SPARC reads her ee/oo/ah most distinctly and consistently of the reference
    # voices (see app/live/articulation_reference.json). The previous default, Skylar, failed that check.
    cartesia_default_voice_id: str = "2a12b36c-7f9b-4c3a-9f7a-72731b15323a"
    cartesia_version: str = "2026-08-14"
    cartesia_model_id: str = "sonic-3.6"
    store_dir: str = ".local_store"
    overall_timeout_s: float = 45.0
    reasoning_timeout_s: float = 12.0
    audio_timeout_s: float = 30.0
    max_provider_retries: int = 1
    max_upload_bytes: int = 5_000_000
    max_duration_s: float = 12.0
    min_duration_s: float = 0.25
    min_sample_rate_hz: int = 8_000
    max_sample_rate_hz: int = 48_000
    analysis_version: str = "pitch-v1"
    cors_origins: str = "http://localhost:3000,http://localhost:5173"
    # Built web/dist to serve at / (single-container hosting). Blank or a missing directory keeps the API-only app.
    static_dir: str = ""

    # Engineering comparison thresholds. See docs/backend-contract.md.
    ending_direction_st: float = 1.5
    ending_window_fraction: float = 0.2
    octave_tolerance_st: float = 1.25
    jump_threshold_st: float = 8.0
    jump_max_gap_s: float = 0.08
    f0_min_hz: float = 70.0
    f0_max_hz: float = 500.0
    voicing_probability_min: float = 0.5
    min_usable_coverage: float = 0.45
    min_usable_frames: int = 8
    dtw_band_radius: float = 0.2
    dtw_max_band_radius: float = 0.45
    dtw_duration_ratio_trigger: float = 1.15
    close_contour_rmse_st: float = 1.25
    range_smaller_margin_st: float = 1.5
    range_larger_margin_st: float = 2.5
    clipping_fraction_limit: float = 0.01
    silence_rms_limit: float = 0.008
    clipping_sample_level: float = 0.99

    @model_validator(mode="after")
    def shared_coordination_requirements(self):
        if self.live_coordination == "spacetime":
            if not self.spacetime_configured:
                raise ValueError("spacetime coordination requires SPACETIME_DATABASE and SPACETIME_TOKEN")
            if not self.live_identity_secret or len(self.live_identity_secret) < 32:
                raise ValueError("spacetime coordination requires LIVE_IDENTITY_SECRET (at least 32 characters)")
            if self.live_session_ttl_s <= 0:
                raise ValueError("shared sessions require a positive LIVE_SESSION_TTL_S")
        return self

    @property
    def anthropic_configured(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def openai_configured(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def spacetime_configured(self) -> bool:
        return bool(self.spacetime_database and self.spacetime_token)

    @property
    def articulation_configured(self) -> bool:
        return bool(self.articulation_url.strip())

    @property
    def moss_configured(self) -> bool:
        return bool(self.moss_project_id and self.moss_project_key)

    @property
    def resolved_cartesia_voice_id(self) -> str | None:
        if self.cartesia_voice_id:
            return self.cartesia_voice_id
        if self.cartesia_api_key:
            return self.cartesia_default_voice_id
        return None

    @property
    def cartesia_configured(self) -> bool:
        return bool(self.cartesia_api_key and self.resolved_cartesia_voice_id)

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


def get_settings() -> Settings:
    return Settings()
