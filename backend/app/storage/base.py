"""Storage interface for session summaries and cached comparison results."""

from typing import Protocol

from app.schemas import AttemptSummary, ComparisonResult


class SessionStore(Protocol):
    def get_result(self, session_id: str, attempt_id: str) -> ComparisonResult | None:
        ...

    def latest_attempt_id(self, session_id: str) -> str | None:
        ...

    def begin_attempt(self, session_id: str, attempt_id: str) -> None:
        ...

    def save_result(self, session_id: str, attempt_id: str, result: ComparisonResult) -> None:
        ...

    def recent_summaries(self, session_id: str, limit: int = 3) -> list[AttemptSummary]:
        ...

    def attempted_cue_ids(self, session_id: str) -> list[str]:
        ...

    def attempt_ids(self, session_id: str) -> list[str]:
        ...

    def delete_session(self, session_id: str) -> bool:
        ...
