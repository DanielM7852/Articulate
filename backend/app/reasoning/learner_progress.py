"""Per-learner lesson progress for the practice screen.

Counts come from attempts this service has already accepted. The same attempt
id does not count twice. A stored count is not a clinical improvement, and it
does not say a cue caused the next result.
"""

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

_ID = re.compile(r"^[A-Za-z0-9._@+-]{1,80}$")
_MAX_IDS = 200
_SOUNDS = ("i", "u", "a")

SoundId = Literal["i", "u", "a"]


class LessonPlan(BaseModel):
    sound: SoundId
    pace: Literal["unhurried", "steady", "flexible"]
    assistance: Literal["cue-target", "target-only", "none"]


class SoundCounts(BaseModel):
    usable: int = 0
    unclear: int = 0


class LessonProgress(BaseModel):
    learner_id: str
    counted_attempt_ids: list[str] = Field(default_factory=list)
    sounds: dict[str, SoundCounts] = Field(default_factory=dict)
    plan: LessonPlan | None = None


def empty_progress(learner_id: str) -> LessonProgress:
    return LessonProgress(
        learner_id=learner_id,
        sounds={sound: SoundCounts() for sound in _SOUNDS},
    )


def load_progress(store_dir: str, learner_id: str) -> LessonProgress | None:
    path = _path(store_dir, learner_id)
    if path is None or not path.exists():
        return None
    return LessonProgress.model_validate_json(path.read_text(encoding="utf-8"))


def record_attempt(store_dir: str, learner_id: str, attempt, plan: LessonPlan, history: list) -> LessonProgress:
    """Count this attempt once. History is copied only into an empty record."""

    path = _path(store_dir, learner_id)
    if path is None:
        return empty_progress(learner_id)
    current = load_progress(store_dir, learner_id) or empty_progress(learner_id)
    if not current.counted_attempt_ids:
        for earlier in history[-20:]:
            _count(current, earlier)
    _count(current, attempt)
    current.plan = plan
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(current.model_dump_json(), encoding="utf-8")
    return current


def counts_for(progress: LessonProgress | None, sound: str) -> SoundCounts:
    if progress is None:
        return SoundCounts()
    return progress.sounds.get(sound, SoundCounts())


def _count(progress: LessonProgress, attempt) -> None:
    if attempt.attemptId in progress.counted_attempt_ids:
        return
    bucket = progress.sounds.setdefault(attempt.sound, SoundCounts())
    if attempt.quality == "usable":
        bucket.usable += 1
    else:
        bucket.unclear += 1
    progress.counted_attempt_ids.append(attempt.attemptId)
    if len(progress.counted_attempt_ids) > _MAX_IDS:
        progress.counted_attempt_ids = progress.counted_attempt_ids[-_MAX_IDS:]


def _path(store_dir: str, learner_id: str) -> Path | None:
    if not _ID.fullmatch(learner_id or ""):
        return None
    return Path(store_dir) / "learner_progress" / f"{learner_id.lower()}.json"
