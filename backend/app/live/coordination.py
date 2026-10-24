"""Durable live work queue. APIs enqueue/read; independent worker processes claim/finish.

All transitions use confirmed reducers. A lease token fences stale workers, and
completion commits conversation state, history and the response in one transaction.
"""

import asyncio
import hashlib
import json
import time
import uuid
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, SpacetimeError, sql_literal


def encode(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def job_id(value: str | None) -> str:
    try:
        return str(uuid.UUID(value)) if value else str(uuid.uuid4())
    except ValueError as exc:
        raise HTTPException(422, "invalid_idempotency_key") from exc


def queued_response(identity: str) -> JSONResponse:
    return JSONResponse(
        {"jobId": identity, "statusUrl": f"/v1/live/jobs/{identity}"}, status_code=202,
        headers={"Retry-After": "1", "Cache-Control": "no-store"},
    )


class Coordination:
    def __init__(self, settings: Settings, client: SpacetimeClient):
        self.settings, self.client = settings, client

    async def submit(self, kind: str, body: dict, key: str | None = None) -> JSONResponse:
        identity = job_id(body["attemptId"] if kind == "attempt.coach" else key)
        session = identity if kind == "session.start" else body.get("sessionId", "")
        revision = body.get("expectedRevision") or 0
        if kind == "session.turn" and not revision:
            raise HTTPException(422, "expected_revision_required")
        if kind == "attempt.coach" and body.get("metricsSource") != "inline":
            raise HTTPException(422, "shared_coach_requires_inline_frames")
        payload = encode(body)
        if len(payload.encode()) > 524288:
            raise HTTPException(413, "job_payload_too_large")
        try:
            await self.client.call("enqueue_live_job", [
                identity, body["profileId"], session, kind, payload,
                hashlib.sha256(payload.encode()).hexdigest(), revision,
                self.settings.live_queue_limit, self.settings.live_jobs_per_profile,
                self.settings.live_job_retention_s,
            ])
        except SpacetimeError as exc:
            statuses = {"queue full": 429, "revision conflict": 409, "idempotency conflict": 409,
                        "attempt already exists": 409, "session not found": 404, "profile mismatch": 403}
            raise HTTPException(statuses.get(exc.code, 503), (exc.code or "coordination_unavailable").replace(" ", "_")) from exc
        return queued_response(identity)

    async def get(self, identity: str) -> dict | None:
        identity = job_id(identity)
        rows = await self.client.sql(f"SELECT * FROM live_job WHERE id = {sql_literal(identity)}")
        return rows[0] if rows else None

    async def response(self, identity: str, profile: str) -> JSONResponse:
        try:
            row = await self.get(identity)
        except SpacetimeError as exc:
            raise HTTPException(503, "coordination_unavailable") from exc
        if row is None or row["profile_id"] != profile:
            raise HTTPException(404, "job_not_found")
        if row["status"] == "done":
            return JSONResponse(json.loads(row["result_json"]), headers={"Cache-Control": "no-store"})
        if row["status"] == "failed":
            code = row["error_code"]
            raise HTTPException(409 if code == "revision_conflict" else 404 if code == "session_not_found" else 503, code)
        return queued_response(identity)

    async def candidates(self) -> list[dict]:
        # The status index bounds both queries; completed jobs are never scanned.
        results = await asyncio.gather(*(
            self.client.sql(f"SELECT * FROM live_job WHERE status = '{status}'"
                            + (f" AND lease_until <= {int(time.time())}" if status == "running" else "") + " LIMIT 32")
            for status in ("queued", "running")
        ))
        return sorted([row for rows in results for row in rows], key=lambda row: row["created_at"])

    async def cleanup(self) -> None:
        now = int(time.time())
        jobs, sessions, insights = await asyncio.gather(
            self.client.sql(f"SELECT id FROM live_job WHERE expires_at <= {now} LIMIT 100"),
            self.client.sql(f"SELECT id FROM live_session WHERE expires_at <= {now} LIMIT 100"),
            self.client.sql(f"SELECT attempt_id FROM live_insight WHERE expires_at <= {now} LIMIT 100"),
        )
        if jobs or sessions or insights:
            await self.client.call("cleanup_live_state", [
                [r["id"] for r in jobs], [r["id"] for r in sessions], [r["attempt_id"] for r in insights],
            ])
