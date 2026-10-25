"""Service settings. Every value can be overridden through a PHONES_* environment variable."""
from __future__ import annotations

import os
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
    hop_ms: float = field(default_factory=lambda: _f("PHONES_HOP_MS", 250))
    window_ms: float = field(default_factory=lambda: _f("PHONES_WINDOW_MS", 2000))
    min_window_ms: float = field(default_factory=lambda: _f("PHONES_MIN_WINDOW_MS", 500))
    commit_lag_ms: float = field(default_factory=lambda: _f("PHONES_COMMIT_LAG_MS", 500))
    # Window RMS below this (full scale = 1.0) skips inference.
    silence_rms: float = field(default_factory=lambda: _f("PHONES_SILENCE_RMS", 0.004))
    allowed_origins: tuple[str, ...] = ("http://127.0.0.1:5176", "http://localhost:5176")
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
