"""In-memory progress events for one backend process."""

import asyncio
import time

from app.schemas import AnalysisStatus, ProgressEvent, ProgressStage

_TERMINAL = {"partial", "complete", "failed"}


class ProgressBus:
    def __init__(self) -> None:
        self._history: dict[str, list[ProgressEvent]] = {}
        self._subscribers: dict[str, list[asyncio.Queue]] = {}

    def publish(
        self,
        *,
        attempt_id: str,
        session_id: str,
        stage: ProgressStage,
        message: str,
        started: float,
        result_status: AnalysisStatus | None = None,
    ) -> ProgressEvent:
        event = ProgressEvent(
            attempt_id=attempt_id,
            session_id=session_id,
            stage=stage,
            result_status=result_status,
            message=message,
            elapsed_ms=round((time.perf_counter() - started) * 1000.0, 3),
        )
        self._history.setdefault(attempt_id, []).append(event)
        for queue in list(self._subscribers.get(attempt_id, [])):
            queue.put_nowait(event)
        return event

    async def iter_events(self, attempt_id: str):
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(attempt_id, []).append(queue)
        try:
            # No await between subscribe and snapshot, so a publish cannot be missed.
            history = list(self._history.get(attempt_id, []))
            for event in history:
                yield event
                if event.stage in _TERMINAL:
                    return
            while True:
                event = await queue.get()
                yield event
                if event.stage in _TERMINAL:
                    return
        finally:
            subscribers = self._subscribers.get(attempt_id, [])
            if queue in subscribers:
                subscribers.remove(queue)

    def clear_attempt(self, attempt_id: str) -> None:
        self._history.pop(attempt_id, None)
