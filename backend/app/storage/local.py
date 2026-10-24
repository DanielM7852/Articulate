"""JSON session store.

Raw learner audio is never written. A saved result contains derived contours,
measurements, and the short coaching handoff so a duplicate attempt id can be
replayed. Delete the session to remove that derived record.
"""

import json
import re
import threading
from pathlib import Path

from app.errors import ArticulateError, StaleAttemptError
from app.schemas import AttemptSummary, ComparisonResult

_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


class LocalSessionStore:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def get_result(self, session_id: str, attempt_id: str) -> ComparisonResult | None:
        with self._lock:
            payload = self._read(session_id)
            stored = payload["attempts"].get(attempt_id)
            if not stored or "result" not in stored:
                return None
            return ComparisonResult.model_validate(stored["result"])

    def latest_attempt_id(self, session_id: str) -> str | None:
        with self._lock:
            return self._read(session_id).get("latest_attempt_id")

    def begin_attempt(self, session_id: str, attempt_id: str) -> None:
        with self._lock:
            payload = self._read(session_id)
            payload["latest_attempt_id"] = attempt_id
            self._write(session_id, payload)

    def save_result(self, session_id: str, attempt_id: str, result: ComparisonResult) -> None:
        with self._lock:
            payload = self._read(session_id)
            if payload.get("latest_attempt_id") != attempt_id:
                raise StaleAttemptError(session_id, attempt_id)
            payload["attempts"][attempt_id] = {
                "summary": AttemptSummary(
                    attempt_id=attempt_id,
                    status=result.status,
                    finding=result.finding,
                    cue_id=result.feedback.cue_id,
                    next_action=result.feedback.next_action,
                ).model_dump(),
                "result": result.model_dump(mode="json"),
            }
            self._write(session_id, payload)

    def recent_summaries(self, session_id: str, limit: int = 3) -> list[AttemptSummary]:
        with self._lock:
            payload = self._read(session_id)
            items = []
            for attempt in payload["attempts"].values():
                if "summary" in attempt:
                    items.append(AttemptSummary.model_validate(attempt["summary"]))
            return items[-limit:]

    def attempted_cue_ids(self, session_id: str) -> list[str]:
        with self._lock:
            payload = self._read(session_id)
            cue_ids = []
            for attempt in payload["attempts"].values():
                cue_id = attempt.get("summary", {}).get("cue_id")
                if cue_id:
                    cue_ids.append(cue_id)
            return cue_ids

    def attempt_ids(self, session_id: str) -> list[str]:
        with self._lock:
            return list(self._read(session_id).get("attempts", {}).keys())

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            path = self._path(session_id)
            if not path.exists():
                return False
            path.unlink()
            return True

    def _path(self, session_id: str) -> Path:
        if not _ID_RE.fullmatch(session_id):
            raise ArticulateError("invalid_id", "session_id is not valid.", status_code=422)
        return self.directory / f"{session_id}.json"

    def _read(self, session_id: str) -> dict:
        path = self._path(session_id)
        if not path.exists():
            return {"session_id": session_id, "latest_attempt_id": None, "attempts": {}}
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, session_id: str, payload: dict) -> None:
        path = self._path(session_id)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        temporary.replace(path)
