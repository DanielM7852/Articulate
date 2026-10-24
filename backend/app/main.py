"""FastAPI entrypoint.

Run from the backend directory:

    uvicorn app.main:app --reload
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.live_routes import health_router, router as live_router
from app.api.routes import router
from app.config import Settings, get_settings
from app.live.runtime import get_runtime
from app.live.identity import read_identity
from app.runtime import build_orchestrator


def _ensure_live_logging() -> None:
    """Make app.live INFO lines (timings, warm-up) visible under uvicorn, which leaves app loggers silent."""
    log = logging.getLogger("app.live")
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
    app.include_router(router)
    app.include_router(live_router)
    app.include_router(health_router)
    return app


app = create_app()
