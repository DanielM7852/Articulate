"""SQLite is a local retry spool and recovery log, never a second shared state authority."""

import asyncio
import json
import sqlite3
import time
from urllib.parse import quote

import httpx

from .config import Settings
from .schemas import AttemptSummary, CueOutcome


class Outbox:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(settings.data_dir / "outbox.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session TEXT NOT NULL, "
            "kind TEXT NOT NULL, body TEXT NOT NULL, synced INTEGER DEFAULT 0, "
            "tries INTEGER DEFAULT 0, next_try REAL DEFAULT 0)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS recovery (session TEXT PRIMARY KEY, token_hash TEXT NOT NULL, "
            "snapshot TEXT NOT NULL, expires REAL NOT NULL)"
        )
        self.db.commit()

    def append(self, event: dict):
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO events(id,session,kind,body) VALUES(?,?,?,?)",
                (event["event_id"], event["session_id"], event["type"], json.dumps(event)),
            )

    def save(self, session_id, token_hash, snapshot, expires):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO recovery VALUES(?,?,?,?)",
                (str(session_id), token_hash, json.dumps(snapshot), expires),
            )

    def recover(self, session_id):
        row = self.db.execute(
            "SELECT token_hash,snapshot,expires FROM recovery WHERE session=? AND expires>?",
            (str(session_id), time.time()),
        ).fetchone()
        if not row:
            return None
        snapshot = json.loads(row[1])
        # A crash can occur after append committed but before the recovery snapshot.
        # Rebuild durable fields from the journal so revisions never rewind.
        journal = [
            json.loads(r[0])
            for r in self.db.execute(
                "SELECT body FROM events WHERE session=? ORDER BY rowid", (str(session_id),)
            )
        ]
        snapshot["sync_revision"] = len(journal)
        summaries = []
        summary_by_id, outcomes_by_attempt = {}, {}
        for event in journal:
            snapshot["seq"] = max(snapshot["seq"], event["seq"])
            if event["type"] == "session.state":
                snapshot["session"] = event["payload"]["session"]
            elif event["type"] == "attempt.summary":
                summary = {k: v for k, v in event["payload"].items() if k in AttemptSummary.model_fields}
                summaries.append(summary)
                summary_by_id[event["attempt_id"]] = summary
            elif event["type"] == "coach.decision" and event["payload"].get("observation_id"):
                decision = event["payload"]
                summary = summary_by_id.get(event["attempt_id"])
                if summary and decision.get("cue_id"):
                    outcome = CueOutcome(
                        cue_id=decision["cue_id"],
                        attempt_id=summary["attempt_id"],
                        target_id=summary["target_id"],
                        target_version=summary["target_version"],
                        source=summary["source"],
                        distance=summary["target_distance"],
                        assistance_level=summary["assistance_level"],
                        result="awaiting_retry",
                    )
                    outcomes_by_attempt[event["attempt_id"]] = outcome.model_dump(mode="json")
            elif event["type"] == "provider.status" and event["payload"].get("cue_outcome"):
                outcome = event["payload"]["cue_outcome"]
                if outcome["attempt_id"] in outcomes_by_attempt:
                    outcomes_by_attempt[outcome["attempt_id"]] = CueOutcome.model_validate(
                        outcome
                    ).model_dump(mode="json")
        snapshot["history"] = summaries[-50:]
        if outcomes_by_attempt:
            snapshot["outcomes"] = list(outcomes_by_attempt.values())[-50:]
        return row[0], snapshot, row[2]

    def pending(self, session_id=None):
        if session_id:
            return self.db.execute(
                "SELECT count(*) FROM events WHERE synced=0 AND session=?", (str(session_id),)
            ).fetchone()[0]
        return self.db.execute("SELECT count(*) FROM events WHERE synced=0").fetchone()[0]

    async def flush(self, client: httpx.AsyncClient):
        if self.settings.mock_mode:
            return  # pending-sync stays visible; do not report a fake database integration
        if not self.settings.spacetimedb_database or not self.settings.spacetimedb_token:
            return
        # Global insertion order preserves per-session revisions. Stop at a failed write.
        rows = self.db.execute(
            "SELECT id,body,tries,next_try FROM events WHERE synced=0 ORDER BY rowid LIMIT 32"
        ).fetchall()
        for identity, body, tries, due in rows:
            if due > time.time():
                break
            try:
                base = self.settings.spacetimedb_uri.rstrip("/")
                database = quote(self.settings.spacetimedb_database, safe="")
                response = await client.post(
                    f"{base}/v1/database/{database}/call/commit_event?confirmed=true",
                    headers={"Authorization": f"Bearer {self.settings.spacetimedb_token}"},
                    json=[body],
                    timeout=5,
                )
                response.raise_for_status()
                with self.db:
                    self.db.execute("UPDATE events SET synced=1 WHERE id=?", (identity,))
            except httpx.HTTPError:
                with self.db:
                    self.db.execute(
                        "UPDATE events SET tries=tries+1,next_try=? WHERE id=?",
                        (time.time() + min(60, 2 ** min(tries, 6)), identity),
                    )
                break

    async def run(self, on_status=None):
        async with httpx.AsyncClient() as client:
            while True:
                await self.flush(client)
                if on_status:
                    on_status()
                await asyncio.sleep(1)

    def close(self):
        self.db.close()
