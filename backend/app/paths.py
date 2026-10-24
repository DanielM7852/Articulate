"""Repository paths owned by this backend."""

from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_ROOT / "data"
CUE_PATH = DATA_DIR / "cues" / "seed_cues.json"
REFERENCE_DIR = DATA_DIR / "reference_metadata"
