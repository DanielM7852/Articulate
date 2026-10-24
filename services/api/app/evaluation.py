"""Replay labeled synthetic attempt sessions without microphone, UI, TTS, or persistence."""

import asyncio
import time
from typing import Literal

from pydantic import Field

from .coaching import excluded_cues, plan
from .config import Settings
from .decisions import caption_for, fallback, validate_decision
from .providers import CueRepository, Reasoner
from .schemas import Action, CoachingRequest, Model, ObservationId


class ExpectedCoaching(Model):
    action: Action
    observation_id: ObservationId
    forbidden_cue_ids: list[str] = Field(default_factory=list)


class CoachingScenario(Model):
    id: str
    request: CoachingRequest
    expected: ExpectedCoaching


class CoachingSuite(Model):
    schema_version: Literal[1] = 1
    source: str = "synthetic engineering fixtures; not measured learner speech"
    scenarios: list[CoachingScenario]


async def evaluate(suite: CoachingSuite, settings: Settings):
    repository, reasoner = CueRepository(settings), Reasoner(settings)
    results = []
    try:
        if not settings.mock_mode:
            required = ("anthropic_api_key", "claude_model", "moss_project_id", "moss_project_key")
            missing = [name.upper() for name in required if not getattr(settings, name)]
            if missing:
                raise ValueError("Missing live evaluation configuration: " + ", ".join(missing))
            if not any(c.review_status == "approved" for c in repository.cues):
                raise ValueError(
                    "Live evaluation requires approved cue content; demo drafts are not eligible"
                )
            async with asyncio.timeout(settings.provider_deadline_seconds):
                await repository.startup()
        for scenario in suite.scenarios:
            request = scenario.request
            summary, context = request.summary, request.context
            excluded = excluded_cues(summary, context)
            provisional = plan(summary, context, [])
            started = time.perf_counter()
            error = None
            cues = []
            try:
                async with asyncio.timeout(settings.provider_deadline_seconds):
                    cues = await repository.query(
                        summary.target_id,
                        excluded=excluded,
                        history_revision=len(context.cue_history),
                        observation_text=provisional.observations[0].text,
                    )
                    decision = await reasoner.decide(summary, request.generation_id, cues, context)
                    decision = validate_decision(
                        decision,
                        summary,
                        request.generation_id,
                        cues,
                        context,
                        allow_demo=settings.mock_mode and settings.allow_demo_cues,
                    )
            except Exception as exc:
                error = type(exc).__name__
                decision = validate_decision(
                    fallback(summary, request.generation_id, cues, context),
                    summary,
                    request.generation_id,
                    cues,
                    context,
                    allow_demo=settings.mock_mode and settings.allow_demo_cues,
                )
            cue = next((c for c in cues if c.id == decision.cue_id), None)
            matches = (
                decision.next_action == scenario.expected.action
                and decision.observation_id == scenario.expected.observation_id
                and decision.cue_id not in scenario.expected.forbidden_cue_ids
            )
            results.append(
                {
                    "scenario": scenario.id,
                    "policy_valid": True,
                    "matches_expectation": matches,
                    "provider_error": error,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                    "decision": decision.model_dump(mode="json"),
                    "caption": caption_for(decision, cue),
                    "plan": plan(summary, context, cues).model_dump(mode="json"),
                }
            )
    finally:
        await repository.close()
        await reasoner.close()
    return {
        "schema_version": 1,
        "mode": "mock" if settings.mock_mode else "live",
        "source": suite.source,
        "claude_called": bool(reasoner.calls),
        "claude_requests": reasoner.calls,
        "passed": sum(r["matches_expectation"] and r["provider_error"] is None for r in results),
        "total": len(results),
        "provider_errors": sum(r["provider_error"] is not None for r in results),
        "note": "Mock results exercise deterministic policy, not Claude response quality. No TTS or database calls are made.",
        "scenarios": results,
    }
