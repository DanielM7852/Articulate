"""Local development entry for classroom identities. Not a production login."""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.classroom.owner import dev_classroom_enabled, load_owner
from uuid import uuid4

from app.classroom.provision import ClassroomError, commit_verified_summary, open_dev_session

router = APIRouter()


class DevSessionRequest(BaseModel):
    role: str = Field(pattern="^(teacher|learner)$")
    name: str = Field(min_length=1, max_length=24)
    classroom: str = Field(min_length=1, max_length=24)


@router.get("/v1/dev/classroom/status")
def classroom_status(request: Request) -> dict:
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner):
        return {"configured": False, "label": "development identity"}
    return {
        "configured": True,
        "database": owner["database"],
        "uri": owner["uri"],
        "label": "development identity",
    }


@router.post("/v1/dev/classroom/session")
async def classroom_session(body: DevSessionRequest, request: Request) -> dict:
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner):
        raise HTTPException(404, "development classroom identity is local only")
    try:
        return await open_dev_session(request.app.state.settings, body.role, body.name, body.classroom)
    except ClassroomError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


class SyntheticSeed(BaseModel):
    profileId: str = Field(min_length=1, max_length=64)
    finding: str = Field(default="mouth_more_open", max_length=64)


@router.post("/v1/dev/classroom/synthetic")
async def seed_synthetic(body: SyntheticSeed, request: Request) -> dict:
    """Insert labeled synthetic findings. They never count as verified progress."""
    owner = load_owner(request.app.state.settings)
    if owner is None or not dev_classroom_enabled(owner):
        raise HTTPException(404, "development classroom identity is local only")
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
