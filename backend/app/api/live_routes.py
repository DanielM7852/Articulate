"""Local live coaching, or authenticated durable jobs when shared coordination is enabled."""

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.live.coordination import Coordination
from app.live.identity import authorize_profile, issue_identity, read_identity

from app.live.notes import update_notes
from app.live.orchestrator import LiveDeps, coach_attempt
from app.live.runtime import get_runtime
from app.live.schemas import (
    LearnerNotes,
    LiveCoachRequest,
    LiveCoachResponse,
    NotesRequest,
    SessionStartRequest,
    SessionTurn,
    SessionTurnRequest,
)
from app.live.session import get_store, start_session, take_turn

router = APIRouter(prefix="/v1/live")
health_router = APIRouter(prefix="/health")


@health_router.get("/live")
async def liveness() -> dict:
    return {"status": "live"}


@health_router.get("/ready")
async def readiness(request: Request) -> dict:
    if request.app.state.settings.live_coordination == "spacetime":
        try:
            client = _coordination(request).client
            # Fail readiness if the module is unpublished or the private tables are inaccessible.
            await client.sql("SELECT id FROM live_job LIMIT 1")
            await client.sql("SELECT id FROM live_session LIMIT 1")
        except Exception as exc:  # noqa: BLE001 - no provider details in a public health response
            raise HTTPException(503, "coordination_unavailable") from exc
    return {"status": "ready", "coordination": request.app.state.settings.live_coordination}


def _coordination(request: Request) -> Coordination:
    client = get_runtime(request.app).spacetime(getattr(request.app.state, "live_spacetime_transport", None))
    if client is None:
        raise HTTPException(503, "coordination_unavailable")
    return Coordination(request.app.state.settings, client)


def _shared(request: Request, profile_id: str) -> bool:
    authorize_profile(request, profile_id)
    return request.app.state.settings.live_coordination == "spacetime"


@router.get("/identity")
async def live_identity(request: Request, response: Response) -> dict:
    return issue_identity(request, response)


@router.get("/jobs/{job_id}")
async def live_job(job_id: str, request: Request) -> JSONResponse:
    if request.app.state.settings.live_coordination != "spacetime":
        raise HTTPException(404, "shared_coordination_disabled")
    profile = read_identity(request)
    if profile is None:
        raise HTTPException(401, "identity_required")
    return await _coordination(request).response(job_id, profile)


def _deps(request: Request) -> LiveDeps:
    state = request.app.state
    runtime = get_runtime(request.app)
    transport = getattr(state, "live_spacetime_transport", None)
    return LiveDeps(
        settings=state.settings,
        anthropic_client=getattr(state, "live_client", None) or runtime.anthropic(),
        transport=transport,
        history=getattr(state, "live_history", None) or runtime.history(transport),
        spacetime=runtime.spacetime(transport),
    )


ACCEPTED = {202: {"description": "Durable job accepted; poll the returned statusUrl for the typed result."}}


@router.post("/coach", response_model=LiveCoachResponse, responses=ACCEPTED)
async def live_coach(body: LiveCoachRequest, request: Request, background: BackgroundTasks) -> LiveCoachResponse:
    if _shared(request, body.profileId):
        return await _coordination(request).submit("attempt.coach", body.model_dump())
    return await coach_attempt(_deps(request), body, background.add_task)


@router.post("/notes", response_model=LearnerNotes, responses=ACCEPTED)
async def live_notes(body: NotesRequest, request: Request) -> LearnerNotes:
    if _shared(request, body.profileId):
        return await _coordination(request).submit("notes.update", body.model_dump(), request.headers.get("Idempotency-Key"))
    return await update_notes(_deps(request), body.profileId)


@router.post("/session/start", response_model=SessionTurn, responses=ACCEPTED)
async def live_session_start(body: SessionStartRequest, request: Request) -> SessionTurn:
    if _shared(request, body.profileId):
        return await _coordination(request).submit("session.start", body.model_dump(), request.headers.get("Idempotency-Key"))
    deps = _deps(request)
    return await start_session(deps, get_store(deps, request.app), body)


@router.post("/session/turn", response_model=SessionTurn, responses=ACCEPTED)
async def live_session_turn(body: SessionTurnRequest, request: Request) -> SessionTurn:
    if _shared(request, body.profileId):
        return await _coordination(request).submit("session.turn", body.model_dump(), request.headers.get("Idempotency-Key"))
    deps = _deps(request)
    return await take_turn(deps, get_store(deps, request.app), body)
