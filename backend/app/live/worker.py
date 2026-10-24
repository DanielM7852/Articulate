"""Run with `python -m app.live.worker` from backend/. No listener or sticky sessions.

Several processes/containers may use the same database. Reducers arbitrate claims;
provider calls are at-least-once after a crash, but only the current lease can commit.
"""

import asyncio
from collections import deque
from contextlib import suppress
from dataclasses import asdict, replace
import json
import logging
import time
import uuid

from app.config import Settings, get_settings
from app.integrations.spacetime import SpacetimeError
from app.live.coordination import Coordination, encode
from app.live.history import LearnerHistory
from app.live.notes import update_notes
from app.live.orchestrator import LiveDeps, coach_attempt
from app.live.runtime import LiveRuntime
from app.live.schemas import LiveCoachRequest, SessionStartRequest, SessionTurnRequest
from app.live.session import HISTORY_TURNS, SessionState, SessionStore, start_session, take_turn

logger = logging.getLogger(__name__)


class DeferredHistory:
    """Read the real history, stage writes until the lease-fenced completion reducer."""

    def __init__(self, history: LearnerHistory):
        self.history = history
        self.summary: dict | None = None
        self.decision: dict | None = None
        self.notes: dict | None = None

    async def load(self, profile_id, limit):
        return await self.history.load(profile_id, limit)

    async def record(self, profile_id, attempt_id, summary, decision):
        self.summary, self.decision = summary, decision
        return True

    async def save_notes(self, profile_id, notes):
        self.notes = notes
        return True


class Worker:
    def __init__(self, settings: Settings, coordination: Coordination, deps: LiveDeps):
        self.settings, self.coordination, self.deps = settings, coordination, deps
        self.identity = str(uuid.uuid4())

    async def claim(self, row: dict) -> dict | None:
        token = str(uuid.uuid4())
        try:
            await self.coordination.client.call("claim_live_job", [
                row["id"], self.identity, token, self.settings.live_job_lease_s, self.settings.live_global_concurrency,
            ])
            claimed = await self.coordination.get(row["id"])
        except SpacetimeError:
            return None  # Another worker may have won, or the database may be unavailable.
        if claimed and claimed["status"] == "running" and claimed["lease_token"] == token:
            return claimed
        return None

    async def compute(self, job: dict) -> list:
        payload = json.loads(job["request_json"])
        history = DeferredHistory(self.deps.get_history())
        deps = replace(self.deps, history=history)
        state_json = ""
        if job["kind"] == "attempt.coach":
            response = await coach_attempt(deps, LiveCoachRequest.model_validate(payload))
            response.persisted = True  # This result becomes visible only after atomic completion.
        elif job["kind"] == "notes.update":
            response = await update_notes(deps, job["profile_id"])
        else:
            store = SessionStore(self.settings.live_session_ttl_s)
            if job["kind"] == "session.start":
                response = await start_session(
                    deps, store, SessionStartRequest.model_validate(payload), session_id=job["session_id"],
                )
            else:
                rows = await self.coordination.client.sql(
                    f"SELECT * FROM live_session WHERE id = '{job['session_id']}'"
                )
                if not rows or rows[0]["profile_id"] != job["profile_id"]:
                    raise ValueError("session_not_found")
                saved = json.loads(rows[0]["state_json"])
                saved["turns"] = deque(saved["turns"], maxlen=HISTORY_TURNS)
                store.add(SessionState(**saved))
                response = await take_turn(deps, store, SessionTurnRequest.model_validate(payload))
            state = store.get(job["session_id"], job["profile_id"])
            snapshot = asdict(state)
            snapshot["turns"] = list(state.turns)
            snapshot["last_used"] = 0  # Process-local monotonic timestamps are never shared.
            state_json = encode(snapshot)
            response.revision = job["expected_revision"] + 1
        return [
            job["id"], job["lease_token"], encode(response.model_dump()), state_json,
            encode(history.summary) if history.summary is not None else "",
            encode(history.decision) if history.decision is not None else "",
            encode(history.notes) if history.notes is not None else "",
            min(86400, max(1, int(self.settings.live_session_ttl_s))),
        ]

    async def _heartbeat(self, job: dict) -> None:
        while True:
            await asyncio.sleep(self.settings.live_job_lease_s / 3)
            await self.coordination.client.call("renew_live_job", [
                job["id"], job["lease_token"], self.settings.live_job_lease_s,
            ])

    async def execute(self, job: dict) -> None:
        work = asyncio.create_task(self.compute(job))
        heartbeat = asyncio.create_task(self._heartbeat(job))
        try:
            done, _ = await asyncio.wait({work, heartbeat}, return_when=asyncio.FIRST_COMPLETED, timeout=240)
            if work not in done:
                # Failed renewal or deadline: stop producing side effects; let the lease be reclaimed.
                if heartbeat in done:
                    heartbeat.result()
                return
            args = work.result()
            # Completion is idempotent for this token, including a lost confirmed HTTP response.
            for attempt in range(3):
                try:
                    await self.coordination.client.call("finish_live_job", args)
                    return
                except SpacetimeError:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(0.2 * (attempt + 1))
        except asyncio.CancelledError:
            raise  # Shutdown leaves the job reclaimable; never mark an unfinished provider call successful.
        except Exception as exc:  # noqa: BLE001 - isolate one bad job, never log request contents
            logger.warning("job %s ended without a result (%s)", job["id"], type(exc).__name__)
            if work.done() and not work.cancelled() and work.exception() is not None:
                with suppress(SpacetimeError):
                    await self.coordination.client.call("fail_live_job", [job["id"], job["lease_token"]])
        finally:
            work.cancel()
            heartbeat.cancel()
            await asyncio.gather(work, heartbeat, return_exceptions=True)

    async def run(self) -> None:
        active: set[asyncio.Task] = set()
        next_cleanup = 0.0
        try:
            while True:
                active = {task for task in active if not task.done()}
                try:
                    if len(active) < self.settings.live_worker_concurrency:
                        for row in await self.coordination.candidates():
                            if len(active) >= self.settings.live_worker_concurrency:
                                break
                            if row["status"] == "running" and row["lease_until"] > time.time():
                                continue
                            claimed = await self.claim(row)
                            if claimed:
                                active.add(asyncio.create_task(self.execute(claimed)))
                    if time.monotonic() >= next_cleanup:
                        await self.coordination.cleanup()
                        next_cleanup = time.monotonic() + 30
                except Exception as exc:  # noqa: BLE001
                    logger.warning("worker poll failed (%s)", type(exc).__name__)
                await asyncio.sleep(self.settings.live_job_poll_s)
        finally:
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)


async def main() -> None:
    settings = get_settings()
    if settings.live_coordination != "spacetime":
        raise SystemExit("Worker requires LIVE_COORDINATION=spacetime")
    runtime = LiveRuntime(settings)
    client = runtime.spacetime()
    assert client is not None
    deps = LiveDeps(settings, anthropic_client=runtime.anthropic(), history=runtime.history(), spacetime=client)
    try:
        await Worker(settings, Coordination(settings, client), deps).run()
    finally:
        await runtime.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
