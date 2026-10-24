"""Curated cue library. Seed rows are drafts until a reviewer changes their status."""

import json

from app.paths import CUE_PATH
from app.schemas import Cue


def load_cue_library(path=CUE_PATH) -> tuple[str, list[Cue]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    notice = str(payload["review_notice"])
    cues = [Cue.model_validate(item) for item in payload["cues"]]
    return notice, cues
