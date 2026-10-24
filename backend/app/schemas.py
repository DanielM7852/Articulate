"""API and handoff contracts.

Numeric fields use null when a measurement is unavailable.
These models are the integration surface for the visual and voice teammates.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AnalysisStatus = Literal["complete", "partial", "insufficient_audio", "failed"]
PitchDirection = Literal["rising", "falling", "steady", "unknown"]
AlignmentMethod = Literal["none", "linear_time_normalization", "constrained_dtw"]
NextAction = Literal[
    "repeat",
    "isolate_segment",
    "change_cue",
    "reduce_assistance",
    "pause",
    "rerecord",
]
ProgressStage = Literal[
    "received",
    "analyzing_audio",
    "aligning",
    "comparing",
    "selecting_cue",
    "partial",
    "complete",
    "failed",
]
RetrievalBackend = Literal["moss", "local_fallback"]
ReasoningSource = Literal["claude", "deterministic_fallback"]
FindingCode = Literal[
    "insufficient_usable_pitch",
    "ending_direction_mismatch",
    "ending_range_smaller",
    "ending_range_larger",
    "contour_close",
    "contour_differs",
    "capture_problem",
    "alignment_failed",
    "reference_unusable",
]


class PitchFrame(BaseModel):
    time_s: float
    f0_hz: float | None = None
    voiced: bool
    voicing_probability: float | None = None
    relative_pitch_st: float | None = None
    usable: bool
    rejected_reason: str | None = None


class PitchContour(BaseModel):
    """Original-time F0 track. Unusable frames leave f0 and relative pitch null."""

    sample_rate_hz: int
    hop_length: int
    frame_length: int
    analysis_version: str
    median_reliable_f0_hz: float | None = None
    frames: list[PitchFrame]


class Segment(BaseModel):
    segment_id: str
    label: str
    kind: Literal["silence", "voiced", "comparison"]
    start_s: float | None = None
    end_s: float | None = None


class AlignmentInfo(BaseModel):
    method: AlignmentMethod
    alignment_ok: bool
    duration_ratio: float | None = None
    band_radius: float | None = None
    path_length: int | None = None
    mean_abs_normalized_time_warp: float | None = None
    note: str | None = None


class ComparisonMetrics(BaseModel):
    reference_ending_direction: PitchDirection = "unknown"
    learner_ending_direction: PitchDirection = "unknown"
    reference_ending_change_st: float | None = None
    learner_ending_change_st: float | None = None
    reference_pitch_range_st: float | None = None
    learner_pitch_range_st: float | None = None
    reference_movement_time_fraction: float | None = None
    learner_movement_time_fraction: float | None = None
    aligned_rmse_st: float | None = None
    usable_frame_coverage_reference: float | None = None
    usable_frame_coverage_learner: float | None = None
    reference_usable_frames: int | None = None
    learner_usable_frames: int | None = None
    reference_duration_s: float | None = None
    learner_duration_s: float | None = None


class QualityFlags(BaseModel):
    clipping: bool = False
    excessive_silence: bool = False
    suspected_octave_error: bool = False
    implausible_pitch_jump: bool = False
    low_usable_coverage: bool = False
    alignment_failed: bool = False
    f0_out_of_range: bool = False
    downmixed_to_mono: bool = False
    content_verified: bool = False
    content_check_reason: str = "content_verifier_not_configured"


class EvidenceItem(BaseModel):
    evidence_id: str
    metric: str
    value: float | str | None = None
    unit: str | None = None
    detail: str


class ReferenceReplay(BaseModel):
    reference_id: str
    segment_id: str
    start_s: float
    end_s: float


class CartesiaHandoff(BaseModel):
    """Short payload for the voice teammate. Do not paste contours or history into the agent prompt."""

    session_id: str
    attempt_id: str
    status: AnalysisStatus
    observation: str
    instruction: str
    spoken_text: str
    cue_id: str | None = None
    cue_review_status: str | None = None
    next_action: NextAction
    reference_segment_replay: ReferenceReplay | None = None
    capture_limitations: list[str] = Field(default_factory=list)
    delivery_id: str | None = None


class RetrievalInfo(BaseModel):
    backend: RetrievalBackend
    disclosed_fallback: bool
    fallback_reason: str | None = None
    candidate_cue_ids: list[str] = Field(default_factory=list)
    draft_cue_ids: list[str] = Field(default_factory=list)
    review_notice: str


class ReasoningInfo(BaseModel):
    source: ReasoningSource
    model: str | None = None
    validated: bool
    rejection_reason: str | None = None
    cited_evidence_ids: list[str] = Field(default_factory=list)


class Timings(BaseModel):
    total_ms: float | None = None
    analyze_audio_ms: float | None = None
    compare_ms: float | None = None
    retrieve_ms: float | None = None
    reason_ms: float | None = None
    spacetime_commit_ms: float | None = None


class ComparisonResult(BaseModel):
    status: AnalysisStatus
    session_id: str
    attempt_id: str
    reference_id: str
    fixture_mode: bool = False
    fixture_scenario: str | None = None
    audio_retained: bool = False
    claims_limited: bool = True
    content_verified: bool = False
    analysis_version: str
    reference_contour: PitchContour | None = None
    learner_contour: PitchContour | None = None
    segments: list[Segment] = Field(default_factory=list)
    alignment: AlignmentInfo | None = None
    metrics: ComparisonMetrics | None = None
    evidence: list[EvidenceItem] = Field(default_factory=list)
    finding: str | None = None
    quality_flags: QualityFlags | None = None
    feedback: CartesiaHandoff
    limitations: list[str] = Field(default_factory=list)
    retrieval: RetrievalInfo | None = None
    reasoning: ReasoningInfo | None = None
    timings_ms: Timings = Field(default_factory=Timings)


class ProgressEvent(BaseModel):
    attempt_id: str
    session_id: str
    stage: ProgressStage
    result_status: AnalysisStatus | None = None
    message: str
    elapsed_ms: float


class ErrorBody(BaseModel):
    status: Literal["failed"] = "failed"
    error: str
    message: str
    session_id: str | None = None
    attempt_id: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    analysis_version: str
    anthropic_configured: bool
    moss_configured: bool
    cartesia_configured: bool
    spacetimedb_configured: bool = False
    audio_retained_by_default: bool = False


class Cue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cue_id: str
    exercise: str
    finding: str
    language: str
    difficulty: str
    instruction_text: str
    source: str
    review_status: Literal["draft", "reviewed"]


class ReferenceSegmentSpec(BaseModel):
    segment_id: str
    label: str
    start_fraction: float
    end_fraction: float


class AudioRecipe(BaseModel):
    sample_rate_hz: int
    duration_s: float
    start_f0_hz: float
    end_f0_hz: float
    glide_start_fraction: float
    pattern: Literal["rising", "falling", "steady"]


class ReferenceProvenance(BaseModel):
    kind: str
    reviewed: bool
    created: str
    description: str


class ReferenceMetadata(BaseModel):
    reference_id: str
    transcript: str
    intended_pattern: Literal["rising", "falling", "steady"]
    exercise: str
    language: str
    analysis_version: str
    word_boundaries: list[dict] | None = None
    segments: list[ReferenceSegmentSpec]
    provenance: ReferenceProvenance
    audio_recipe: AudioRecipe


class ReferenceView(BaseModel):
    reference_id: str
    transcript: str
    intended_pattern: str
    exercise: str
    language: str
    analysis_version: str
    provenance: ReferenceProvenance
    segments: list[Segment]
    contour: PitchContour | None = None
    word_boundaries_available: bool = False
    audio_url: str


class CoachOutput(BaseModel):
    """Structured Claude response. Length and evidence checks happen after parsing."""

    model_config = ConfigDict(extra="forbid")

    evidence_ids: list[str]
    finding: FindingCode
    selected_cue_id: str
    observation: str
    instruction: str
    next_action: NextAction
    limitations: list[str]


class AttemptSummary(BaseModel):
    attempt_id: str
    status: AnalysisStatus
    finding: str | None = None
    cue_id: str | None = None
    next_action: NextAction | None = None
