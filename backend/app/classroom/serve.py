"""Classroom sign-in service for the deployed teaching console.

This process only mints development identities. The browser then talks to the
classroom database through the same public host.
"""

from fastapi import FastAPI

from app.api.classroom_routes import router as classroom_router
from app.config import get_settings


def create_app() -> FastAPI:
    app = FastAPI()
    app.state.settings = get_settings()
    app.include_router(classroom_router)
    return app


app = create_app()
