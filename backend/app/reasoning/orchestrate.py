"""Comparison controller.

The controller owns attempt order. A newer attempt for the same session cancels
the older one, and a repeated attempt id returns the saved result.
"""

import asyncio
import logging
import time
from dataclasses import dataclass

from app.audio.compare import comparison_segments, voicing_segments
from app.audio.content import ContentVerifier
from app.audio.gateway import ReferenceLibrary, analyze_learner_bytes, measure
from app.config import Settings
from app.errors import AudioRejected, CoachValidationError, ProviderNotConfigured, StaleAttemptError
from app.integrations.anthropic_client import ClaudeCoach
from app.integrations.cartesia import capture_limitation_notes, spoken_text
from app.integrations.spacetimedb import SpacetimeClient
from app.integrations.moss import CueRetriever, RetrievalQuery
from app.progress import ProgressBus
from app.reasoning.assessment import assess
from app.reasoning.fallback import fallback_output
from app.reasoning.history import summarize_history
from app.reasoning.validate import validate_coach_output
from app.schemas import (
    CartesiaHandoff,
    ComparisonResult,
    ReasoningInfo,
    ReferenceReplay,
    RetrievalInfo,
    Timings,
)
from app.storage.base import SessionStore

logger = logging.getLogger(__name__)


class CancelToken:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


@dataclass
class ComparisonJob:
    session_id: str
    attempt_id: str
    reference_id: str
    audio: bytes
    filename: str
    fixture_mode: bool = False
    fixture_scenario: str | None = None
    verifier: ContentVerifier | None = None
    spacetime_token: str | None = None


class Orchestrator:
    def __init__(
        self,
        settings: Settings,
        store: SessionStore,
        retriever: CueRetriever,
        coach: ClaudeCoach,
        progress: ProgressBus,
        references: ReferenceLibrary,
        verifier: ContentVerifier | None = None,
        spacetime: SpacetimeClient | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.spacetime = spacetime if spacetime is not None else SpacetimeClient.from_settings(settings)
        self.retriever = retriever
        self.coach = coach
        self.progress = progress
        self.references = references
        self.verifier = verifier or ContentVerifier()
        self.analyze_audio = analyze_learner_bytes
        self._lock = asyncio.Lock()
        self._inflight: dict[tuple[str, str], asyncio.Task] = {}
        self._tokens: dict[str, CancelToken] = {}

    async def compare(self, job: ComparisonJob) -> ComparisonResult:
        if job.reference_id not in self.references.ids():
            from app.errors import UnknownReferenceError

            raise UnknownReferenceError(job.reference_id)
        cached = self.store.get_result(job.session_id, job.attempt_id)
        if cached is not None:
            return cached
        async with self._lock:
            cached = self.store.get_result(job.session_id, job.attempt_id)
            if cached is not None:
                return cached
            key = (job.session_id, job.attempt_id)
            existing = self._inflight.get(key)
            if existing is not None:
                task = existing
            else:
                self.store.begin_attempt(job.session_id, job.attempt_id)
                token = CancelToken()
                previous = self._tokens.get(job.session_id)
                if previous is not None:
                    previous.cancel()
                self._tokens[job.session_id] = token
                task = asyncio.create_task(self._execute(job, token))
                self._inflight[key] = task
        return await task

    async def _execute(self, job: ComparisonJob, token: CancelToken) -> ComparisonResult:
        started = time.perf_counter()
        timings = Timings()
        try:
            self._emit(job, "received", started, "Comparison request accepted.")
            self._checkpoint(job, token)
            self._emit(job, "analyzing_audio", started, "Extracting pitch from the reference and the learner.")
            analyze_started = time.perf_counter()
            try:
                reference, learner = await asyncio.wait_for(
                    asyncio.gather(
                        asyncio.to_thread(self.references.load, job.reference_id),
                        asyncio.to_thread(self.analyze_audio, job.audio, job.filename, self.settings),
                    ),
                    timeout=self.settings.audio_timeout_s,
                )
            except TimeoutError:
                return self._finish_failure(job, token, started, timings, "audio_analysis_timeout", "Audio analysis timed out.")
            except AudioRejected as exc:
                return self._finish_failure(job, token, started, timings, exc.code, exc.message)
            timings.analyze_audio_ms = _elapsed_ms(analyze_started)
            self._checkpoint(job, token)
            self._emit(job, "aligning", started, "Aligning usable pitch frames.")
            self._emit(job, "comparing", started, "Comparing relative pitch contours.")
            compare_started = time.perf_counter()
            metrics, alignment = measure(reference.contour, learner.contour, self.settings)
            verifier = job.verifier or self.verifier
            content = verifier.verify(
                expected_transcript=reference.metadata.transcript,
                samples=learner.samples,
                sample_rate=learner.sample_rate,
            )
            assessment = assess(
                metrics,
                alignment,
                learner.facts,
                reference.facts,
                content,
                reference.metadata,
                self.settings,
            )
            timings.compare_ms = _elapsed_ms(compare_started)
            self._checkpoint(job, token)
            if assessment.usable:
                self._emit(job, "selecting_cue", started, "Selecting one practice cue.")
            retrieve_started = time.perf_counter()
            retrieval, history = await asyncio.gather(
                self.retriever.retrieve(
                    RetrievalQuery(
                        exercise=reference.metadata.exercise,
                        finding=assessment.finding,
                        language=reference.metadata.language,
                        attempted_cue_ids=self.store.attempted_cue_ids(job.session_id),
                    )
                ),
                asyncio.to_thread(lambda: summarize_history(self.store.recent_summaries(job.session_id))),
            )
            timings.retrieve_ms = _elapsed_ms(retrieve_started)
            self._checkpoint(job, token)
            reason_started = time.perf_counter()
            decision, reasoning, status = await self._decide(
                job,
                assessment,
                retrieval.cues,
                history,
                reference.metadata,
                started,
            )
            timings.reason_ms = _elapsed_ms(reason_started)
            limitations = list(assessment.limitations)
            if retrieval.cue_reused:
                limitations.append("cue_reused_after_history_exhausted")
            if retrieval.info.disclosed_fallback:
                limitations.append("local_retrieval_fallback")
            if job.fixture_mode:
                limitations.append("fixture_mode_synthetic_audio")
            if reference.version_mismatch:
                limitations.append("reference_metadata_version_mismatch")
            if reasoning.rejection_reason and status == "partial":
                limitations.append(reasoning.rejection_reason)
            selected = next((cue for cue in retrieval.cues if cue.cue_id == decision.selected_cue_id), None)
            if selected is not None and selected.review_status != "reviewed":
                limitations.append("selected_cue_is_unreviewed_draft")
            if not assessment.usable:
                status = assessment.terminal_status  # type: ignore[assignment]
            segments = voicing_segments(learner.contour, "learner") + comparison_segments(
                reference.metadata, reference.contour
            )
            handoff = _handoff(
                job,
                status,
                decision.observation,
                decision.instruction,
                None if selected is None else selected.cue_id,
                None if selected is None else selected.review_status,
                decision.next_action,
                segments,
                limitations,
            )
            timings.total_ms = _elapsed_ms(started)
            result = ComparisonResult(
                status=status,
                session_id=job.session_id,
                attempt_id=job.attempt_id,
                reference_id=job.reference_id,
                fixture_mode=job.fixture_mode,
                fixture_scenario=job.fixture_scenario,
                audio_retained=False,
                claims_limited=assessment.claims_limited,
                content_verified=content.verified,
                analysis_version=self.settings.analysis_version,
                reference_contour=reference.contour,
                learner_contour=learner.contour,
                segments=segments,
                alignment=alignment,
                metrics=metrics,
                evidence=assessment.evidence,
                finding=assessment.finding,
                quality_flags=assessment.quality,
                feedback=handoff,
                limitations=_unique(limitations),
                retrieval=retrieval.info,
                reasoning=reasoning,
                timings_ms=timings,
            )
            if self.spacetime.configured:
                committed = self.spacetime.commit_comparison(
                    result,
                    exercise=reference.metadata.exercise,
                    learner_token=job.spacetime_token,
                )
                result.timings_ms.spacetime_commit_ms = committed.elapsed_ms
                if committed.ok:
                    result.feedback.delivery_id = f"{job.attempt_id}:{status}:{assessment.finding}"
                else:
                    limitations.append("spacetimedb_commit_failed")
                    if not job.spacetime_token:
                        limitations.append("learner_identity_not_provided")
                    result.limitations = _unique(limitations)
            self._save(job, token, result)
            self._emit(
                job,
                _terminal_stage(status),
                started,
                status,
                result_status=status,
            )
            return result
        except StaleAttemptError:
            self._emit(job, "failed", started, "stale_attempt", result_status="failed")
            raise
        except Exception:
            logger.exception("comparison failed for attempt %s", job.attempt_id)
            return self._finish_failure(
                job,
                token,
                started,
                timings,
                "internal_error",
                "The comparison failed before a measurement was ready.",
            )
        finally:
            self._inflight.pop((job.session_id, job.attempt_id), None)

    async def _decide(self, job, assessment, cues, history, metadata, started):
        del job
        if not assessment.usable or not cues:
            decision = fallback_output(finding=assessment.finding, evidence=assessment.evidence, cues=cues)
            status = assessment.terminal_status if not assessment.usable else "partial"
            return (
                decision,
                ReasoningInfo(
                    source="deterministic_fallback",
                    validated=True,
                    rejection_reason=None if cues else "no_applicable_cue",
                    cited_evidence_ids=decision.evidence_ids,
                ),
                status,
            )
        remaining_s = self.settings.overall_timeout_s - (_elapsed_ms(started) / 1000.0)
        if remaining_s <= 0.25:
            decision = fallback_output(finding=assessment.finding, evidence=assessment.evidence, cues=cues)
            return (
                decision,
                ReasoningInfo(
                    source="deterministic_fallback",
                    validated=True,
                    rejection_reason="overall_timeout",
                    cited_evidence_ids=decision.evidence_ids,
                ),
                "partial",
            )
        budget = min(self.settings.reasoning_timeout_s, remaining_s)
        try:
            raw = await asyncio.wait_for(
                self.coach.complete(
                    finding=assessment.finding,
                    evidence=assessment.evidence,
                    cues=cues,
                    history_summary=history,
                    content_verified=not assessment.claims_limited,
                    intended_pattern=metadata.intended_pattern,
                    exercise=metadata.exercise,
                ),
                timeout=budget,
            )
            decision = validate_coach_output(
                raw,
                finding=assessment.finding,
                evidence=assessment.evidence,
                cues=cues,
            )
            return (
                decision,
                ReasoningInfo(
                    source="claude",
                    model=self.settings.anthropic_model,
                    validated=True,
                    cited_evidence_ids=decision.evidence_ids,
                ),
                "complete",
            )
        except TimeoutError:
            reason = "reasoning_timeout"
        except ProviderNotConfigured as exc:
            reason = exc.code
        except CoachValidationError as exc:
            reason = exc.code
        except Exception:
            logger.exception("coaching request failed")
            reason = "reasoning_error"
        decision = fallback_output(finding=assessment.finding, evidence=assessment.evidence, cues=cues)
        return (
            decision,
            ReasoningInfo(
                source="deterministic_fallback",
                validated=True,
                rejection_reason=reason,
                cited_evidence_ids=decision.evidence_ids,
            ),
            "partial",
        )

    def _finish_failure(self, job, token, started, timings, code: str, message: str) -> ComparisonResult:
        instruction = "Record the phrase again."
        cue_id = None
        review_status = None
        for cue in self.retriever._cues:
            if cue.cue_id == "cue-rerecord-draft":
                instruction = cue.instruction_text
                cue_id = cue.cue_id
                review_status = cue.review_status
                break
        timings.total_ms = _elapsed_ms(started)
        handoff = CartesiaHandoff(
            session_id=job.session_id,
            attempt_id=job.attempt_id,
            status="failed",
            observation="The recording could not be compared.",
            instruction=instruction,
            spoken_text=spoken_text("", instruction, "failed"),
            cue_id=cue_id,
            cue_review_status=review_status,
            next_action="rerecord",
            capture_limitations=[message],
        )
        result = ComparisonResult(
            status="failed",
            session_id=job.session_id,
            attempt_id=job.attempt_id,
            reference_id=job.reference_id,
            fixture_mode=job.fixture_mode,
            fixture_scenario=job.fixture_scenario,
            audio_retained=False,
            claims_limited=True,
            content_verified=False,
            analysis_version=self.settings.analysis_version,
            feedback=handoff,
            limitations=_unique([code, "voicing_probability_is_not_pronunciation_quality"]),
            retrieval=RetrievalInfo(
                backend="local_fallback",
                disclosed_fallback=True,
                fallback_reason="not_run",
                review_notice=self.retriever._notice,
            ),
            reasoning=ReasoningInfo(
                source="deterministic_fallback",
                validated=True,
                rejection_reason=code,
            ),
            timings_ms=timings,
        )
        self._save(job, token, result)
        self._emit(job, "failed", started, code, result_status="failed")
        return result

    def _save(self, job: ComparisonJob, token: CancelToken, result: ComparisonResult) -> None:
        self._checkpoint(job, token)
        self.store.save_result(job.session_id, job.attempt_id, result)

    def _checkpoint(self, job: ComparisonJob, token: CancelToken) -> None:
        if token.cancelled or self.store.latest_attempt_id(job.session_id) != job.attempt_id:
            raise StaleAttemptError(job.session_id, job.attempt_id)

    def _emit(self, job, stage, started, message, result_status=None) -> None:
        self.progress.publish(
            attempt_id=job.attempt_id,
            session_id=job.session_id,
            stage=stage,
            message=message,
            started=started,
            result_status=result_status,
        )


def _handoff(job, status, observation, instruction, cue_id, review_status, next_action, segments, limitations) -> CartesiaHandoff:
    replay = None
    for segment in segments:
        if segment.segment_id == "ending" and segment.start_s is not None and segment.end_s is not None:
            replay = ReferenceReplay(
                reference_id=job.reference_id,
                segment_id=segment.segment_id,
                start_s=segment.start_s,
                end_s=segment.end_s,
            )
            break
    return CartesiaHandoff(
        session_id=job.session_id,
        attempt_id=job.attempt_id,
        status=status,
        observation=observation,
        instruction=instruction,
        spoken_text=spoken_text(observation, instruction, status),
        cue_id=None if cue_id == "none" else cue_id,
        cue_review_status=review_status,
        next_action=next_action,
        reference_segment_replay=replay,
        capture_limitations=capture_limitation_notes(limitations),
    )


def _terminal_stage(status: str) -> str:
    if status == "complete":
        return "complete"
    if status == "failed":
        return "failed"
    return "partial"


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 3)


def _unique(items: list[str]) -> list[str]:
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen
