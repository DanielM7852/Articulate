"""Insight state shared across API replicas and workers (SpacetimeDB `live_insight` table).

Raw audio never enters the database; only the status, the validated spoken line and its source do.
"""

import time
from typing import Any

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, sql_literal

STALE_GRACE_S = 30


class SharedInsights:
    def __init__(self, settings: Settings, client: SpacetimeClient):
        self.settings, self.client = settings, client

    @property
    def ttl_s(self) -> int:
        return min(86400, max(60, int(self.settings.insight_ttl_s)))

    @property
    def pending_limit_s(self) -> float:
        return self.settings.articulation_timeout_s + self.settings.live_insight_timeout_s + STALE_GRACE_S

    async def set(self, attempt_id: str, profile_id: str, sound: str, status: str,
                  say: str | None = None, source: str | None = None) -> None:
        """Write one state transition. Propagates SpacetimeError."""
        await self.client.call("set_live_insight", [
            attempt_id, profile_id, sound, status, say or "", source or "", self.ttl_s,
        ])

    async def get(self, attempt_id: str, profile_id: str) -> dict[str, Any] | None:
        rows = await self.client.sql(f"SELECT * FROM live_insight WHERE attempt_id = {sql_literal(attempt_id)}")
        if not rows:
            return None
        row = rows[0]
        now = time.time()
        if row.get("profile_id") != profile_id or int(row.get("expires_at") or 0) <= now:
            return None
        created = int(row.get("created_at") or 0)
        status = row.get("status")
        if status == "pending" and now - created > self.pending_limit_s:
            status = "none"  # the replica that accepted the upload most likely died
        return {
            "profileId": row["profile_id"], "sound": row.get("sound"), "status": status,
            "say": row.get("say") or None, "source": row.get("source") or None, "created": created,
        }


class InsightSnapshot:
    """One preloaded entry (for the attempt being delivered) with the runtime's sync get/mark interface."""

    def __init__(self, entry: dict | None):
        self.entry, self.delivered = entry, ""

    def get_insight(self, attempt_id: str, profile_id: str | None = None) -> dict | None:
        entry = self.entry
        if entry is None or (profile_id is not None and entry["profileId"] != profile_id):
            return None
        return entry

    def mark_insight_delivered(self, attempt_id: str) -> None:
        if self.entry is not None:
            self.entry = {**self.entry, "status": "delivered"}
            self.delivered = attempt_id
