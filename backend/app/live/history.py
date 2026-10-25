"""Learner history: SpacetimeDB when configured, otherwise JSON files under the local store."""

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, profile_literal, timestamp_micros, unwrap
from app.live.articulation import annotate_attempts

logger = logging.getLogger(__name__)


@dataclass
class LearnerContext:
    attempts: list[dict[str, Any]] = field(default_factory=list)  # vowel turns, newest first, compact
    word_attempts: list[dict[str, Any]] = field(default_factory=list)  # word turns, newest first, compact
    timeline: list[dict[str, Any]] = field(default_factory=list)  # every turn, newest first, for the learner model
    notes: dict[str, Any] | None = None


class LearnerHistory(Protocol):
    async def load(self, profile_id: str, limit: int) -> LearnerContext: ...

    async def record(self, profile_id: str, attempt_id: str, summary: dict, decision: dict) -> bool: ...

    async def save_notes(self, profile_id: str, notes: dict) -> bool: ...

    async def record_articulation(self, profile_id: str, attempt_id: str, sound: str, features: dict) -> bool: ...

    async def same_pitch_cue_count(self, profile_id: str, attempt_id: str, word: str, cue: str) -> int: ...


MODEL_LOOKBACK = 200  # turns the learner model is built from
ARTIC_LOOKBACK = 3  # load limit * 3 attempts so older on_target anchors are available to annotate_attempts


def _annotate(compacts: list[dict[str, Any]], features: dict[str, dict], limit: int) -> list[dict[str, Any]]:
    """Attach stored features by attemptId, run the gate over the longer list, return the newest `limit`."""
    if not features:
        return compacts[:limit]
    for item in compacts:
        stored = features.get(item.get("attemptId"))
        if stored is not None:
            item["artic"] = stored
    return annotate_attempts(compacts)[:limit]


def compact_attempt(summary: dict, decision: dict | None = None) -> dict[str, Any]:
    """Small, model-friendly view of one past attempt."""
    audio = summary.get("audio") or {}
    video = summary.get("video") or {}
    decision = decision or {}
    w = summary.get("word")
    caption = summary.get("caption", decision.get("caption"))
    if isinstance(w, dict):
        zones = w.get("zones") or []
        practice = w.get("practiceZoneIds")
        return {
            "kind": "word",
            "attemptId": summary.get("attemptId"),
            "word": w.get("word"),
            "verdict": w.get("verdict"),
            "quality": w.get("quality", "usable" if zones else None),
            "zones": [
                {"id": z.get("zoneId"), "phoneme": z.get("phoneme"), "kind": z.get("kind"),
                 "verdict": z.get("verdict"), "advisory": bool(z.get("advisory")),
                 "inScope": not practice or z.get("zoneId") in practice}
                for z in zones if isinstance(z, dict)
            ],
            "focusZoneId": summary.get("focusZoneId", decision.get("focusZoneId")),
            "cueId": summary.get("cueId", decision.get("cueId")),
            "nextAction": summary.get("nextAction", decision.get("nextAction")),
            "caption": caption,
        }
    return {
        "attemptId": summary.get("attemptId"),
        "sound": summary.get("sound"),
        "audioVerdict": audio.get("verdict"),
        "f1Offset": audio.get("f1Offset"),
        "f2Offset": audio.get("f2Offset"),
        "inTargetFraction": audio.get("inTargetFraction"),
        "videoVerdict": video.get("verdict") if video else None,
        "cueId": summary.get("cueId", decision.get("cueId")),
        "nextAction": summary.get("nextAction", decision.get("nextAction")),
        "caption": caption,
        "focusZoneId": summary.get("focusZoneId", decision.get("focusZoneId")),
        "wordVerdict": (summary.get("word") or {}).get("verdict") if isinstance(summary.get("word"), dict) else None,
    }


def _split(compacts: list[dict[str, Any]], features: dict[str, dict], limit: int) -> LearnerContext:
    """Newest-first compacts into vowel turns (annotated), word turns and the full timeline."""
    vowels = [c for c in compacts if c.get("kind") != "word"]
    words = [c for c in compacts if c.get("kind") == "word"]
    return LearnerContext(
        attempts=_annotate(vowels[: limit * ARTIC_LOOKBACK], features, limit),
        word_attempts=words[:limit],
        timeline=compacts[:MODEL_LOOKBACK],
    )


def _safe_name(profile_id: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]", "_", profile_id)[:40]
    return f"{base}-{hashlib.sha256(profile_id.encode()).hexdigest()[:8]}"


class LocalHistory:
    def __init__(self, settings: Settings) -> None:
        self._dir = Path(settings.store_dir) / "learners"
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, profile_id: str) -> asyncio.Lock:
        return self._locks.setdefault(self._path(profile_id).name, asyncio.Lock())

    def _path(self, profile_id: str) -> Path:
        return self._dir / f"{_safe_name(profile_id)}.json"

    def _read(self, profile_id: str) -> dict[str, Any]:
        try:
            data = json.loads(self._path(profile_id).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, profile_id: str, data: dict[str, Any]) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._path(profile_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)

    async def load(self, profile_id: str, limit: int) -> LearnerContext:
        data = await asyncio.to_thread(self._read, profile_id)
        turns = [t for t in data.get("attempts", []) if isinstance(t, dict)]
        recent = list(reversed(turns))[:MODEL_LOOKBACK]
        stored = data.get("articulation")
        features = {
            k: v["features"] for k, v in (stored.items() if isinstance(stored, dict) else [])
            if isinstance(v, dict) and isinstance(v.get("features"), dict)
        }
        compacts = [compact_attempt(t.get("summary") or {}, t.get("decision")) for t in recent]
        context = _split(compacts, features, limit)
        context.notes = data.get("notes") if isinstance(data.get("notes"), dict) else None
        return context

    async def record(self, profile_id: str, attempt_id: str, summary: dict, decision: dict) -> bool:
        def work() -> None:
            data = self._read(profile_id)
            attempts = [t for t in data.get("attempts", []) if (t.get("summary") or {}).get("attemptId") != attempt_id]
            attempts.append({"summary": summary, "decision": decision})
            data["attempts"] = attempts[-200:]
            self._write(profile_id, data)

        try:
            async with self._lock(profile_id):
                await asyncio.to_thread(work)
            return True
        except OSError as exc:
            logger.warning("local history write failed: %s", type(exc).__name__)
            return False

    async def record_articulation(self, profile_id: str, attempt_id: str, sound: str, features: dict) -> bool:
        def work() -> None:
            data = self._read(profile_id)
            store = data.get("articulation")
            store = dict(store) if isinstance(store, dict) else {}
            store.pop(attempt_id, None)
            store[attempt_id] = {"sound": sound, "features": features}
            data["articulation"] = dict(list(store.items())[-200:])
            self._write(profile_id, data)

        try:
            async with self._lock(profile_id):
                await asyncio.to_thread(work)
            return True
        except OSError as exc:
            logger.warning("local articulation write failed: %s", type(exc).__name__)
            return False

    async def same_pitch_cue_count(self, profile_id: str, attempt_id: str, word: str, cue: str) -> int:
        def work() -> int:
            data = self._read(profile_id)
            store = data.get("articulation")
            if not isinstance(store, dict):
                return 0
            recent = []
            for key, item in list(store.items())[-12:]:
                features = item.get("features") if isinstance(item, dict) else None
                recent.append((key, features if isinstance(features, dict) else {}))
            return _same_pitch_count(recent, attempt_id, word, cue)

        try:
            return await asyncio.to_thread(work)
        except OSError as exc:
            logger.warning("local pitch cue count failed: %s", type(exc).__name__)
            return 0

    async def save_notes(self, profile_id: str, notes: dict) -> bool:
        def work() -> None:
            data = self._read(profile_id)
            data["notes"] = notes
            self._write(profile_id, data)

        try:
            async with self._lock(profile_id):
                await asyncio.to_thread(work)
            return True
        except OSError as exc:
            logger.warning("local notes write failed: %s", type(exc).__name__)
            return False


def _same_pitch_count(rows: list[tuple[Any, dict]], attempt_id: str, word: str, cue: str) -> int:
    count = 0
    for aid, features in rows:
        if aid == attempt_id or not isinstance(features, dict):
            continue
        table = features.get("pitchTable")
        if isinstance(table, dict) and table.get("word") == word and table.get("cue") == cue:
            count += 1
    return count


def _loads(text: Any) -> dict[str, Any]:
    text = unwrap(text)
    if not isinstance(text, str) or not text:
        return {}
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


class SpacetimeHistory:
    def __init__(self, client: SpacetimeClient) -> None:
        self._client = client

    async def load(self, profile_id: str, limit: int) -> LearnerContext:
        lit = profile_literal(profile_id)
        rows = await self._client.sql(f"SELECT * FROM learner_attempt WHERE profile_id = {lit}")
        rows.sort(key=lambda r: timestamp_micros(r.get("started_at")), reverse=True)
        attempts = []
        for row in rows:
            summary = _loads(row.get("summary"))
            if not summary:
                continue
            summary.setdefault("attemptId", unwrap(row.get("attempt_id")))
            summary.setdefault("sound", unwrap(row.get("sound")))
            attempts.append(compact_attempt(summary))
            if len(attempts) >= MODEL_LOOKBACK:
                break
        features: dict[str, dict] = {}
        try:
            for row in await self._client.sql(f"SELECT * FROM learner_articulation WHERE profile_id = {lit}"):
                stored = _loads(row.get("features"))
                if stored:
                    features[unwrap(row.get("attempt_id"))] = stored
        except Exception as exc:  # noqa: BLE001
            logger.warning("learner articulation read failed: %s", type(exc).__name__)
        context = _split(attempts, features, limit)
        notes = None
        try:
            note_rows = await self._client.sql(f"SELECT * FROM learner_note WHERE profile_id = {lit}")
            if note_rows:
                notes = _loads(note_rows[0].get("notes")) or None
        except Exception as exc:  # noqa: BLE001
            logger.warning("learner note read failed: %s", type(exc).__name__)
        context.notes = notes
        return context

    async def record(self, profile_id: str, attempt_id: str, summary: dict, decision: dict) -> bool:
        try:
            await self._client.call(
                "record_coach_turn",
                [attempt_id, json.dumps(summary, separators=(",", ":")), json.dumps(decision, separators=(",", ":"))],
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("record_coach_turn failed: %s", type(exc).__name__)
            return False

    async def record_articulation(self, profile_id: str, attempt_id: str, sound: str, features: dict) -> bool:
        try:
            await self._client.call(
                "record_articulation", [attempt_id, profile_id, json.dumps(features, separators=(",", ":"))]
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("record_articulation failed: %s", type(exc).__name__)
            return False

    async def same_pitch_cue_count(self, profile_id: str, attempt_id: str, word: str, cue: str) -> int:
        lit = profile_literal(profile_id)
        try:
            rows = await self._client.sql(f"SELECT * FROM learner_articulation WHERE profile_id = {lit}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("pitch cue count failed: %s", type(exc).__name__)
            return 0
        rows.sort(key=lambda row: timestamp_micros(row.get("created_at")), reverse=True)
        paired = []
        for row in rows[:12]:
            paired.append((unwrap(row.get("attempt_id")), _loads(row.get("features"))))
        return _same_pitch_count(paired, attempt_id, word, cue)

    async def save_notes(self, profile_id: str, notes: dict) -> bool:
        try:
            await self._client.call("set_learner_note", [profile_id, json.dumps(notes, separators=(",", ":"))])
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("set_learner_note failed: %s", type(exc).__name__)
            return False


def build_history(settings: Settings, transport=None, http=None) -> LearnerHistory:
    if settings.spacetime_configured:
        return SpacetimeHistory(SpacetimeClient(settings, transport, http))
    return LocalHistory(settings)
