"""FastAPI entrypoint.

Run from the backend directory:

    uvicorn app.main:app --reload
"""

import logging
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.classroom_routes import router as classroom_router
from app.api.live_routes import health_router, router as live_router
from app.api.routes import router
from app.realtime.routes import router as realtime_router
from app.config import Settings, get_settings
from app.live.runtime import get_runtime
from app.live.identity import read_identity
from app.runtime import build_orchestrator
from app import telemetry


def _ensure_live_logging() -> None:
    """Make app.live and app.telemetry INFO lines (timings, warm-up, identity) visible under uvicorn,
    which leaves app loggers silent."""
    for name in ("app.live", "app.telemetry"):
        log = logging.getLogger(name)
        if log.level == logging.NOTSET or log.level > logging.INFO:
            log.setLevel(logging.INFO)
        if not log.handlers and not logging.getLogger().handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
            log.addHandler(handler)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _ensure_live_logging()
    runtime = get_runtime(app)
    # Tests that inject a fake SpacetimeDB transport must not see extra telemetry traffic or reach the network.
    fake = getattr(app.state, "live_spacetime_transport", None)
    telemetry_transport = getattr(app.state, "telemetry_transport", None)
    if fake is None or telemetry_transport is not None:
        telemetry.configure(app.state.settings, telemetry_transport, announce=True)
    try:
        # Shared APIs only coordinate; provider clients belong to the independently scaled workers.
        runtime.http(getattr(app.state, "live_spacetime_transport", None))
        if app.state.settings.live_coordination == "local":
            runtime.anthropic()
            runtime.start_warm_up()
    except Exception as exc:  # noqa: BLE001 - warm-up must never fail startup
        logging.getLogger("app.live").info("live warm-up skipped (%s)", type(exc).__name__)
    try:
        yield
    finally:
        recap_service = getattr(app.state, "recap_service", None)
        if recap_service is not None:
            await recap_service.aclose()
        await telemetry.aclose()
        await runtime.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    active = settings or get_settings()
    app = FastAPI(
        title="Articulate audio backend",
        version="0.1.0",
        lifespan=_lifespan,
        summary="Pitch comparison and one grounded practice cue for a short intonation phrase.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=active.cors_origin_list,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    app.state.settings = active
    app.state.orchestrator = build_orchestrator(active)
    if active.live_coordination == "spacetime":
        @app.middleware("http")
        async def shared_routes_only(request, call_next):
            # The legacy comparison/session-file APIs have no shared ownership model.
            if request.url.path.startswith(("/v1/comparisons", "/v1/sessions", "/v1/coach", "/v1/attempts")):
                return JSONResponse({"detail": "use_shared_live_api"}, status_code=404)
            if request.url.path.startswith("/v1/speech") and read_identity(request) is None:
                return JSONResponse({"detail": "identity_required"}, status_code=401)
            return await call_next(request)
    frontend = _frontend_dir(active)
    if frontend is not None and (frontend / "index.html").is_file():
        # Registered ahead of the API router so the built app, not the listening-check page, owns "/".
        app.add_api_route("/", _frontend_index(frontend), methods=["GET", "HEAD"], include_in_schema=False)
    app.include_router(router)
    app.include_router(classroom_router)
    app.include_router(live_router)
    app.include_router(health_router)
    app.include_router(realtime_router)
    if frontend is not None:
        _mount_frontend(app, frontend)
    return app


# Paths the frontend fallback never answers, so API 404s stay JSON and are never shadowed by index.html.
_API_PREFIXES = ("/v1/", "/health", "/docs", "/redoc", "/openapi.json")


def _frontend_dir(settings: Settings) -> Path | None:
    if not settings.static_dir.strip():
        return None
    directory = Path(settings.static_dir).resolve()
    return directory if directory.is_dir() else None


def _frontend_index(directory: Path):
    def index() -> FileResponse:
        return FileResponse(directory / "index.html", headers={"Cache-Control": "no-cache"})

    return index


def _mount_frontend(app: FastAPI, directory: Path) -> None:
    """Serve the built frontend only where routing found nothing.

    Hooked on 404 instead of a catch-all route or mount, so every API route keeps its own
    405/404 behavior. GET/HEAD for an existing file returns it; any other path without a file
    extension falls back to index.html (the app uses a HashRouter, so this is only a safety net).
    """
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("text/javascript", ".mjs")
    index = directory / "index.html"

    async def not_found(request: Request, exc: StarletteHTTPException):
        path = request.url.path
        if request.method not in ("GET", "HEAD") or path == "/v1" or path.startswith(_API_PREFIXES):
            return await http_exception_handler(request, exc)
        try:
            candidate = (directory / path.lstrip("/")).resolve()
            if candidate.is_relative_to(directory) and candidate.is_file():
                return FileResponse(candidate)
        except (OSError, ValueError):
            return await http_exception_handler(request, exc)
        if "." not in path.rsplit("/", 1)[-1] and index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return await http_exception_handler(request, exc)

    app.add_exception_handler(404, not_found)


app = create_app()
