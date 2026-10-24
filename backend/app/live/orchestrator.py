"""Per-attempt live coaching: gather metrics, score, load history, decide, validate, persist."""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, unwrap, uuid_literal
from app.live import llm
from app.live.decision import (
    evidence_candidates,
    fallback_decision,
    show_side_view,
    validate_decision,
)
from app.live.history import LearnerContext, LearnerHistory, build_history
from app.live.schemas import (
    AudioFrame,
    AudioScore,
    CoachDecision,
    LipFrame,
    LiveCoachRequest,
    LiveCoachResponse,
    VideoScore,
)
from app.live.scoring import score_audio, score_video
from app.live.targets import SOUND_CUE, SOUND_SPELLING

logger = logging.getLogger(__name__)

MAX_AUDIO_FRAMES = 1500
MAX_VIDEO_FRAMES = 600
OPEN_POLL_TOTAL_S = 2.0
OPEN_POLL_STEP_S = 0.15


@dataclass
class LiveDeps:
    settings: Settings
    anthropic_client: Any = None  # tests inject a fake with .messages.parse
    transport: httpx.AsyncBaseTransport | None = None  # tests inject httpx.MockTransport
    history: LearnerHistory | None = None
    spacetime: SpacetimeClient | None = None  # shared pooled client from the app runtime

    def get_history(self) -> LearnerHistory:
        return self.history or build_history(self.settings, self.transport)

    @property
    def model_available(self) -> bool:
        return self.anthropic_client is not None or self.settings.anthropic_configured


def _decode_frames(batches: list[dict[str, Any]]) -> tuple[list[AudioFrame], list[LipFrame]]:
    batches = sorted(batches, key=lambda b: (str(unwrap(b.get("kind"))), int(unwrap(b.get("seq")) or 0)))
    audio: list[AudioFrame] = []
    video: list[LipFrame] = []
    for batch in batches:
        kind = unwrap(batch.get("kind"))
        try:
            items = json.loads(unwrap(batch.get("frames")) or "[]")
        except (TypeError, ValueError):
            continue
        if not isinstance(items, list):
            continue
        model, target = (AudioFrame, audio) if kind == "audio" else (LipFrame, video) if kind == "video" else (None, None)
        if model is None or target is None:
            continue
        for item in items:
            try:
                target.append(model.model_validate(item))
            except Exception:  # noqa: BLE001 - skip malformed frames
                continue
    return audio[:MAX_AUDIO_FRAMES], video[:MAX_VIDEO_FRAMES]


async def _read_spacetime_frames(deps: LiveDeps, attempt_id: str) -> tuple[list[AudioFrame], list[LipFrame]]:
    client = deps.spacetime or SpacetimeClient(deps.settings, deps.transport)
    lit = uuid_literal(attempt_id)
    deadline = time.monotonic() + OPEN_POLL_TOTAL_S
    status_q = f"SELECT * FROM learner_attempt WHERE attempt_id = {lit}"
    batch_q = f"SELECT * FROM metric_batch WHERE attempt_id = {lit}"
    # Status and batches are fetched together; an already-ended attempt needs no polling or second read.
    rows, batches = await asyncio.gather(client.sql(status_q), client.sql(batch_q))
    while (unwrap(rows[0].get("status")) if rows else None) == "open" and time.monotonic() < deadline:
        await asyncio.sleep(OPEN_POLL_STEP_S)
        rows, batches = await asyncio.gather(client.sql(status_q), client.sql(batch_q))
    return _decode_frames(batches)


async def gather_frames(deps: LiveDeps, body: LiveCoachRequest) -> tuple[list[AudioFrame], list[LipFrame], str]:
    if body.metricsSource == "spacetimedb" and deps.settings.spacetime_configured:
        try:
            audio, video = await _read_spacetime_frames(deps, body.attemptId)
            if audio or video:
                return audio, video, "spacetimedb"
        except Exception as exc:  # noqa: BLE001 - fall back to the request body
            logger.warning("spacetime frame read failed: %s", type(exc).__name__)
    if body.frames and (body.frames.audio or body.frames.video):
        return body.frames.audio, body.frames.video, "inline"
    return [], [], "none"


def _user_message(
    body: LiveCoachRequest,
    audio: AudioScore,
    video: VideoScore | None,
    candidates: dict[str, float | str],
    context: LearnerContext,
) -> str:
    payload = {
        "sound": body.sound,
        "spelledAs": SOUND_SPELLING[body.sound],
        "thisSoundCue": SOUND_CUE[body.sound],
        "offsetMeaning": "f1Offset/f2Offset are log-ratios to the target centre; positive f1Offset = more open / lower tongue, positive f2Offset = further forward",
        "clientSummary": body.clientSummary.model_dump(),
        "audio": audio.model_dump(),
        "video": video.model_dump() if video else None,
        "allowedEvidenceFields": sorted(candidates),
        "recentAttempts": context.attempts,
        "learnerNotes": context.notes,
    }
    return json.dumps(payload, separators=(",", ":"))


def _ms(start: float, end: float) -> int:
    return int(round((end - start) * 1000))


async def _load_history(deps: LiveDeps, history: LearnerHistory, body: LiveCoachRequest) -> tuple[LearnerContext, int]:
    t0 = time.perf_counter()
    try:
        context = await history.load(body.profileId, deps.settings.live_history_limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("history load failed: %s", type(exc).__name__)
        context = LearnerContext()
    return context, _ms(t0, time.perf_counter())


async def _timed_frames(deps: LiveDeps, body: LiveCoachRequest):
    t0 = time.perf_counter()
    result = await gather_frames(deps, body)
    return result, _ms(t0, time.perf_counter())


async def _decide(
    deps: LiveDeps,
    body: LiveCoachRequest,
    audio: AudioScore,
    video: VideoScore | None,
    context: LearnerContext,
    timings: dict[str, int],
):
    candidates = evidence_candidates(audio, video, body.clientSummary)
    timings["llm"] = 0
    timings["validate"] = 0
    if deps.model_available:
        try:
            t0 = time.perf_counter()
            decision = await llm.ask(
                deps.settings,
                deps.anthropic_client,
                llm.COACH_SYSTEM,
                _user_message(body, audio, video, candidates, context),
                CoachDecision,
                deps.settings.live_coach_effort,
                deps.settings.live_coach_timeout_s,
                max_tokens=6000,
                model=deps.settings.live_coach_model,
                thinking=deps.settings.live_coach_thinking,
            )
            t1 = time.perf_counter()
            timings["llm"] = _ms(t0, t1)
            evidence = validate_decision(decision, body.sound, audio, video, candidates)
            timings["validate"] = _ms(t1, time.perf_counter())
            return "agent", decision, evidence
        except Exception as exc:  # noqa: BLE001 - any model or validation failure uses the fallback
            timings["llm"] = _ms(t0, time.perf_counter())
            logger.warning("live coach used fallback: %s", type(exc).__name__)
    t2 = time.perf_counter()
    decision, evidence = fallback_decision(body.sound, audio, video, candidates, context.attempts)
    timings["validate"] += _ms(t2, time.perf_counter())
    return "fallback", decision, evidence


Scheduler = Callable[[Callable[[], Awaitable[None]]], None]


async def coach_attempt(
    deps: LiveDeps, body: LiveCoachRequest, schedule: Scheduler | None = None
) -> LiveCoachResponse:
    """Coach one attempt. Persistence runs after the response via `schedule` (inline when None)."""
    started = time.perf_counter()
    timings: dict[str, int] = {}
    history = deps.get_history()
    # Frame read and history load are independent: run them concurrently.
    ((audio_frames, lip_frames, metrics_source), timings["frames"]), (context, timings["history"]) = await asyncio.gather(
        _timed_frames(deps, body), _load_history(deps, history, body)
    )
    t = time.perf_counter()
    audio = score_audio(body.sound, audio_frames)
    video = score_video(body.sound, lip_frames)
    timings["scoring"] = _ms(t, time.perf_counter())
    # The current attempt may already be stored (for example a retried request); never show it as history.
    context.attempts = [a for a in context.attempts if a.get("attemptId") != body.attemptId]

    source, decision, evidence = await _decide(deps, body, audio, video, context, timings)
    response = LiveCoachResponse(
        attemptId=body.attemptId,
        source=source,
        metricsSource=metrics_source,
        audio=audio,
        video=video,
        observation=decision.observation.strip(),
        caption=decision.caption.strip(),
        cueId=decision.cueId,
        showSideView=show_side_view(decision.cueId, decision.nextAction),
        nextAction=decision.nextAction,
        evidence=evidence,
        persisted=None,
        model=deps.settings.live_coach_model if source == "agent" else None,
    )

    summary = {
        "attemptId": body.attemptId,
        "profileId": body.profileId,
        "sound": body.sound,
        "audio": audio.model_dump(),
        "video": video.model_dump() if video else None,
        "clientSummary": body.clientSummary.model_dump(),
        "cueId": response.cueId,
        "nextAction": response.nextAction,
    }
    decision_json = response.model_dump(exclude={"audio", "video", "persisted", "model", "timingsMs"})

    async def persist() -> None:
        try:
            ok = await history.record(body.profileId, body.attemptId, summary, decision_json)
            if not ok:
                logger.warning("persist reported failure attempt=%s", body.attemptId)
        except Exception as exc:  # noqa: BLE001
            logger.warning("persist failed attempt=%s: %s", body.attemptId, type(exc).__name__)

    timings["total"] = _ms(started, time.perf_counter())
    response.timingsMs = {k: timings[k] for k in ("frames", "history", "scoring", "llm", "validate", "total")}
    logger.info(
        "live coach timings ms %s source=%s metrics=%s",
        " ".join(f"{k}={v}" for k, v in response.timingsMs.items()),
        response.source,
        response.metricsSource,
    )
    if schedule is not None:
        schedule(persist)
    else:
        await persist()
    return response
