"""POST /v1/live/coach, /notes, /articulation, /session/start and /session/turn.

Provider failures never surface as 500s.
"""

import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse

from app.live.articulation import extract_features
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
    SoundId,
    valid_attempt_id,
    valid_profile_id,
)
from app.live.session import get_store, start_session, take_turn

router = APIRouter(prefix="/v1/live")
logger = logging.getLogger(__name__)

ARTICULATION_MAX_BYTES = 1 << 20
ARTICULATION_MIN_BYTES = 44
_WAV_TYPES = ("audio/wav", "audio/x-wav")


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


@router.post("/coach", response_model=LiveCoachResponse)
async def live_coach(body: LiveCoachRequest, request: Request, background: BackgroundTasks) -> LiveCoachResponse:
    return await coach_attempt(_deps(request), body, background.add_task)


@router.post("/notes", response_model=LearnerNotes)
async def live_notes(body: NotesRequest, request: Request) -> LearnerNotes:
    return await update_notes(_deps(request), body.profileId)


@router.post("/session/start", response_model=SessionTurn)
async def live_session_start(body: SessionStartRequest, request: Request) -> SessionTurn:
    deps = _deps(request)
    return await start_session(deps, get_store(deps, request.app), body)


@router.post("/session/turn", response_model=SessionTurn)
async def live_session_turn(body: SessionTurnRequest, request: Request) -> SessionTurn:
    deps = _deps(request)
    return await take_turn(deps, get_store(deps, request.app), body)


async def _articulation_job(request: Request, wav: bytes, attempt_id: str, profile_id: str, sound: str,
                            clock: tuple[float | None, float | None]) -> None:
    """Collector -> features -> history. Never raises."""
    runtime = get_runtime(request.app)
    try:
        async with runtime.articulation_slot(reserved=True) as ok:
            if not ok:
                return
            state = request.app.state
            client = getattr(state, "live_articulation", None) or runtime.articulation()
            if client is None:
                return
            bundle = await client.analyze(
                wav, attempt_id=attempt_id, capture_start_monotonic_ms=clock[0], time_origin_unix_ms=clock[1]
            )
            if bundle is None:
                return
            features = extract_features(bundle)
            if features is None:
                return
            history = getattr(state, "live_history", None) or runtime.history(
                getattr(state, "live_spacetime_transport", None)
            )
            await history.record_articulation(profile_id, attempt_id, sound, features)
    except Exception as exc:  # noqa: BLE001
        logger.warning("articulation job failed: %s", type(exc).__name__)


@router.post("/articulation")
async def live_articulation(
    request: Request,
    background: BackgroundTasks,
    attemptId: str,
    profileId: str,
    sound: SoundId,
    captureStartMonotonicMs: float | None = None,
    timeOriginUnixMs: float | None = None,
):
    """Accept an attempt WAV; analysis runs in the background and is stored with the learner's history."""
    if request.headers.get("content-type", "").split(";")[0].strip().lower() not in _WAV_TYPES:
        raise HTTPException(415, "Content-Type must be audio/wav")
    if not valid_attempt_id(attemptId):
        raise HTTPException(422, "attemptId must be a UUID")
    if not valid_profile_id(profileId):
        raise HTTPException(422, "profileId must match [A-Za-z0-9_.:@-]{1,64}")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > ARTICULATION_MAX_BYTES:
            raise HTTPException(413, "WAV exceeds 1 MiB")
        chunks.append(chunk)
    if size < ARTICULATION_MIN_BYTES:
        raise HTTPException(422, "WAV body too small")
    state = request.app.state
    runtime = get_runtime(request.app)
    if not state.settings.articulation_configured and getattr(state, "live_articulation", None) is None:
        return JSONResponse({"accepted": False, "reason": "disabled"})
    if not runtime.reserve_articulation():
        return JSONResponse({"accepted": False, "reason": "busy"})
    background.add_task(
        _articulation_job, request, b"".join(chunks), attemptId, profileId, sound,
        (captureStartMonotonicMs, timeOriginUnixMs),
    )
    return JSONResponse({"accepted": True}, status_code=202, background=background)
