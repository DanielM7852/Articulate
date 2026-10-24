"""Per-attempt live coaching: gather metrics, score, load history, decide, validate, persist."""

import asyncio
import json
import logging
import time
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
OPEN_POLL_STEP_S = 0.25


@dataclass
class LiveDeps:
    settings: Settings
    anthropic_client: Any = None  # tests inject a fake with .messages.parse
    transport: httpx.AsyncBaseTransport | None = None  # tests inject httpx.MockTransport
    history: LearnerHistory | None = None

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
    client = SpacetimeClient(deps.settings, deps.transport)
    lit = uuid_literal(attempt_id)
    deadline = time.monotonic() + OPEN_POLL_TOTAL_S
    while True:
        rows = await client.sql(f"SELECT * FROM learner_attempt WHERE attempt_id = {lit}")
        status = unwrap(rows[0].get("status")) if rows else None
        if status != "open" or time.monotonic() >= deadline:
            break
        await asyncio.sleep(OPEN_POLL_STEP_S)
    batches = await client.sql(f"SELECT * FROM metric_batch WHERE attempt_id = {lit}")
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


async def _decide(
    deps: LiveDeps,
    body: LiveCoachRequest,
    audio: AudioScore,
    video: VideoScore | None,
    context: LearnerContext,
):
    candidates = evidence_candidates(audio, video, body.clientSummary)
    if deps.model_available:
        try:
            decision = await llm.ask(
                deps.settings,
                deps.anthropic_client,
                llm.COACH_SYSTEM,
                _user_message(body, audio, video, candidates, context),
                CoachDecision,
                deps.settings.live_coach_effort,
                deps.settings.live_coach_timeout_s,
                max_tokens=6000,
            )
            evidence = validate_decision(decision, body.sound, audio, video, candidates)
            return "agent", decision, evidence
        except Exception as exc:  # noqa: BLE001 - any model or validation failure uses the fallback
            logger.warning("live coach used fallback: %s", type(exc).__name__)
    decision, evidence = fallback_decision(body.sound, audio, video, candidates, context.attempts)
    return "fallback", decision, evidence


async def coach_attempt(deps: LiveDeps, body: LiveCoachRequest) -> LiveCoachResponse:
    audio_frames, lip_frames, metrics_source = await gather_frames(deps, body)
    audio = score_audio(body.sound, audio_frames)
    video = score_video(body.sound, lip_frames)

    history = deps.get_history()
    try:
        context = await history.load(body.profileId, deps.settings.live_history_limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("history load failed: %s", type(exc).__name__)
        context = LearnerContext()
    # The current attempt may already be stored (for example a retried request); never show it as history.
    context.attempts = [a for a in context.attempts if a.get("attemptId") != body.attemptId]

    source, decision, evidence = await _decide(deps, body, audio, video, context)
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
        persisted=False,
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
    decision_json = response.model_dump(exclude={"audio", "video", "persisted"})
    try:
        response.persisted = await history.record(body.profileId, body.attemptId, summary, decision_json)
    except Exception as exc:  # noqa: BLE001
        logger.warning("persist failed: %s", type(exc).__name__)
        response.persisted = False
    return response
