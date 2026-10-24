"""Runtime configuration.

Pitch thresholds below are engineering defaults for short intonation phrases.
They are not validated clinical standards.
"""

from pathlib import Path

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
    spacetime_uri: str = "https://maincloud.spacetimedb.com"
    spacetime_database: str | None = None
    spacetime_token: str | None = None
    live_coach_model: str = "claude-sonnet-5-5"
    live_coach_thinking: str = "on"  # "on" (adaptive, default) or "off"
    live_notes_model: str = "claude-sonnet-5-5"
    live_coach_effort: str = "medium"
    live_notes_effort: str = "high"
    live_coach_timeout_s: float = 15.0
    live_history_limit: int = 12
    moss_project_id: str | None = None
    moss_project_key: str | None = None
    moss_index_name: str = "articulate-cues"
    cartesia_api_key: str | None = None
    cartesia_voice_id: str | None = None
    # Skylar, the public en-US example voice in the Sonic 3.6 docs. Used only when a key is set and no voice id is.
    cartesia_default_voice_id: str = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
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

    @property
    def anthropic_configured(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def spacetime_configured(self) -> bool:
        return bool(self.spacetime_database and self.spacetime_token)

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
