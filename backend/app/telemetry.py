"""Fire-and-forget telemetry events for the backend dashboard (see docs/telemetry.md).

`emit` never raises and never blocks. It is a no-op until `configure` has been given a configured
SpacetimeDB; events from worker threads are handed to the captured main loop.
"""

import asyncio
import json
import logging
import threading
from typing import Any

from app.config import Settings

logger = logging.getLogger(__name__)

LABEL_MAX = 120
PAYLOAD_MAX_BYTES = 2048
MAX_IN_FLIGHT = 32
REDUCER = "emit_telemetry"

_client: Any = None
_http: Any = None
_loop: asyncio.AbstractEventLoop | None = None
_inflight = 0
_lock = threading.Lock()
_tasks: set[asyncio.Task] = set()


def configure(settings: Settings | None = None, transport=None, client: Any = None) -> bool:
    """Enable telemetry. Call from the event loop (the loop is captured). Returns whether it is enabled."""
    global _client, _http, _loop
    reset()
    try:
        _loop = asyncio.get_running_loop()
    except RuntimeError:
        _loop = None
    if client is not None:
        _client = client
        return True
    if settings is None or not settings.spacetime_configured:
        return False
    try:
        from app.integrations.spacetime import SpacetimeClient, new_http_client

        _http = new_http_client(settings, transport)
        _client = SpacetimeClient(settings, transport, _http)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.debug("telemetry disabled (%s)", type(exc).__name__)
        _client = _http = None
        return False


def reset() -> None:
    global _client, _http, _loop, _inflight
    _client = _http = _loop = None
    _inflight = 0
    _tasks.clear()


async def aclose() -> None:
    http = _http
    reset()
    if http is not None:
        try:
            await http.aclose()
        except Exception:  # noqa: BLE001
            pass


def _clip(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else str(value)
    return text[:limit]


def _payload_json(payload: dict | None) -> str:
    data = dict(payload or {})
    text = json.dumps(data, default=str, separators=(",", ":"))
    if len(text.encode("utf-8")) > PAYLOAD_MAX_BYTES and "line" in data:
        data.pop("line")
        text = json.dumps(data, default=str, separators=(",", ":"))
    if len(text.encode("utf-8")) > PAYLOAD_MAX_BYTES:
        text = "{}"
    return text


async def _send(args: list[str]) -> None:
    global _inflight
    try:
        client = _client
        if client is not None:
            await client.call(REDUCER, args)
    except Exception as exc:  # noqa: BLE001
        logger.debug("telemetry emit failed (%s)", type(exc).__name__)
    finally:
        with _lock:
            _inflight = max(0, _inflight - 1)


def _spawn(args: list[str]) -> None:
    global _inflight
    try:
        task = asyncio.get_running_loop().create_task(_send(args))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _inflight = max(0, _inflight - 1)
        logger.debug("telemetry schedule failed (%s)", type(exc).__name__)


def emit(source: str, target: str, kind: str, label: str, payload: dict | None = None) -> None:
    global _inflight
    try:
        if _client is None:
            return
        args = [source, target, kind, _clip(label, LABEL_MAX), _payload_json(payload)]
        with _lock:
            if _inflight >= MAX_IN_FLIGHT:
                return
            _inflight += 1
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None:
            _spawn(args)
        elif _loop is not None and not _loop.is_closed():
            _loop.call_soon_threadsafe(_spawn, args)
        else:
            with _lock:
                _inflight = max(0, _inflight - 1)
    except Exception as exc:  # noqa: BLE001
        logger.debug("telemetry emit dropped (%s)", type(exc).__name__)


def short(text: Any, limit: int = LABEL_MAX) -> str:
    return _clip(text, limit)


_LINE_FIELDS = ("line", "text", "cue", "message", "summary", "caption", "observation")


def line_of(parsed: Any) -> str:
    """Short dashboard string for a parsed model output: a text-like field, else the class name."""
    try:
        for name in _LINE_FIELDS:
            value = getattr(parsed, name, None)
            if isinstance(value, str) and value.strip():
                return value.strip()[:LABEL_MAX]
        return type(parsed).__name__
    except Exception:  # noqa: BLE001
        return "output"


def claude_call(model: str, purpose: str, call):
    """Run `call()` (a blocking Claude request) and emit claude.request / .response / .error around it.

    The response value is returned as is. `.response` carries token usage when the SDK object has it and
    `line` from the parsed output. Errors are re-raised after a claude.error event.
    """
    import time

    emit("backend", "claude", "claude.request", f"{purpose} request", {"model": model, "purpose": purpose})
    started = time.perf_counter()
    try:
        response = call()
    except Exception as exc:
        ms = round((time.perf_counter() - started) * 1000)
        emit("claude", "backend", "claude.error", f"{purpose} failed",
             {"model": model, "purpose": purpose, "latencyMs": ms, "error": type(exc).__name__})
        raise
    ms = round((time.perf_counter() - started) * 1000)
    payload: dict[str, Any] = {"model": model, "purpose": purpose, "latencyMs": ms}
    usage = getattr(response, "usage", None)
    for src, dst in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens")):
        value = getattr(usage, src, None)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            payload[dst] = int(value)
    line = line_of(getattr(response, "parsed_output", None))
    payload["line"] = line
    emit("claude", "backend", "claude.response", line, payload)
    return response
