"""FastAPI entrypoint.

Run from the backend directory:

    uvicorn app.main:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import Settings, get_settings
from app.runtime import build_orchestrator


def create_app(settings: Settings | None = None) -> FastAPI:
    active = settings or get_settings()
    app = FastAPI(
        title="Articulate audio backend",
        version="0.1.0",
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
    app.include_router(router)
    return app


app = create_app()
