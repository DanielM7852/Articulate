"""Per-learner lesson progress for the practice screen.

Counts come from attempts this service has already accepted. The same attempt
id does not count twice. A stored count is not a clinical improvement, and it
does not say a cue caused the next result.

Progress lives in SpacetimeDB when it is configured, otherwise in JSON files
under the local store.
"""

import asyncio
import logging
import re
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, profile_literal, unwrap

logger = logging.getLogger(__name__)

_ID = re.compile(r"^[A-Za-z0-9._@+-]{1,80}$")
_PROFILE = re.compile(r"^[A-Za-z0-9_.:@-]{1,64}$")  # the module's profileIdRe
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


def apply_attempt(
    progress: LessonProgress | None, learner_id: str, attempt, plan: LessonPlan, history: list
) -> LessonProgress:
    """Count this attempt once. History is copied only into an empty record."""

    current = progress.model_copy(deep=True) if progress is not None else empty_progress(learner_id)
    if not current.counted_attempt_ids:
        for earlier in history[-20:]:
            _count(current, earlier)
    _count(current, attempt)
    current.plan = plan
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


class ProgressStore(Protocol):
    async def load(self, learner_id: str) -> LessonProgress | None: ...

    async def save(self, progress: LessonProgress) -> bool: ...


class LocalProgressStore:
    def __init__(self, store_dir: str) -> None:
        self._store_dir = store_dir

    @staticmethod
    def _read(path: Path) -> LessonProgress | None:
        if not path.exists():
            return None
        return LessonProgress.model_validate_json(path.read_text(encoding="utf-8"))

    @staticmethod
    def _write(path: Path, progress: LessonProgress) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(progress.model_dump_json(), encoding="utf-8")

    async def load(self, learner_id: str) -> LessonProgress | None:
        path = _path(self._store_dir, learner_id)
        if path is None:
            return None
        try:
            return await asyncio.to_thread(self._read, path)
        except (OSError, ValueError) as exc:
            logger.warning("local progress read failed: %s", type(exc).__name__)
            return None

    async def save(self, progress: LessonProgress) -> bool:
        path = _path(self._store_dir, progress.learner_id)
        if path is None:
            return False
        try:
            await asyncio.to_thread(self._write, path, progress)
            return True
        except OSError as exc:
            logger.warning("local progress write failed: %s", type(exc).__name__)
            return False


class SpacetimeProgressStore:
    def __init__(self, client: SpacetimeClient) -> None:
        self._client = client

    async def load(self, learner_id: str) -> LessonProgress | None:
        if not _PROFILE.fullmatch(learner_id or ""):
            logger.debug("progress not loaded: id is not a module profile id")
            return None
        try:
            rows = await self._client.sql(
                f"SELECT * FROM learner_progress WHERE profile_id = {profile_literal(learner_id)}"
            )
            text = unwrap(rows[0].get("progress")) if rows else None
            if not isinstance(text, str) or not text:
                return None
            return LessonProgress.model_validate_json(text)
        except Exception as exc:  # noqa: BLE001 - storage failures never reach the route
            logger.warning("learner progress read failed: %s", type(exc).__name__)
            return None

    async def save(self, progress: LessonProgress) -> bool:
        if not _PROFILE.fullmatch(progress.learner_id or ""):
            logger.debug("progress not saved: id is not a module profile id")
            return False
        try:
            await self._client.call("set_learner_progress", [progress.learner_id, progress.model_dump_json()])
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("set_learner_progress failed: %s", type(exc).__name__)
            return False


def build_progress_store(settings: Settings, transport=None, http=None) -> ProgressStore:
    if settings.spacetime_configured:
        return SpacetimeProgressStore(SpacetimeClient(settings, transport, http))
    return LocalProgressStore(settings.store_dir)
