"""Fire-and-forget telemetry events for the backend dashboard (see docs/telemetry.md).

`emit` never raises and never blocks. It is a no-op until `configure` has been given a configured
SpacetimeDB or has minted an anonymous identity; events from worker threads are handed to the captured main loop.
"""

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

from app.config import Settings

logger = logging.getLogger(__name__)

LABEL_MAX = 120
PAYLOAD_MAX_BYTES = 2048
MAX_IN_FLIGHT = 32
REDUCER = "emit_telemetry"
IDENTITY_FILE = "telemetry_identity.json"
MINT_TIMEOUT_S = 5.0

_client: Any = None
_http: Any = None
_loop: asyncio.AbstractEventLoop | None = None
_inflight = 0
_lock = threading.Lock()
_tasks: set[asyncio.Task] = set()
_startup: asyncio.Task | None = None
_generation = 0


def configure(settings: Settings | None = None, transport=None, client: Any = None, announce: bool = False) -> bool:
    """Enable telemetry. Call from the event loop (the loop is captured). Returns whether it is enabled now.

    Nothing is enabled when `telemetry_enabled` is false. With a configured SPACETIME_TOKEN the client is built
    immediately. Without one, an anonymous identity is minted (or read from the local store) in a background
    task on the running loop; emits stay no-ops until it finishes, and a failure leaves telemetry disabled.
    `transport` is used for every request, including the mint, so tests never reach the network. `announce`
    emits `backend.up` once telemetry is live.
    """
    global _client, _http, _loop, _startup
    reset()
    try:
        _loop = asyncio.get_running_loop()
    except RuntimeError:
        _loop = None
    if client is not None:
        _client = client
        return True
    if settings is None or not settings.telemetry_enabled:
        return False
    if settings.spacetime_configured:
        try:
            _install(settings, transport)
        except Exception as exc:  # noqa: BLE001
            logger.debug("telemetry disabled (%s)", type(exc).__name__)
            _client = _http = None
            return False
        if announce:
            emit_backend_up(settings, "configured")
        return True
    if settings.spacetime_token or _loop is None:  # a real token without a database stays disabled, as before
        return False
    _startup = _loop.create_task(_start_anonymous(settings, transport, announce, _generation))
    return False


def _install(settings: Settings, transport) -> None:
    global _client, _http
    from app.integrations.spacetime import SpacetimeClient, new_http_client

    http = new_http_client(settings, transport)
    _http, _client = http, SpacetimeClient(settings, transport, http)


def identity_path(settings: Settings) -> Path:
    from app.paths import BACKEND_ROOT

    raw = Path(settings.store_dir)
    return (raw if raw.is_absolute() else BACKEND_ROOT / raw) / IDENTITY_FILE


def _read_cached(path: Path, uri: str) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("uri") == uri and data.get("token") and data.get("identity"):
        return data
    return None


async def _mint(uri: str, transport) -> dict:
    import httpx

    async with httpx.AsyncClient(transport=transport, timeout=MINT_TIMEOUT_S) as http:
        response = await http.post(f"{uri}/v1/identity")
    response.raise_for_status()
    data = response.json()
    token, identity = data.get("token"), data.get("identity")
    if not isinstance(token, str) or not token or not isinstance(identity, str) or not identity:
        raise ValueError("identity response without token")
    return {"uri": uri, "identity": identity, "token": token}


async def _start_anonymous(settings: Settings, transport, announce: bool, generation: int) -> None:
    uri = settings.spacetime_uri.rstrip("/")
    database = settings.spacetime_database or settings.telemetry_database
    try:
        path = identity_path(settings)
        cached = _read_cached(path, uri)
        if cached is None:
            cached = await _mint(uri, transport)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(cached), encoding="utf-8")
            except OSError as exc:  # an uncached identity still works for this run
                logger.info("telemetry identity not cached (%s)", type(exc).__name__)
        if generation != _generation:
            return
        _install(settings.model_copy(update={"spacetime_database": database, "spacetime_token": cached["token"]}),
                 transport)
        logger.info("telemetry live: anonymous identity %s... on %s", cached["identity"][:12], database)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - telemetry must never affect the app
        logger.info("telemetry disabled: anonymous identity unavailable (%s)", type(exc).__name__)
        return
    if announce:
        emit_backend_up(settings, "anonymous")


def live_model(settings: Settings) -> str:
    return settings.live_openai_model if settings.live_coach_provider == "openai" else settings.live_coach_model


def _classroom_configured(settings: Settings) -> bool:
    """True when the classroom owner credentials are present (the classroom routes can reach the database)."""
    try:
        from app.classroom.owner import load_owner

        return load_owner(settings) is not None
    except Exception:  # noqa: BLE001 - an unreadable owner file means no classroom
        return False


def emit_backend_up(settings: Settings, identity: str) -> None:
    payload = {
        "provider": settings.live_coach_provider,
        "model": live_model(settings),
        "articulation": bool(settings.articulation_configured),
        "pitchTable": bool(getattr(settings, "pitch_table_enabled", False)),
        "praat": bool(getattr(settings, "word_acoustics_enabled", False)),
        "azure": bool(settings.azure_configured),
        "classroom": _classroom_configured(settings),
        "coordination": settings.live_coordination,
        "telemetryIdentity": identity,
    }
    emit("backend", "db", "backend.up", "backend online", payload)


def enabled() -> bool:
    return _client is not None


def reset() -> None:
    global _client, _http, _loop, _inflight, _startup, _generation
    task = _startup
    _startup = None
    _generation += 1
    if task is not None and not task.done():
        try:
            task.cancel()
        except RuntimeError:  # its loop is already closed
            pass
    _client = _http = _loop = None
    _inflight = 0
    _tasks.clear()


async def aclose() -> None:
    task = _startup
    http = _http
    reset()
    if task is not None:
        try:
            await asyncio.gather(task, return_exceptions=True)  # cancelled by reset; installs nothing now
        except Exception:  # noqa: BLE001
            pass
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


_LINE_FIELDS = ("line", "say", "text", "cue", "message", "summary", "caption", "observation")


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


def parsed_of(response: Any) -> Any:
    """Parsed model output from an Anthropic (`parsed_output`) or OpenAI (`message.parsed` / forced tool call) response."""
    try:
        parsed = getattr(response, "parsed_output", None)
        if parsed is not None:
            return parsed
        message = response.choices[0].message
        parsed = getattr(message, "parsed", None)
        if parsed is not None:
            return parsed
        return message.tool_calls[0].function.parsed_arguments
    except Exception:  # noqa: BLE001
        return None


_USAGE_FIELDS = (
    ("input_tokens", "prompt_tokens", "inputTokens"),
    ("output_tokens", "completion_tokens", "outputTokens"),
)


def claude_call(model: str, purpose: str, call, provider: str = "anthropic"):
    """Run `call()` (a blocking model request) and emit claude.request / .response / .error around it.

    The events keep the "claude" node and names the dashboard reads; `provider` says which SDK answered.
    The response value is returned as is. `.response` carries token usage (either SDK's field names) and
    `line` from the parsed output. Errors are re-raised after a claude.error event. Request content
    (including audio) is never sent.
    """
    import time

    emit("backend", "claude", "claude.request", f"{purpose} request",
         {"model": model, "purpose": purpose, "provider": provider})
    started = time.perf_counter()
    try:
        response = call()
    except Exception as exc:
        ms = round((time.perf_counter() - started) * 1000)
        emit("claude", "backend", "claude.error", f"{purpose} failed",
             {"model": model, "purpose": purpose, "provider": provider, "latencyMs": ms, "error": type(exc).__name__})
        raise
    ms = round((time.perf_counter() - started) * 1000)
    payload: dict[str, Any] = {"model": model, "purpose": purpose, "provider": provider, "latencyMs": ms}
    usage = getattr(response, "usage", None)
    for anthropic_name, openai_name, dst in _USAGE_FIELDS:
        value = getattr(usage, anthropic_name, None)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            value = getattr(usage, openai_name, None)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            payload[dst] = int(value)
    line = line_of(parsed_of(response))
    payload["line"] = line
    emit("claude", "backend", "claude.response", line, payload)
    return response
