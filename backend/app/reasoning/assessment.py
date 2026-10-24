"""Turn comparison measurements into one supported finding.

The finding codes are produced here, before any model call. Claude may restate
the code and choose a cue. It is not a source of measurements.
"""

from dataclasses import dataclass

from app.audio.extract import CaptureFacts
from app.config import Settings
from app.schemas import (
    AlignmentInfo,
    ComparisonMetrics,
    EvidenceItem,
    QualityFlags,
    ReferenceMetadata,
)
from app.audio.content import ContentCheck


@dataclass(frozen=True)
class Assessment:
    finding: str
    usable: bool
    claims_limited: bool
    evidence: list[EvidenceItem]
    quality: QualityFlags
    limitations: list[str]
    terminal_status: str


def _coverage_ok(coverage: float | None, frames: int | None, settings: Settings) -> bool:
    return (frames or 0) >= settings.min_usable_frames and (coverage or 0.0) >= settings.min_usable_coverage


def assess(
    metrics: ComparisonMetrics,
    alignment: AlignmentInfo,
    learner_facts: CaptureFacts,
    reference_facts: CaptureFacts,
    content: ContentCheck,
    metadata: ReferenceMetadata,
    settings: Settings,
) -> Assessment:
    low_coverage = not _coverage_ok(
        metrics.usable_frame_coverage_learner,
        metrics.learner_usable_frames,
        settings,
    )
    quality = QualityFlags(
        clipping=learner_facts.clipping_fraction >= settings.clipping_fraction_limit,
        excessive_silence=learner_facts.excessive_silence,
        suspected_octave_error=learner_facts.suspected_octave_error or reference_facts.suspected_octave_error,
        implausible_pitch_jump=learner_facts.implausible_pitch_jump,
        low_usable_coverage=low_coverage,
        alignment_failed=not alignment.alignment_ok,
        f0_out_of_range=learner_facts.f0_out_of_range,
        downmixed_to_mono=learner_facts.downmixed_to_mono,
        content_verified=content.verified,
        content_check_reason=content.reason,
    )
    limitations = ["voicing_probability_is_not_pronunciation_quality"]
    if not content.verified:
        limitations.append(content.reason)
    if quality.suspected_octave_error:
        limitations.append("suspected_octave_error")
    if quality.clipping:
        limitations.append("clipping")
    if quality.implausible_pitch_jump:
        limitations.append("implausible_pitch_jump")
    if quality.f0_out_of_range:
        limitations.append("f0_out_of_range")
    if quality.downmixed_to_mono:
        limitations.append("downmixed_to_mono")
    if quality.alignment_failed:
        limitations.append("alignment_failed")
    if reference_facts.excessive_silence:
        limitations.append("reference_not_usable")

    reference_ok = _coverage_ok(
        metrics.usable_frame_coverage_reference,
        metrics.reference_usable_frames,
        settings,
    ) and metrics.reference_ending_direction == metadata.intended_pattern
    learner_ok = (
        not learner_facts.excessive_silence
        and not low_coverage
        and not quality.f0_out_of_range
    )
    directions_known = (
        metrics.reference_ending_direction != "unknown"
        and metrics.learner_ending_direction != "unknown"
    )
    same_direction = directions_known and metrics.reference_ending_direction == metrics.learner_ending_direction

    if not reference_ok:
        finding = "reference_unusable"
        usable = False
        status = "failed"
    elif not learner_ok:
        structural_gap = learner_facts.excessive_silence or low_coverage
        finding = "insufficient_usable_pitch" if structural_gap else "capture_problem"
        usable = False
        status = "insufficient_audio"
    elif directions_known and metrics.learner_ending_direction != metrics.reference_ending_direction:
        finding = "ending_direction_mismatch"
        usable = True
        status = "complete"
    elif same_direction and _range_relation(metrics, settings) == "smaller":
        finding = "ending_range_smaller"
        usable = True
        status = "complete"
    elif same_direction and _range_relation(metrics, settings) == "larger":
        finding = "ending_range_larger"
        usable = True
        status = "complete"
    elif same_direction and metrics.aligned_rmse_st is not None and metrics.aligned_rmse_st <= settings.close_contour_rmse_st:
        finding = "contour_close"
        usable = True
        status = "complete"
    elif metrics.aligned_rmse_st is not None and learner_ok:
        finding = "contour_differs"
        usable = True
        status = "complete"
    else:
        finding = "alignment_failed"
        usable = False
        status = "insufficient_audio"

    return Assessment(
        finding=finding,
        usable=usable,
        claims_limited=not content.verified,
        evidence=_evidence(metrics, alignment, quality, content),
        quality=quality,
        limitations=limitations,
        terminal_status=status,
    )


def _range_relation(metrics: ComparisonMetrics, settings: Settings) -> str | None:
    reference_range = metrics.reference_pitch_range_st
    learner_range = metrics.learner_pitch_range_st
    if reference_range is None or learner_range is None:
        return None
    if learner_range + settings.range_smaller_margin_st < reference_range and reference_range >= 2.0:
        return "smaller"
    if learner_range > reference_range + settings.range_larger_margin_st:
        return "larger"
    return None


def _evidence(
    metrics: ComparisonMetrics,
    alignment: AlignmentInfo,
    quality: QualityFlags,
    content: ContentCheck,
) -> list[EvidenceItem]:
    items = [
        EvidenceItem(
            evidence_id="ev-ending-direction",
            metric="ending_direction",
            value=f"{metrics.reference_ending_direction}|{metrics.learner_ending_direction}",
            detail="Measured reference direction, then learner direction.",
        ),
        EvidenceItem(
            evidence_id="ev-ending-change",
            metric="ending_change_st",
            value=f"{metrics.reference_ending_change_st}|{metrics.learner_ending_change_st}",
            unit="semitones",
            detail="Robust ending change for the reference, then the learner.",
        ),
        EvidenceItem(
            evidence_id="ev-pitch-range",
            metric="pitch_range_st",
            value=f"{metrics.reference_pitch_range_st}|{metrics.learner_pitch_range_st}",
            unit="semitones",
            detail="Robust pitch range, reference then learner. Ranges are not scaled together.",
        ),
        EvidenceItem(
            evidence_id="ev-movement-time",
            metric="movement_time_fraction",
            value=f"{metrics.reference_movement_time_fraction}|{metrics.learner_movement_time_fraction}",
            detail="Fraction of each phrase span where the ending movement is underway.",
        ),
        EvidenceItem(
            evidence_id="ev-aligned-rmse",
            metric="aligned_rmse_st",
            value=metrics.aligned_rmse_st,
            unit="semitones",
            detail="Root mean square relative-pitch difference on the aligned usable frames.",
        ),
        EvidenceItem(
            evidence_id="ev-coverage",
            metric="usable_frame_coverage",
            value=f"{metrics.usable_frame_coverage_reference}|{metrics.usable_frame_coverage_learner}",
            detail="Usable-frame coverage inside each phrase span.",
        ),
        EvidenceItem(
            evidence_id="ev-duration-ratio",
            metric="duration_ratio",
            value=alignment.duration_ratio,
            detail="Learner phrase duration divided by reference phrase duration.",
        ),
        EvidenceItem(
            evidence_id="ev-alignment",
            metric="alignment",
            value=alignment.method if alignment.alignment_ok else "failed",
            detail=alignment.note or "Alignment status.",
        ),
        EvidenceItem(
            evidence_id="ev-content",
            metric="content_verified",
            value=str(content.verified).lower(),
            detail=content.reason,
        ),
    ]
    if quality.suspected_octave_error:
        items.append(
            EvidenceItem(
                evidence_id="ev-octave",
                metric="suspected_octave_error",
                value="true",
                detail="At least one frame was withheld as a suspected octave error.",
            )
        )
    if quality.clipping:
        items.append(
            EvidenceItem(
                evidence_id="ev-clipping",
                metric="clipping",
                value="true",
                detail="The learner recording has samples at the clipping level.",
            )
        )
    return items
