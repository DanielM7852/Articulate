"""POST /v1/live/coach and /v1/live/notes. Provider failures never surface as 500s."""

from fastapi import APIRouter, BackgroundTasks, Request

from app.live.notes import update_notes
from app.live.orchestrator import LiveDeps, coach_attempt
from app.live.runtime import get_runtime
from app.live.schemas import LearnerNotes, LiveCoachRequest, LiveCoachResponse, NotesRequest

router = APIRouter(prefix="/v1/live")


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
