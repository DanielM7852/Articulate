"""Service settings. Every value can be overridden through a PHONES_* environment variable."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _f(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    model_id: str = field(default_factory=lambda: os.environ.get("PHONES_MODEL_ID", "KoelLabs/xlsr-english-01"))
    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("PHONES_MODELS_DIR", ROOT / "models")))
    engines_dir: Path = field(default_factory=lambda: Path(os.environ.get("PHONES_ENGINES_DIR", ROOT / "engines")))
    # "auto" = tensorrt -> torch-fp16 -> torch-cpu. Or force one of: tensorrt, torch-fp16, torch-cpu.
    backend: str = field(default_factory=lambda: os.environ.get("PHONES_BACKEND", "auto"))
    sample_rate: int = 16000
    hop_ms: float = field(default_factory=lambda: _f("PHONES_HOP_MS", 100))
    window_ms: float = field(default_factory=lambda: _f("PHONES_WINDOW_MS", 2000))
    min_window_ms: float = field(default_factory=lambda: _f("PHONES_MIN_WINDOW_MS", 500))
    commit_lag_ms: float = field(default_factory=lambda: _f("PHONES_COMMIT_LAG_MS", 300))
    # Window RMS below this (full scale = 1.0) skips inference.
    silence_rms: float = field(default_factory=lambda: _f("PHONES_SILENCE_RMS", 0.004))
    # Browser pages served from this machine on any port (the web app moves between dev ports) are always allowed;
    # PHONES_ALLOWED_ORIGINS (comma-separated) adds other exact origins, e.g. a LAN demo host.
    allowed_origin_regex: str = field(
        default_factory=lambda: os.environ.get(
            "PHONES_ALLOWED_ORIGIN_REGEX", r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$"
        )
    )
    allowed_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in os.environ.get("PHONES_ALLOWED_ORIGINS", "").split(",") if o.strip())
    )

    def origin_allowed(self, origin: str) -> bool:
        return origin in self.allowed_origins or re.fullmatch(self.allowed_origin_regex, origin) is not None
    max_clip_s: float = field(default_factory=lambda: _f("PHONES_MAX_CLIP_S", 30))

    @property
    def safe_name(self) -> str:
        return self.model_id.replace("/", "--")

    @property
    def model_dir(self) -> Path:
        return self.models_dir / self.safe_name

    @property
    def onnx_path(self) -> Path:
        return self.model_dir / "model.onnx"

    @property
    def plan_path(self) -> Path:
        return self.engines_dir / f"{self.safe_name}-fp16.plan"
