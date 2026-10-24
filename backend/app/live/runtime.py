"""Long-lived shared clients for live coaching (one Anthropic client, one SpacetimeDB httpx client per app).

Created in the app lifespan; created lazily on first use when the lifespan did not run (for example tests).
Test hooks on app.state (live_client, live_spacetime_transport, live_history) take precedence.
"""

import asyncio
import contextlib
import logging
import time
from typing import Any

import httpx

from app.config import Settings
from app.integrations.articulation import ArticulationClient
from app.integrations.spacetime import SpacetimeClient, new_http_client
from app.live import llm
from app.live.history import LearnerHistory, LocalHistory, SpacetimeHistory

logger = logging.getLogger(__name__)

SHARED_MODEL_TIMEOUT_S = 30.0
INSIGHT_MAX = 500


class LiveRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._anthropic: Any = None
        self._http: httpx.AsyncClient | None = None
        self._http_transport: Any = None
        self._history: LearnerHistory | None = None
        self.anthropic_created = 0
        self.http_created = 0
        self._tasks: set[asyncio.Task] = set()
        self._artic_http: httpx.AsyncClient | None = None
        self._artic_transport: Any = None
        self._artic_lock: asyncio.Lock | None = None
        self._artic_waiting = 0
        self._artic_drop_logged = False
        self._insights: dict[str, dict[str, Any]] = {}
        self._features: dict[tuple[str, str], dict] = {}
        self.clock = time.monotonic

    def anthropic(self) -> Any:
        if self._anthropic is None and self.settings.anthropic_configured:
            timeout = max(self.settings.live_coach_timeout_s, SHARED_MODEL_TIMEOUT_S)
            self._anthropic = llm.build_client(self.settings, timeout)
            self.anthropic_created += 1
        return self._anthropic

    def http(self, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient | None:
        if not self.settings.spacetime_configured:
            return None
        if transport is None:
            transport = self._http_transport  # None means "whatever the shared client already uses"
        if self._http is not None and transport is not self._http_transport:
            self._http = None  # a different injected transport (tests only); the old client is dropped
            self._history = None
        if self._http is None:
            self._http = new_http_client(self.settings, transport)
            self._http_transport = transport
            self.http_created += 1
        return self._http

    def spacetime(self, transport: httpx.AsyncBaseTransport | None = None) -> SpacetimeClient | None:
        http = self.http(transport)
        return SpacetimeClient(self.settings, transport, http) if http is not None else None

    def history(self, transport: httpx.AsyncBaseTransport | None = None) -> LearnerHistory:
        client = self.spacetime(transport)
        if self._history is None:
            self._history = SpacetimeHistory(client) if client is not None else LocalHistory(self.settings)
        return self._history

    def articulation(self, transport: httpx.AsyncBaseTransport | None = None) -> ArticulationClient | None:
        """Client for the local collector on one shared AsyncClient; None when ARTICULATION_URL is unset."""
        if not self.settings.articulation_configured:
            return None
        if transport is None:
            transport = self._artic_transport
        if self._artic_http is not None and transport is not self._artic_transport:
            self._artic_http = None  # different injected transport (tests only)
        if self._artic_http is None:
            self._artic_http = httpx.AsyncClient(transport=transport, timeout=self.settings.articulation_timeout_s)
            self._artic_transport = transport
        return ArticulationClient(self.settings, transport, self._artic_http)

    def reserve_articulation(self) -> bool:
        """Claim a place (one in flight plus at most articulation_max_queue waiting); False when full."""
        if self._artic_waiting >= max(0, self.settings.articulation_max_queue) + 1:
            if not self._artic_drop_logged:
                self._artic_drop_logged = True
                logger.warning("articulation queue full; dropping jobs")
            return False
        self._artic_waiting += 1
        return True

    @contextlib.asynccontextmanager
    async def articulation_slot(self, reserved: bool = False):
        """`async with runtime.articulation_slot(reserved=True) as ok:` runs one analysis at a time.

        ok is False (job should be skipped) when the queue was full; pass reserved=True after a successful
        reserve_articulation(). The place is released on exit.
        """
        if not reserved and not self.reserve_articulation():
            yield False
            return
        if self._artic_lock is None:
            self._artic_lock = asyncio.Lock()
        try:
            async with self._artic_lock:
                yield True
        finally:
            self._artic_waiting -= 1

    # ---- insight registry (in memory; entries expire after insight_ttl_s, at most INSIGHT_MAX) ----

    def _purge_insights(self) -> None:
        now = self.clock()
        ttl = self.settings.insight_ttl_s
        for key in [k for k, v in self._insights.items() if now - v["created"] > ttl]:
            del self._insights[key]

    def set_insight(self, attempt_id: str, profile_id: str, sound: str, status: str,
                    say: str | None = None, source: str | None = None) -> None:
        self._purge_insights()
        old = self._insights.get(attempt_id)
        created = old["created"] if old and old["profileId"] == profile_id else self.clock()
        self._insights[attempt_id] = {
            "profileId": profile_id, "sound": sound, "status": status, "say": say, "source": source,
            "created": created,
        }
        while len(self._insights) > INSIGHT_MAX:
            del self._insights[min(self._insights, key=lambda k: self._insights[k]["created"])]

    def get_insight(self, attempt_id: str, profile_id: str | None = None) -> dict[str, Any] | None:
        """The live entry, or None when absent, expired, or owned by another profile."""
        self._purge_insights()
        entry = self._insights.get(attempt_id)
        if entry is None or (profile_id is not None and entry["profileId"] != profile_id):
            return None
        return entry

    def mark_insight_delivered(self, attempt_id: str) -> None:
        entry = self._insights.get(attempt_id)
        if entry is not None:
            entry["status"] = "delivered"

    def remember_features(self, profile_id: str, attempt_id: str, features: dict) -> None:
        """Features of attempts analysed by this process, for in-memory annotation when persistence fails."""
        self._features.pop((profile_id, attempt_id), None)
        self._features[(profile_id, attempt_id)] = features
        while len(self._features) > 200:
            del self._features[next(iter(self._features))]

    def recalled_features(self, profile_id: str, attempt_id: str) -> dict | None:
        return self._features.get((profile_id, attempt_id))

    async def warm_up(self) -> None:
        """Best effort connection warm-up; never raises."""
        await asyncio.gather(self._warm_model(), self._warm_spacetime(), return_exceptions=True)

    async def _warm_model(self) -> None:
        try:
            client = await asyncio.to_thread(self.anthropic)
            if client is None or not hasattr(client, "models"):
                return
            await asyncio.to_thread(client.models.retrieve, self.settings.anthropic_model)
            logger.info("live warm-up: model API reachable")
        except Exception as exc:  # noqa: BLE001
            logger.info("live warm-up: model API failed (%s)", type(exc).__name__)

    async def _warm_spacetime(self) -> None:
        try:
            client = self.spacetime()
            if client is None:
                return
            await client.sql("SELECT * FROM learner_note WHERE profile_id = '__warmup__'")
            logger.info("live warm-up: spacetimedb reachable")
        except Exception as exc:  # noqa: BLE001
            logger.info("live warm-up: spacetimedb failed (%s)", type(exc).__name__)

    def start_warm_up(self) -> None:
        task = asyncio.create_task(self.warm_up())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def aclose(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._http is not None:
            try:
                await self._http.aclose()
            except Exception:  # noqa: BLE001
                pass
        if self._artic_http is not None:
            try:
                await self._artic_http.aclose()
            except Exception:  # noqa: BLE001
                pass
        close = getattr(self._anthropic, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass


def get_runtime(app) -> LiveRuntime:
    runtime = getattr(app.state, "live_runtime", None)
    if runtime is None:
        runtime = LiveRuntime(app.state.settings)
        app.state.live_runtime = runtime
    return runtime
