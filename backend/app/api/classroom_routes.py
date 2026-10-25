"""Local development entry for classroom identities. Not a production login."""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.classroom.owner import browser_database_uri, dev_classroom_enabled, load_owner
from uuid import uuid4

from app.classroom.provision import (
    ClassroomError,
    commit_verified_summary,
    emit_classroom,
    open_dev_session,
    open_scale_school,
)

router = APIRouter()


def _visible_uri(request: Request, owner_uri: str) -> str:
    settings = request.app.state.settings
    return browser_database_uri(
        owner_uri,
        enabled=bool(settings.classroom_public_from_host),
        host=request.headers.get("host", ""),
        forwarded_proto=request.headers.get("x-forwarded-proto", ""),
        forwarded_host=request.headers.get("x-forwarded-host", ""),
        origin=request.headers.get("origin", ""),
    )


class DevSessionRequest(BaseModel):
    role: str = Field(pattern="^(teacher|learner)$")
    name: str = Field(min_length=1, max_length=24)
    classroom: str = Field(min_length=1, max_length=24)


@router.get("/v1/dev/classroom/status")
def classroom_status(request: Request) -> dict:
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner, request.app.state.settings):
        return {"configured": False, "label": "development identity"}
    return {
        "configured": True,
        "database": owner["database"],
        "uri": _visible_uri(request, owner["uri"]),
        "label": "development identity",
    }


@router.post("/v1/dev/classroom/session")
async def classroom_session(body: DevSessionRequest, request: Request) -> dict:
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner, request.app.state.settings):
        raise HTTPException(404, "development classroom identity is off")
    try:
        session = await open_dev_session(request.app.state.settings, body.role, body.name, body.classroom)
        session["uri"] = _visible_uri(request, session["uri"])
        emit_classroom("classroom.session", f"{body.role} session open", {"role": body.role})
        return session
    except ClassroomError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/v1/dev/classroom/scale")
async def classroom_scale(request: Request) -> dict:
    """Mint the synthetic scale rooms on the local classroom database."""
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner, request.app.state.settings):
        raise HTTPException(404, "development classroom identity is off")
    try:
        school = await open_scale_school(request.app.state.settings)
    except ClassroomError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    uri = _visible_uri(request, school["uri"])
    for room in school["rooms"]:
        room["teacher"]["uri"] = uri
        room["learner"]["uri"] = uri
    school["uri"] = uri
    emit_classroom("classroom.scale", f"scale school open ({len(school['rooms'])} rooms)", {"rooms": len(school["rooms"])})
    return school


class SyntheticSeed(BaseModel):
    profileId: str = Field(min_length=1, max_length=64)
    finding: str = Field(default="mouth_more_open", max_length=64)


@router.post("/v1/dev/classroom/synthetic")
async def seed_synthetic(body: SyntheticSeed, request: Request) -> dict:
    """Insert labeled synthetic findings. They never count as verified progress."""
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner, request.app.state.settings):
        raise HTTPException(404, "development classroom identity is off")
    wrote = 0
    for _ in range(3):
        ok = await commit_verified_summary(
            request.app.state.settings,
            [
                body.profileId,
                str(uuid4()),
                "head",
                True,
                body.finding,
                "synthetic",
                "synthetic-fixture",
                "synthetic",
                body.finding,
                json.dumps({"note": "synthetic fixture", "f0Hz": None, "f1Hz": None, "f2Hz": None}),
                True,
            ],
        )
        if ok:
            wrote += 1
    return {"wrote": wrote, "label": "synthetic fixture"}
