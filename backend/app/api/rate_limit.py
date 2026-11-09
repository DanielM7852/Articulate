"""Abuse guard for the public demo: per-IP and global limits on the endpoints that spend provider money.

Off unless RATE_LIMITS_ENABLED=true (see create_app), so local dev and tests are unaffected. Limits are held in
memory, so they are per process; the demo runs one uvicorn process behind Caddy with --proxy-headers, which makes
scope["client"] the real client IP. A multi-process deploy would need a shared store instead.

Over a limit, HTTP routes answer 429 {"detail": "rate_limited", "scope", "retryAfterS"} with a Retry-After header
and the route is never called. /phones/ws is capped by concurrent connections instead of a rate.
GET routes, /health and /phones/health are never limited.
"""

import math
import re
import time
from collections import defaultdict, deque
from collections.abc import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import Settings

WINDOW_S = 3600.0
PHONES_WS_PATH = "/phones/ws"

_REALTIME = "realtime"
_COACH = "coach"

# (method, path) -> budget group. Every route here calls a paid provider (OpenAI, Anthropic, Azure, Cartesia, GPU).
_ROUTES: dict[tuple[str, str], str] = {("POST", "/v1/realtime/session"): _REALTIME}
_ROUTES.update(
    {("POST", path): _COACH for path in (
        "/v1/coach", "/v1/lesson-plan", "/v1/speech", "/v1/speech/token", "/v1/word-match",
        "/v1/live/coach", "/v1/live/word/ask", "/v1/live/consonant", "/v1/live/notes",
        "/v1/live/session/start", "/v1/live/session/turn", "/v1/live/articulation",
        "/v1/live/recap", "/v1/live/phrases", "/v1/live/phrases/assess",
    )}
)
_RECAP_EMAIL = re.compile(r"/v1/live/recap/[^/]+/email")


class SlidingWindow:
    """Counts hits per key inside the last `window_s` seconds. The clock is injectable for tests."""

    def __init__(self, window_s: float = WINDOW_S, clock: Callable[[], float] = time.monotonic) -> None:
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def _live(self, key: str) -> deque[float]:
        hits = self._hits.get(key)
        if hits is None:
            return deque()
        cutoff = self._clock() - self.window_s
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if not hits:
            del self._hits[key]  # idle IPs do not accumulate
        return hits

    def retry_after(self, key: str, limit: int) -> int | None:
        """Seconds until a hit is allowed, or None if one is allowed now. Does not record."""
        hits = self._live(key)
        if len(hits) < limit:
            return None
        return max(1, math.ceil(hits[0] + self.window_s - self._clock()))

    def record(self, key: str) -> None:
        self._hits.setdefault(key, deque()).append(self._clock())


class RateLimitMiddleware:
    """Pure ASGI middleware; the checks and counters are synchronous, so they are atomic on one event loop."""

    def __init__(self, app: ASGIApp, settings: Settings, clock: Callable[[], float] = time.monotonic) -> None:
        self.app = app
        self._windows = SlidingWindow(clock=clock)
        # group -> (per-IP limit, global limit) per hour
        self._limits = {
            _REALTIME: (settings.rate_limit_realtime_per_ip_hour, settings.rate_limit_realtime_global_hour),
            _COACH: (settings.rate_limit_coach_per_ip_hour, settings.rate_limit_coach_global_hour),
        }
        self._ws_per_ip = settings.rate_limit_phones_ws_per_ip
        self._ws_global = settings.rate_limit_phones_ws_global
        self._ws_open: dict[str, int] = defaultdict(int)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            group = self._group(scope["method"], scope["path"])
            blocked = self._check(group, _client_ip(scope)) if group is not None else None
            if blocked is not None:
                scope_name, retry_after = blocked
                response = JSONResponse(
                    {"detail": "rate_limited", "scope": scope_name, "retryAfterS": retry_after},
                    status_code=429,
                    headers={"Retry-After": str(retry_after)},
                )
                await response(scope, receive, send)
                return
        elif scope["type"] == "websocket" and scope["path"] == PHONES_WS_PATH:
            await self._phones_ws(scope, receive, send)
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _group(method: str, path: str) -> str | None:
        if method != "POST":
            return None
        path = path.rstrip("/")
        return _ROUTES.get((method, path)) or (_COACH if _RECAP_EMAIL.fullmatch(path) else None)

    def _check(self, group: str, ip: str) -> tuple[str, int] | None:
        """Record the hit and return None, or return (scope, retryAfterS) without recording anything."""
        per_ip, global_limit = self._limits[group]
        ip_key, global_key = f"{group}:ip:{ip}", f"{group}:global"
        wait = self._windows.retry_after(ip_key, per_ip)
        if wait is not None:
            return "per_ip", wait
        wait = self._windows.retry_after(global_key, global_limit)
        if wait is not None:
            return "global", wait
        self._windows.record(ip_key)
        self._windows.record(global_key)
        return None

    async def _phones_ws(self, scope: Scope, receive: Receive, send: Send) -> None:
        ip = _client_ip(scope)
        if self._ws_open[ip] >= self._ws_per_ip or sum(self._ws_open.values()) >= self._ws_global:
            # Accept first so the browser sees close code 1008, not a 403 handshake failure (1006); same as the
            # origin check in phones_proxy.
            await receive()  # websocket.connect
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.send", "text": '{"type": "error", "message": "too many connections"}'})
            await send({"type": "websocket.close", "code": 1008})
            return
        self._ws_open[ip] += 1
        try:
            await self.app(scope, receive, send)
        finally:  # also reached on abnormal disconnects and handler errors
            self._ws_open[ip] -= 1
            if self._ws_open[ip] <= 0:
                del self._ws_open[ip]


def _client_ip(scope: Scope) -> str:
    client = scope.get("client")
    return client[0] if client else "unknown"
