"""Authenticated HTTP calls into the SpacetimeDB module.

There is no Python client SDK for SpacetimeDB 2.13. Reducers and procedures are
invoked with POST /v1/database/{name}/call/{name} and a JSON array of arguments,
which is the documented HTTP shape. The worker token is the identity that
successfully called become_worker. It never goes to the browser.
"""

import json
import time
from dataclasses import dataclass

import httpx
from pydantic import BaseModel, Field

from app.config import Settings
from app.schemas import ComparisonResult


class FeatureBatch(BaseModel):
    """Compact pitch frames from the browser. Null F0 means unavailable, not 0 Hz."""

    session_id: str = Field(min_length=1, max_length=80)
    attempt_id: str = Field(min_length=1, max_length=80)
    capture_id: str = Field(min_length=1, max_length=80)
    producer_id: str = Field(min_length=1, max_length=80)
    sequence: int = Field(ge=0, le=1_000_000)
    first_sample_offset: int = Field(ge=0)
    sample_rate_hz: int = Field(ge=8_000, le=48_000)
    hop_length: int = Field(ge=1, le=4096)
    frame_length: int = Field(ge=1, le=8192)
    extraction_version: str = Field(min_length=1, max_length=40)
    frames: list[dict] = Field(max_length=64)


@dataclass
class CallResult:
    ok: bool
    status_code: int
    body: str
    elapsed_ms: float


class SpacetimeClient:
    def __init__(self, base_url: str, database: str, token: str | None, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.database = database
        self.token = token
        self.timeout_s = timeout_s

    @classmethod
    def from_settings(cls, settings: Settings) -> "SpacetimeClient":
        return cls(
            settings.spacetimedb_url,
            settings.spacetimedb_database,
            settings.spacetimedb_token,
            timeout_s=min(settings.audio_timeout_s, 10.0),
        )

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.database and self.token)

    def call(self, reducer: str, args: list, *, token: str | None = None) -> CallResult:
        auth = token or self.token
        if not auth or not self.database:
            return CallResult(False, 0, "spacetimedb_not_configured", 0.0)
        url = f"{self.base_url}/v1/database/{self.database}/call/{reducer}"
        started = time.perf_counter()
        try:
            response = httpx.post(
                url,
                headers={"Authorization": f"Bearer {auth}", "Content-Type": "application/json"},
                json=args,
                timeout=self.timeout_s,
            )
        except httpx.HTTPError:
            elapsed = (time.perf_counter() - started) * 1000.0
            return CallResult(False, 0, "spacetimedb_unreachable", elapsed)
        elapsed = (time.perf_counter() - started) * 1000.0
        return CallResult(response.status_code < 400, response.status_code, response.text[:500], elapsed)

    def commit_comparison(self, result: ComparisonResult, *, exercise: str, learner_token: str | None) -> CallResult:
        """Open the learner attempt when a token is present, then commit the verified result."""

        started = time.perf_counter()
        if learner_token:
            self.call(
                "open_session",
                [result.session_id, exercise, "backend-upload"],
                token=learner_token,
            )
            begun = self.call(
                "begin_attempt",
                [result.session_id, result.attempt_id, result.reference_id, "backend-upload"],
                token=learner_token,
            )
            if not begun.ok and "duplicate_attempt" not in begun.body:
                begun.elapsed_ms = (time.perf_counter() - started) * 1000.0
                return begun
        evidence = [
            {"evidence_id": item.evidence_id, "metric": item.metric, "value": item.value}
            for item in result.evidence[:12]
        ]
        metrics = result.metrics.model_dump() if result.metrics else {}
        delivery_id = f"{result.attempt_id}:{result.status}:{result.finding or 'none'}"
        committed = self.call(
            "commit_verified",
            [
                result.attempt_id,
                exercise,
                result.analysis_version,
                result.status,
                result.finding or "",
                result.feedback.spoken_text[:600],
                result.feedback.cue_id or "",
                result.feedback.next_action,
                _compact(metrics),
                _compact(evidence),
                result.fixture_mode,
                1,
                delivery_id,
            ],
        )
        committed.elapsed_ms = (time.perf_counter() - started) * 1000.0
        return committed

    def append_batch(self, batch: FeatureBatch, *, learner_token: str) -> CallResult:
        payload = json.dumps(
            [
                {
                    "time_s": frame.get("time_s"),
                    "f0_hz": frame.get("f0_hz"),
                    "voiced": bool(frame.get("voiced")),
                    "valid": bool(frame.get("valid", frame.get("usable", False))),
                    "quality": frame.get("quality"),
                }
                for frame in batch.frames
            ],
            separators=(",", ":"),
            default=str,
        )
        if len(payload) > 8000:
            return CallResult(False, 413, "payload_too_large", 0.0)
        return self.call(
            "append_feature_chunk",
            [
                batch.attempt_id,
                batch.sequence,
                batch.producer_id,
                batch.capture_id,
                batch.first_sample_offset,
                batch.sample_rate_hz,
                batch.hop_length,
                batch.frame_length,
                batch.extraction_version,
                "client_provisional",
                payload,
            ],
            token=learner_token,
        )


def _compact(value: object) -> str:
    text = json.dumps(value, separators=(",", ":"), default=str)
    return text[:8000]
