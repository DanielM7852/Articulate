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

    async def get_about(self, profile_id: str) -> str | None: ...

    async def set_about(self, profile_id: str, text: str | None) -> bool: ...


LEGACY_ABOUT_KEY = "aboutMe"  # rev1 kept the text inside notes; read once as a fallback, never written


def _about_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def about_key(profile_id: str) -> str:
    """Spacetime learner_note key for the learner's about text. A fixed-length hash after "about:" keeps it inside the
    reducer's [A-Za-z0-9_.:@-]{1,64} rule whatever the profile id length, and apart from real ids ("learner-<hex>")."""
    return "about:" + hashlib.sha256(profile_id.encode()).hexdigest()[:32]


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
        notes = data.get("notes")
        if isinstance(notes, dict):  # a rev1 file may still carry the about text; the coach must never see it
            context.notes = {k: v for k, v in notes.items() if k != LEGACY_ABOUT_KEY} or None
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

    async def save_notes(self, profile_id: str, notes: dict) -> bool:
        def work() -> None:
            data = self._read(profile_id)  # keeps every other top-level key, including "about"
            data["notes"] = notes
            self._write(profile_id, data)

        try:
            async with self._lock(profile_id):
                await asyncio.to_thread(work)
            return True
        except OSError as exc:
            logger.warning("local notes write failed: %s", type(exc).__name__)
            return False

    async def get_about(self, profile_id: str) -> str | None:
        try:
            async with self._lock(profile_id):
                data = await asyncio.to_thread(self._read, profile_id)
        except OSError:
            return None
        about = _about_text(data.get("about"))
        if about is None and isinstance(data.get("notes"), dict):
            about = _about_text(data["notes"].get(LEGACY_ABOUT_KEY))  # rev1 dev files
        return about

    async def set_about(self, profile_id: str, text: str | None) -> bool:
        def work() -> None:
            data = self._read(profile_id)
            if text:
                data["about"] = text
            else:
                data.pop("about", None)
            notes = data.get("notes")
            if isinstance(notes, dict) and LEGACY_ABOUT_KEY in notes:
                data["notes"] = {k: v for k, v in notes.items() if k != LEGACY_ABOUT_KEY}
            self._write(profile_id, data)

        try:
            async with self._lock(profile_id):
                await asyncio.to_thread(work)
            return True
        except OSError as exc:
            logger.warning("local about write failed: %s", type(exc).__name__)
            return False


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
            notes = await self._read_notes(lit)
        except Exception as exc:  # noqa: BLE001
            logger.warning("learner note read failed: %s", type(exc).__name__)
        context.notes = notes or None
        return context

    async def _read_notes(self, lit: str) -> dict[str, Any]:
        note_rows = await self._client.sql(f"SELECT * FROM learner_note WHERE profile_id = {lit}")
        return _loads(note_rows[0].get("notes")) if note_rows else {}

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

    async def save_notes(self, profile_id: str, notes: dict) -> bool:
        try:
            await self._client.call("set_learner_note", [profile_id, json.dumps(notes, separators=(",", ":"))])
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("set_learner_note failed: %s", type(exc).__name__)
            return False

    async def get_about(self, profile_id: str) -> str | None:
        profile_literal(profile_id)  # validates the id
        rows = await self._client.sql(
            f"SELECT notes FROM learner_note WHERE profile_id = {profile_literal(about_key(profile_id))}")
        about = _loads(rows[0].get("notes")).get("text") if rows else None
        return _about_text(about)

    async def set_about(self, profile_id: str, text: str | None) -> bool:
        try:
            profile_literal(profile_id)
            body = json.dumps({"text": text or ""}, separators=(",", ":"))
            await self._client.call("set_learner_note", [about_key(profile_id), body])
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("set_about failed: %s", type(exc).__name__)
            return False


def build_history(settings: Settings, transport=None, http=None) -> LearnerHistory:
    if settings.spacetime_configured:
        return SpacetimeHistory(SpacetimeClient(settings, transport, http))
    return LocalHistory(settings)
