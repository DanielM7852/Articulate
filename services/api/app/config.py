from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

from .schemas import CoachingPolicy

ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    mock_mode: bool = True
    allow_demo_cues: bool = True
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    data_dir: Path = ROOT / ".data"
    session_ttl_seconds: int = 3600
    provider_deadline_seconds: float = 12
    playback_buffer_ms: int = 80
    formant_ceiling: float = 5500
    anthropic_api_key: str = ""
    claude_model: str = ""
    moss_project_id: str = ""
    moss_project_key: str = ""
    moss_index: str = "articulate-cues-v2"
    coaching_policy: CoachingPolicy = Field(default_factory=CoachingPolicy)
    cartesia_api_key: str = ""
    cartesia_model: str = ""
    cartesia_voice: str = ""
    cartesia_version: str = "2025-04-16"
    spacetimedb_uri: str = "http://localhost:3000"
    spacetimedb_database: str = ""
    spacetimedb_token: str = ""
