"""HTTP contract for comparison, progress, and reference playback."""

import re
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from app.paths import BACKEND_ROOT

from app.audio.content import RejectingContentVerifier
from app.audio.gateway import FIXTURE_SCENARIOS, fixture_wav
from app.errors import ArticulateError, StaleAttemptError
from app.integrations.cartesia import cached_speech_wav, mint_tts_token
from app.reasoning.orchestrate import ComparisonJob
from app.reasoning.vowel_coach import VowelCoachRequest, VowelCoachResponse, coach_attempt
from app.schemas import ComparisonResult, ErrorBody, HealthResponse, ReferenceView, SpeechTokenResponse

router = APIRouter()
_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    rate: float | None = Field(default=None, ge=0.6, le=1.5)


# 2026-10-23: the root JSON index was replaced by the listening page below.
# def index() -> dict:
#     return {
#         "service": "Articulate audio backend",
#         "health": "/health",
#         "docs": "/docs",
#         "fixtures": "/v1/fixtures",
#         "references": "/v1/references",
#         "comparison": "/v1/comparisons",
#     }


@router.get("/", response_class=HTMLResponse)
def listening_check() -> HTMLResponse:
    page = (BACKEND_ROOT / "app" / "demo.html").read_text(encoding="utf-8")
    return HTMLResponse(page)


@router.get("/v1/fixtures/{scenario}/audio")
def fixture_audio(scenario: str, request: Request, reference_id: str = "intonation-rising-ready") -> Response:
    if scenario not in FIXTURE_SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown fixture scenario '{scenario}'.")
    metadata = _call_metadata(request, reference_id)
    return Response(content=fixture_wav(scenario, metadata), media_type="audio/wav")


@router.post("/v1/coach", response_model=VowelCoachResponse)
async def vowel_coach(body: VowelCoachRequest, request: Request) -> VowelCoachResponse:
    """Practice-screen coach. The browser already measured the attempt summary."""

    client = getattr(request.app.state, "vowel_client", None)
    return await coach_attempt(request.app.state.settings, body, client=client)


@router.post("/v1/speech")
def speak_line(body: SpeechRequest, request: Request) -> Response:
    """Speak one practice-screen line with Cartesia. The browser falls back if this is unavailable."""

    settings = request.app.state.settings
    if not settings.cartesia_configured:
        raise HTTPException(status_code=503, detail="Cartesia is not configured.")
    try:
        wav = cached_speech_wav(settings, body.text.strip(), speed=body.rate)
    except ArticulateError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    return Response(content=wav, media_type="audio/wav")


@router.post("/v1/speech/token", response_model=SpeechTokenResponse)
def speech_token(request: Request) -> SpeechTokenResponse:
    """Short-lived Cartesia token so the browser can stream speech with word timestamps."""

    settings = request.app.state.settings
    if not settings.cartesia_configured:
        raise HTTPException(status_code=503, detail="cartesia_not_configured")
    try:
        data = mint_tts_token(settings, client=getattr(request.app.state, "cartesia_client", None))
    except ArticulateError as exc:
        raise HTTPException(status_code=502, detail="cartesia_token_failed") from exc
    return SpeechTokenResponse(**data)


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    settings = request.app.state.settings
    return HealthResponse(
        analysis_version=settings.analysis_version,
        anthropic_configured=settings.anthropic_configured,
        moss_configured=settings.moss_configured,
        cartesia_configured=settings.cartesia_configured,
        audio_retained_by_default=False,
    )


@router.get("/v1/fixtures")
def list_fixtures() -> dict:
    return {
        "fixture_mode": True,
        "notice": "Fixture audio is synthetic. It is not a human recording and not an accuracy benchmark.",
        "scenarios": list(FIXTURE_SCENARIOS),
    }


@router.get("/v1/references")
def list_references(request: Request) -> dict:
    return {"reference_ids": request.app.state.orchestrator.references.ids()}


@router.get("/v1/references/{reference_id}", response_model=ReferenceView)
def get_reference(reference_id: str, request: Request) -> ReferenceView:
    _require_id(reference_id, "reference_id")
    loaded = _call_reference(request, reference_id)
    from app.audio.compare import comparison_segments

    return ReferenceView(
        reference_id=loaded.metadata.reference_id,
        transcript=loaded.metadata.transcript,
        intended_pattern=loaded.metadata.intended_pattern,
        exercise=loaded.metadata.exercise,
        language=loaded.metadata.language,
        analysis_version=loaded.metadata.analysis_version,
        provenance=loaded.metadata.provenance,
        segments=comparison_segments(loaded.metadata, loaded.contour),
        contour=loaded.contour,
        word_boundaries_available=bool(loaded.metadata.word_boundaries),
        audio_url=f"/v1/references/{loaded.metadata.reference_id}/audio",
    )


@router.get("/v1/references/{reference_id}/audio")
def get_reference_audio(reference_id: str, request: Request) -> Response:
    _require_id(reference_id, "reference_id")
    loaded = _call_reference(request, reference_id)
    return Response(content=loaded.wav_bytes, media_type="audio/wav")


@router.post("/v1/comparisons", response_model=ComparisonResult)
async def create_comparison(
    request: Request,
    reference_id: str = Form(...),
    attempt_id: str = Form(...),
    session_id: str = Form(...),
    capture_state: str = Form(...),
    learner_audio: UploadFile = File(...),
) -> ComparisonResult:
    if capture_state != "learner_recording":
        raise HTTPException(
            status_code=422,
            detail="capture_state must be learner_recording. Playback audio is not evaluated as learner speech.",
        )
    _require_id(reference_id, "reference_id")
    _require_id(attempt_id, "attempt_id")
    _require_id(session_id, "session_id")
    data = await learner_audio.read()
    if len(data) > request.app.state.settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Upload is too large.")
    job = ComparisonJob(
        session_id=session_id,
        attempt_id=attempt_id,
        reference_id=reference_id,
        audio=data,
        filename=learner_audio.filename or "learner.wav",
    )
    return await _run(request, job)


@router.post("/v1/comparisons/fixtures/{scenario}", response_model=ComparisonResult)
async def create_fixture_comparison(
    scenario: str,
    request: Request,
    reference_id: str = "intonation-rising-ready",
    session_id: str = "fixture-session",
    attempt_id: str | None = None,
) -> ComparisonResult:
    """Run the comparison loop on labeled synthetic audio. This is not a benchmark."""

    _require_id(reference_id, "reference_id")
    _require_id(session_id, "session_id")
    if attempt_id is not None:
        _require_id(attempt_id, "attempt_id")
    if scenario not in FIXTURE_SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown fixture scenario '{scenario}'.")
    metadata = _call_metadata(request, reference_id)
    audio = fixture_wav(scenario, metadata)
    job = ComparisonJob(
        session_id=session_id,
        attempt_id=attempt_id or f"fixture-{scenario}-{uuid4().hex[:8]}",
        reference_id=reference_id,
        audio=audio,
        filename=f"{scenario}.wav",
        fixture_mode=True,
        fixture_scenario=scenario,
        verifier=RejectingContentVerifier() if scenario == "content_mismatch" else None,
    )
    return await _run(request, job)


@router.get("/v1/attempts/{attempt_id}/progress")
async def stream_progress(attempt_id: str, request: Request) -> StreamingResponse:
    _require_id(attempt_id, "attempt_id")
    bus = request.app.state.orchestrator.progress

    async def events():
        async for event in bus.iter_events(attempt_id):
            if await request.is_disconnected():
                break
            yield f"event: {event.stage}\ndata: {event.model_dump_json()}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@router.delete("/v1/sessions/{session_id}")
def delete_session(session_id: str, request: Request) -> dict:
    """Delete derived session records. Raw audio is not stored."""

    _require_id(session_id, "session_id")
    orchestrator = request.app.state.orchestrator
    attempt_ids = []
    store = orchestrator.store
    if hasattr(store, "attempt_ids"):
        attempt_ids = store.attempt_ids(session_id)
    deleted = store.delete_session(session_id)
    for attempt_id in attempt_ids:
        orchestrator.progress.clear_attempt(attempt_id)
    return {"deleted": deleted, "session_id": session_id}


async def _run(request: Request, job: ComparisonJob) -> ComparisonResult:
    try:
        return await request.app.state.orchestrator.compare(job)
    except StaleAttemptError as exc:
        raise HTTPException(
            status_code=409,
            detail=ErrorBody(
                error=exc.code,
                message=exc.message,
                session_id=exc.session_id,
                attempt_id=exc.attempt_id,
            ).model_dump(),
        ) from exc
    except ArticulateError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=ErrorBody(error=exc.code, message=exc.message, session_id=job.session_id, attempt_id=job.attempt_id).model_dump(),
        ) from exc


def _require_id(value: str, field: str) -> None:
    if not _ID_RE.fullmatch(value):
        raise HTTPException(status_code=422, detail=f"{field} must be 1-80 characters of letters, numbers, or . _ : -.")


def _call_reference(request: Request, reference_id: str):
    try:
        return request.app.state.orchestrator.references.load(reference_id)
    except ArticulateError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


def _call_metadata(request: Request, reference_id: str):
    try:
        return request.app.state.orchestrator.references.metadata(reference_id)
    except ArticulateError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
