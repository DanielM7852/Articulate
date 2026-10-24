"""POST /v1/live/coach, /notes, /articulation, /session/start and /session/turn.

Local coaching, or authenticated durable jobs when shared coordination is enabled.
Provider failures never surface as 500s.
"""

import asyncio
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.integrations.spacetime import SpacetimeError
from app.live import insight
from app.live.articulation import annotate_attempts, extract_features
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
    SoundId,
    valid_attempt_id,
    valid_profile_id,
)
from app.live.session import get_store, start_session, take_turn
from app.live.shared_insight import SharedInsights

router = APIRouter(prefix="/v1/live")
logger = logging.getLogger(__name__)

ARTICULATION_MAX_BYTES = 1 << 20
ARTICULATION_MIN_BYTES = 44
_WAV_TYPES = ("audio/wav", "audio/x-wav")
INSIGHT_RETRY_DELAY_S = 2.0

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
            await client.sql("SELECT attempt_id FROM live_insight LIMIT 1")
        except Exception as exc:  # noqa: BLE001 - no provider details in a public health response
            raise HTTPException(503, "coordination_unavailable") from exc
    return {"status": "ready", "coordination": request.app.state.settings.live_coordination}


def _coordination(request: Request) -> Coordination:
    client = get_runtime(request.app).spacetime(getattr(request.app.state, "live_spacetime_transport", None))
    if client is None:
        raise HTTPException(503, "coordination_unavailable")
    return Coordination(request.app.state.settings, client)


def _is_shared(request: Request) -> bool:
    return request.app.state.settings.live_coordination == "spacetime"


class _InsightSink:
    """Where articulation status goes: this process's registry (local) or SpacetimeDB (shared). Never raises."""

    def __init__(self, runtime, shared: SharedInsights | None):
        self.runtime, self.shared = runtime, shared

    async def set(self, attempt_id: str, profile_id: str, sound: str, status: str,
                  say: str | None = None, source: str | None = None) -> bool:
        try:
            if self.shared is None:
                self.runtime.set_insight(attempt_id, profile_id, sound, status, say, source)
            else:
                await self.shared.set(attempt_id, profile_id, sound, status, say, source)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("insight write failed: %s", type(exc).__name__)
            return False

    async def fail_if_pending(self, attempt_id: str, profile_id: str, sound: str) -> None:
        try:
            if self.shared is None:
                entry = self.runtime.get_insight(attempt_id, profile_id)
            else:
                entry = await self.shared.get(attempt_id, profile_id)
            if entry is None or entry["status"] == "pending":
                await self.set(attempt_id, profile_id, sound, "none")
        except Exception as exc:  # noqa: BLE001
            logger.warning("insight fallback failed: %s", type(exc).__name__)


def _sink(request: Request) -> _InsightSink:
    runtime = get_runtime(request.app)
    if not _is_shared(request):
        return _InsightSink(runtime, None)
    client = runtime.spacetime(getattr(request.app.state, "live_spacetime_transport", None))
    if client is None:
        raise HTTPException(503, "coordination_unavailable")
    return _InsightSink(runtime, SharedInsights(request.app.state.settings, client))


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
    return await take_turn(deps, get_store(deps, request.app), body, get_runtime(request.app))


async def _find_attempt(history, profile_id: str, attempt_id: str, limit: int) -> tuple[list[dict], dict | None]:
    """Recent attempts (newest first) and the one for attempt_id; waits once for the coach record to persist."""
    for tries_left in (1, 0):
        items = list((await history.load(profile_id, limit)).attempts)
        match = next((i for i in items if isinstance(i, dict) and i.get("attemptId") == attempt_id), None)
        if match is not None or not tries_left:
            return items, match
        await asyncio.sleep(INSIGHT_RETRY_DELAY_S)
    return [], None


def _pick_claim(attempt: dict, sound: str) -> dict | None:
    art = attempt.get("articulation")
    claims = art.get("claims") if isinstance(art, dict) and art.get("quality") == "ok" else None
    allowed = [c for c in claims or [] if insight.claim_allowed(sound, c)]
    allowed.sort(key=lambda c: c.get("dimension") != "height")
    return allowed[0] if allowed else None


async def _insight_lane(runtime, sink, history, settings, client, profile_id: str, attempt_id: str, sound: str,
                        features: dict) -> None:
    """Find the gated claim for the attempt and store a validated line in the registry."""
    items, match = await _find_attempt(history, profile_id, attempt_id, settings.live_history_limit)
    if match is None:
        await sink.set(attempt_id, profile_id, sound, "none")
        return
    # Persistence may have failed (or the table is unpublished): annotate in memory from this process's features.
    pending = []
    for item in items:
        if isinstance(item, dict) and "articulation" not in item and "artic" not in item:
            stored = features if item is match else runtime.recalled_features(profile_id, item.get("attemptId"))
            if stored is not None:
                item = {**item, "artic": stored}
        pending.append(item)
    annotated = annotate_attempts(pending)
    current = next((i for i in annotated if isinstance(i, dict) and i.get("attemptId") == attempt_id), None)
    claim = _pick_claim(current, sound) if current else None
    if claim is None:
        await sink.set(attempt_id, profile_id, sound, "none")
        return
    recent = [i for i in annotated if isinstance(i, dict) and i.get("attemptId") != attempt_id]
    say, source = await insight.compose_line(settings, client, sound, claim, recent)
    await sink.set(attempt_id, profile_id, sound, "ready", say, source)


async def _articulation_job(request: Request, wav: bytes, attempt_id: str, profile_id: str, sound: str,
                            clock: tuple[float | None, float | None]) -> None:
    """Collector -> features -> history -> insight line. Never raises."""
    runtime = get_runtime(request.app)
    try:
        sink = _sink(request)
    except HTTPException:
        runtime.release_articulation()
        return
    try:
        features = history = None
        state = request.app.state
        async with runtime.articulation_slot(reserved=True) as ok:
            if ok:
                client = getattr(state, "live_articulation", None) or runtime.articulation()
                if client is not None:
                    bundle = await client.analyze(
                        wav, attempt_id=attempt_id, capture_start_monotonic_ms=clock[0], time_origin_unix_ms=clock[1]
                    )
                    features = extract_features(bundle) if bundle is not None else None
                if features is not None:
                    history = getattr(state, "live_history", None) or runtime.history(
                        getattr(state, "live_spacetime_transport", None)
                    )
                    await history.record_articulation(profile_id, attempt_id, sound, features)
                    runtime.remember_features(profile_id, attempt_id, features)
        if features is None:
            await sink.set(attempt_id, profile_id, sound, "none")
            return
        model_client = getattr(state, "live_client", None) or runtime.anthropic()
        await _insight_lane(runtime, sink, history, state.settings, model_client, profile_id, attempt_id, sound, features)
    except Exception as exc:  # noqa: BLE001
        logger.warning("articulation job failed: %s", type(exc).__name__)
        await sink.fail_if_pending(attempt_id, profile_id, sound)


@router.get("/articulation/{attemptId}")
async def live_articulation_status(attemptId: str, profileId: str, request: Request):
    """Insight status for the browser: never includes the line or claims."""
    if not valid_attempt_id(attemptId):
        raise HTTPException(422, "attemptId must be a UUID")
    if not valid_profile_id(profileId):
        raise HTTPException(422, "profileId must match [A-Za-z0-9_.:@-]{1,64}")
    authorize_profile(request, profileId)
    if _is_shared(request):
        try:
            entry = await _sink(request).shared.get(attemptId, profileId)
        except SpacetimeError as exc:
            raise HTTPException(503, "coordination_unavailable") from exc
    else:
        entry = get_runtime(request.app).get_insight(attemptId, profileId)
    if entry is None:
        return {"status": "unknown", "sound": None}
    return {"status": entry["status"], "sound": entry["sound"]}


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
    authorize_profile(request, profileId)
    state = request.app.state
    runtime = get_runtime(request.app)
    if not state.settings.articulation_configured and getattr(state, "live_articulation", None) is None:
        return JSONResponse({"accepted": False, "reason": "disabled"})
    if not runtime.reserve_articulation():
        return JSONResponse({"accepted": False, "reason": "busy"})
    if _is_shared(request):
        try:
            sink = _sink(request)
            await sink.shared.set(attemptId, profileId, sound, "pending")
        except (HTTPException, SpacetimeError):
            runtime.release_articulation()
            return JSONResponse({"accepted": False, "reason": "unavailable"})
    else:
        runtime.set_insight(attemptId, profileId, sound, "pending")
    background.add_task(
        _articulation_job, request, b"".join(chunks), attemptId, profileId, sound,
        (captureStartMonotonicMs, timeOriginUnixMs),
    )
    return JSONResponse({"accepted": True}, status_code=202, background=background)
