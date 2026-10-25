"""Download PHONES_MODEL_ID into models/<id>/ (HF_TOKEN from the environment or the HF cache login)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from huggingface_hub import snapshot_download  # noqa: E402

from phones.config import Settings  # noqa: E402

s = Settings()
s.model_dir.mkdir(parents=True, exist_ok=True)
path = snapshot_download(
    s.model_id,
    local_dir=s.model_dir,
    allow_patterns=["*.json", "*.txt", "*.safetensors", "*.model"],
)
if not (s.model_dir / "model.safetensors").exists():
    snapshot_download(s.model_id, local_dir=s.model_dir, allow_patterns=["*.bin"])
print("downloaded", s.model_id, "->", path)
