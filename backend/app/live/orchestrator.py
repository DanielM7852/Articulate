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
    validate_word_decision,
    word_evidence_candidates,
    word_fallback_decision,
    word_show_side_view,
    zone_info,
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
    WordScore,
)
from app.live.scoring import practice_scope, score_audio, score_video, score_word
from app.live.targets import SOUND_CUE, SOUND_SPELLING
from app.live.words import ZONE_CUE

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


def _practice_ids(body: LiveCoachRequest) -> list[str] | None:
    """practiceZoneIds restricted to the attempt's zones; None (whole word) when absent or nothing matches."""
    requested = body.practice_ids
    if requested is None or body.word is None:
        return None
    scope = practice_scope(body.word, requested)
    return scope or None


def _word_user_message(
    body: LiveCoachRequest,
    score: WordScore,
    candidates: dict[str, float | str],
    context: LearnerContext,
) -> str:
    word = body.word
    assert word is not None
    zones = []
    for z in word.zones:
        info = zone_info(word, z.zoneId)
        zones.append(
            {
                "id": z.zoneId,
                "label": info.label if info else z.phoneme,
                "phoneme": z.phoneme,
                "kind": z.kind,
                "position": info.position if info else "",
                "hint": (info.hint if word.lipUsable else info.hint_no_camera) if info else "",
                "verdict": z.verdict,
                "dwellMs": round(z.dwellMs),
                "evidence": z.evidence,
                "advisory": z.is_advisory,
                "cue": ZONE_CUE.get(z.zoneId),
            }
        )
    weakest = next((zone for zone in zones if zone["id"] == score.weakestZoneId), None)
    practice = _practice_ids(body)
    payload = {
        "word": word.word,
        "verdict": score.verdict,
        "hitCount": score.hitCount,
        "zoneCount": score.zoneCount,
        "quality": word.quality,
        "qualityReason": word.qualityReason,
        "lipUsable": word.lipUsable,
        "practiceZoneIds": practice,
        "zones": zones,
        "weakestZone": weakest,
        "focusZoneCue": weakest["cue"] if weakest else None,
        "evidenceMeaning": (
            "vowel: f1Offset/f2Offset are log-ratios to the target centre (positive f1Offset = more open, positive "
            "f2Offset = further forward), inTargetFraction is the share of voiced frames inside the target; in ghost mode "
            "vowel and liquid evidence also has pathDistance (mean distance of the learner's path from the model "
            "ghost path in close-zone units; 1 or less means inside the close zone) and closeFraction (share of path "
            "points inside the close zone); liquid and legacy tuner (r): "
            "valueMedian/valueBest are the F3-F2 gap in Hz (lower is a stronger r), inBandFraction the share in the "
            "green band; stop: burstDetected 1 when a release burst was seen; lips: spreadMean, roundingMean, "
            "lipOpeningMean when the camera was usable; advisory zones (liquid, fricative, nasal) are never judged: "
            "fricative and nasal arrive skipped with no evidence and are taught from their hint only"
        ),
        "allowedEvidenceFields": sorted(candidates),
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


async def _decide_word(
    deps: LiveDeps,
    body: LiveCoachRequest,
    score: WordScore,
    context: LearnerContext,
    timings: dict[str, int],
):
    word = body.word
    assert word is not None
    candidates = word_evidence_candidates(word, score)
    practice = _practice_ids(body)
    timings["llm"] = 0
    timings["validate"] = 0
    if deps.model_available:
        try:
            t0 = time.perf_counter()
            decision = await llm.ask(
                deps.settings,
                deps.anthropic_client,
                llm.WORD_COACH_SYSTEM,
                _word_user_message(body, score, candidates, context),
                CoachDecision,
                deps.settings.live_coach_effort,
                deps.settings.live_coach_timeout_s,
                max_tokens=6000,
                model=deps.settings.live_coach_model,
                thinking=deps.settings.live_coach_thinking,
            )
            t1 = time.perf_counter()
            timings["llm"] = _ms(t0, t1)
            evidence = validate_word_decision(decision, word, score, candidates, practice)
            timings["validate"] = _ms(t1, time.perf_counter())
            return "agent", decision, evidence
        except Exception as exc:  # noqa: BLE001 - any model or validation failure uses the fallback
            timings["llm"] = _ms(t0, time.perf_counter())
            logger.warning("live word coach used fallback: %s %s", type(exc).__name__, str(exc)[:80])
    t2 = time.perf_counter()
    decision, evidence = word_fallback_decision(word, score, candidates, practice)
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

    word_score = score_word(body.word, _practice_ids(body)) if body.word is not None else None
    if word_score is not None:
        source, decision, evidence = await _decide_word(deps, body, word_score, context, timings)
        focus = decision.focusZoneId
        side = word_show_side_view(focus, decision.nextAction)
    else:
        source, decision, evidence = await _decide(deps, body, audio, video, context, timings)
        focus = None
        side = show_side_view(decision.cueId, decision.nextAction)
    response = LiveCoachResponse(
        attemptId=body.attemptId,
        source=source,
        metricsSource=metrics_source,
        audio=audio,
        video=video,
        observation=decision.observation.strip(),
        caption=decision.caption.strip(),
        cueId=decision.cueId,
        showSideView=side,
        nextAction=decision.nextAction,
        evidence=evidence,
        persisted=None,
        model=deps.settings.live_coach_model if source == "agent" else None,
        word=word_score,
        focusZoneId=focus,
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
    if word_score is not None:
        summary["word"] = word_score.model_dump(include={"word", "verdict", "zoneCount", "hitCount", "weakestZoneId"})
        summary["focusZoneId"] = focus
    # Vowel turns keep their stored shape; word turns also record the focus zone.
    skip = {"audio", "video", "persisted", "model", "timingsMs", "word"} | (set() if word_score else {"focusZoneId"})
    decision_json = response.model_dump(exclude=skip)

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
