"""Owner credentials for the local classroom database.

The token is the identity that published `articulate-classroom`. It stays in the
gitignored local store and is never returned to the browser.
"""

import json
from pathlib import Path
from urllib.parse import urlparse

from app.config import Settings
from app.paths import BACKEND_ROOT


def owner_path(settings: Settings) -> Path:
    raw = Path(settings.store_dir)
    candidates = [raw / "classroom_owner.json"]
    if not raw.is_absolute():
        candidates.insert(0, BACKEND_ROOT / raw / "classroom_owner.json")
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def load_owner(settings: Settings) -> dict | None:
    path = owner_path(settings)
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not data.get("token") or not data.get("database") or not data.get("uri"):
        return None
    return data


def dev_classroom_enabled(owner: dict) -> bool:
    host = urlparse(owner["uri"]).hostname
    return host in {"127.0.0.1", "localhost"}
