from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid", allow_inf_nan=False, json_schema_serialization_defaults_required=True
    )


TargetId = Literal["i", "u", "aa"]
PoseId = Literal["vowel-i", "vowel-u", "vowel-aa", "neutral"]
Action = Literal[
    "repeat", "change_cue", "simplify", "reduce_assistance", "next_target", "pause", "repair_capture"
]
State = Literal["ready", "capturing", "analyzing", "coaching", "presenting", "paused"]
ObservationId = Literal[
    "capture.insufficient",
    "capture.unavailable",
    "capture.usable",
    "target.inside",
    "target.outside",
    "trend.closer",
    "trend.similar",
    "trend.farther",
    "progress.ready_to_reduce",
]
CORPUS_REVISION = 2


class Target(Model):
    id: TargetId
    version: int = 1
    label: str
    f1: float
    f2: float
    radius_f1: float = 160
    radius_f2: float = 350
    pose_id: PoseId
    provenance: str = "Engineering demonstration region; not a personalized pronunciation standard."


TARGETS = {
    x.id: x
    for x in [
        Target(id="i", label="/i/ · ee", f1=300, f2=2300, pose_id="vowel-i"),
        Target(id="u", label="/u/ · oo", f1=350, f2=900, pose_id="vowel-u"),
        Target(id="aa", label="/ɑ/ · ah", f1=750, f2=1200, pose_id="vowel-aa"),
    ]
}


class Session(Model):
    id: UUID = Field(default_factory=uuid4)
    owner: UUID = Field(default_factory=uuid4)
    target_id: TargetId = "i"
    target_version: Literal[1] = 1
    language: Literal["en"] = "en"
    audio_enabled: bool = False
    assistance_level: Literal["guided", "reduced"] = "guided"
    revision: int = 0
    state: State = "ready"


class VisionMetrics(Model):
    # Client-authored telemetry: omitted optional metrics stay optional in the generated contract.
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)

    timestamp_ms: float = Field(ge=0)
    valid: bool
    quality_flags: list[str] = Field(default_factory=list)
    lip_opening: float | None = Field(default=None, ge=0, le=2)
    outer_lip_height: float | None = Field(default=None, ge=0, le=2)
    vermilion_flare: float | None = Field(default=None, ge=0, le=2)
    lip_width: float | None = Field(default=None, ge=0, le=3)
    lip_aspect_ratio: float | None = Field(default=None, ge=0, le=3)
    lip_protrusion_z: float | None = Field(default=None, ge=-1, le=1)
    jaw_drop: float | None = Field(default=None, ge=0, le=3)
    mouth_symmetry: float | None = Field(default=None, ge=0, le=1)
    inner_mouth_area: float | None = Field(default=None, ge=0, le=2)
    rounding_score: float | None = Field(default=None, ge=0, le=1)
    spread_score: float | None = Field(default=None, ge=0, le=1)
    openness_score: float | None = Field(default=None, ge=0, le=1)
    blendshapes: dict[str, float] = Field(default_factory=dict)
    pitch_deg: float | None = Field(default=None, ge=-90, le=90)
    yaw_deg: float | None = Field(default=None, ge=-90, le=90)
    roll_deg: float | None = Field(default=None, ge=-90, le=90)

    @field_validator("quality_flags")
    @classmethod
    def bounded_flags(cls, value):
        if len(value) > 10:
            raise ValueError("at most 10 quality flags")
        return value

    @model_validator(mode="after")
    def validate_vision(self):
        if not self.valid and self.lip_opening is not None:
            raise ValueError("invalid vision frames must use null lip_opening")
        if self.valid and self.lip_opening is None:
            raise ValueError("valid vision frames require lip_opening")
        return self


class VisionKeyframe(Model):
    label: Literal["onset", "peak_nucleus", "sustained_hold"]
    timestamp_ms: float = Field(ge=0)
    mime_type: Literal["image/jpeg", "image/webp"] = "image/jpeg"
    data_base64: str = Field(min_length=1, max_length=150000)
    metrics: VisionMetrics | None = None


class VisionSummary(Model):
    usable_frames: int = Field(default=0, ge=0)
    total_frames: int = Field(default=0, ge=0)
    usable_fraction: float = Field(default=0, ge=0, le=1)
    quality_flags: list[str] = Field(default_factory=list)
    lip_opening_mean: float | None = None
    lip_opening_max: float | None = None
    outer_lip_height_mean: float | None = None
    vermilion_flare_mean: float | None = None
    lip_width_mean: float | None = None
    lip_width_min: float | None = None
    lip_aspect_ratio_mean: float | None = None
    lip_protrusion_z_mean: float | None = None
    jaw_drop_mean: float | None = None
    mouth_symmetry_mean: float | None = None
    inner_mouth_area_mean: float | None = None
    rounding_score_mean: float | None = None
    rounding_score_max: float | None = None
    spread_score_mean: float | None = None
    spread_score_max: float | None = None
    openness_score_mean: float | None = None
    openness_score_max: float | None = None
    posture_stability_std: float | None = None
    voiced_visual_alignment: float | None = None
    blendshapes_mean: dict[str, float] = Field(default_factory=dict)
    head_pose_mean: dict[str, float] = Field(default_factory=dict)
    keyframes_count: int = Field(default=0, ge=0, le=4)


class FeatureFrame(Model):
    sample_offset: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0)
    duration_ms: float = Field(gt=0, le=200)
    f1: float | None = Field(default=None, gt=0, le=1500)
    f2: float | None = Field(default=None, gt=0, le=5000)
    f0: float | None = Field(default=None, gt=0, le=1500)
    valid: bool
    quality_flags: list[str] = Field(default_factory=list, max_length=10)
    source: Literal["microphone", "synthetic"]
    lip_opening: float | None = Field(default=None, ge=0, le=2)
    lip_width: float | None = Field(default=None, ge=0, le=3)
    lip_aspect_ratio: float | None = Field(default=None, ge=0, le=3)
    lip_protrusion_z: float | None = Field(default=None, ge=-1, le=1)
    jaw_drop: float | None = Field(default=None, ge=0, le=3)
    rounding_score: float | None = Field(default=None, ge=0, le=1)
    spread_score: float | None = Field(default=None, ge=0, le=1)
    openness_score: float | None = Field(default=None, ge=0, le=1)
    vision: VisionMetrics | None = None

    @model_validator(mode="after")
    def measurements(self):
        if self.valid and (self.f1 is None or self.f2 is None or self.f1 >= self.f2):
            raise ValueError("valid frames require ordered F1/F2")
        if not self.valid and (self.f1 is not None or self.f2 is not None):
            raise ValueError("invalid frames must use null formants")
        return self


class AttemptSummary(Model):
    attempt_id: UUID
    target_id: TargetId
    target_version: Literal[1] = 1
    capture_start_sample: int = Field(ge=0)
    capture_end_sample: int = Field(ge=0)
    sample_rate: int = Field(ge=8000, le=96000)
    usable_duration_ms: float = Field(ge=0)
    usable_fraction: float = Field(ge=0, le=1)
    f1_mean: float | None = Field(default=None, gt=0, le=1500)
    f2_mean: float | None = Field(default=None, gt=0, le=5000)
    target_distance: float | None = Field(default=None, ge=0)
    lip_opening_mean: float | None = None
    lip_width_mean: float | None = None
    lip_rounding_mean: float | None = None
    lip_spread_mean: float | None = None
    jaw_drop_mean: float | None = None
    vision_summary: VisionSummary | None = None
    quality_flags: list[Annotated[str, Field(max_length=64)]] = Field(max_length=32)
    evidence_fields: list[Annotated[str, Field(max_length=64)]] = Field(max_length=16)
    source: Literal["microphone", "synthetic"]
    assistance_level: Literal["guided", "reduced"] = "guided"

    @model_validator(mode="after")
    def interval(self):
        if self.capture_end_sample < self.capture_start_sample:
            raise ValueError("capture interval is reversed")
        duration = (self.capture_end_sample - self.capture_start_sample) / self.sample_rate * 1000
        if self.usable_duration_ms > duration + 1:
            raise ValueError("usable duration exceeds capture interval")
        return self


class Cue(Model):
    id: str = Field(min_length=1, max_length=80)
    version: int = Field(ge=1)
    corpus_revision: Literal[2] = 2
    text: str = Field(min_length=1, max_length=400)
    target_ids: list[TargetId]
    language: Literal["en"]
    difficulty: Literal["simple", "standard"]
    applicability: Literal["usable_capture"]
    source_url: str
    review_status: Literal["approved", "demo_unreviewed", "rejected"]
    pose_id: PoseId


class EvidenceReference(Model):
    attempt_id: UUID
    field: Literal[
        "usable_duration_ms",
        "usable_fraction",
        "target_distance",
        "f1_mean",
        "f2_mean",
        "lip_opening_mean",
        "lip_width_mean",
        "lip_rounding_mean",
        "lip_spread_mean",
        "jaw_drop_mean",
    ]
    value: float


class SupportedObservation(Model):
    id: ObservationId
    text: str
    evidence: list[EvidenceReference]


class CoachingPolicy(Model):
    version: Literal["demo-v1"] = "demo-v1"
    min_usable_duration_ms: float = Field(default=300, ge=100, le=5000)
    min_usable_fraction: float = Field(default=0.3, gt=0, le=1)
    region_distance: Literal[1] = 1
    distance_change_threshold: float = Field(default=0.1, gt=0, le=1)
    successful_attempts_to_reduce: int = Field(default=3, ge=2, le=6)
    unsuccessful_retries_to_change: int = Field(default=2, ge=2, le=5)
    history_limit: int = Field(default=8, ge=6, le=12)


class CueOutcome(Model):
    cue_id: str = Field(min_length=1, max_length=80)
    attempt_id: UUID
    target_id: TargetId
    target_version: Literal[1] = 1
    source: Literal["microphone", "synthetic"] | None = None
    distance: float | None = Field(default=None, ge=0)
    result: Literal["awaiting_retry", "improved", "no_improvement", "region_match", "inconclusive"]
    assistance_level: Literal["guided", "reduced"] = "guided"
    retry_attempt_id: UUID | None = None


class CoachingContext(Model):
    attempt_history: list[AttemptSummary] = Field(default_factory=list, max_length=12)
    cue_history: list[CueOutcome] = Field(default_factory=list, max_length=12)
    policy: CoachingPolicy = Field(default_factory=CoachingPolicy)


class CoachingRequest(Model):
    schema_version: Literal[1] = 1
    summary: AttemptSummary
    generation_id: UUID
    context: CoachingContext = Field(default_factory=CoachingContext)


class ActionOption(Model):
    action: Action
    cue_ids: list[str | None]
    rationale: str
    evidence: list[EvidenceReference] = Field(default_factory=list)


class CoachingPlan(Model):
    observations: list[SupportedObservation]
    preferred_observation_id: ObservationId
    actions: list[ActionOption]
    preferred_action: Action


class CoachingProposal(Model):
    attempt_id: UUID
    generation_id: UUID
    observation_id: ObservationId
    cue_id: str | None = Field(max_length=80)
    cue_version: int | None
    next_action: Action


class CoachingDecision(Model):
    attempt_id: UUID
    generation_id: UUID
    observation: str = Field(max_length=250)
    visual_observation: str | None = Field(default=None, max_length=250)
    evidence_fields: list[str]
    cue_id: str | None
    cue_version: int | None
    pose_id: PoseId
    next_action: Action
    narration: str | None = Field(default=None, max_length=400)
    observation_id: ObservationId | None = None
    evidence: list[EvidenceReference] = Field(default_factory=list)
    rationale: str | None = None
    policy_version: Literal["demo-v1"] = "demo-v1"
    selection_source: Literal["mock", "claude", "fallback"] = "fallback"
    policy: CoachingPolicy | None = None


class AudioManifest(Model):
    cache_key: str
    text_hash: str
    cue_id: str
    cue_version: int
    model_id: str
    voice_id: str
    language: str
    settings: dict[str, str | float | int]
    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    sample_rate: Literal[24000] = 24000
    audio_hash: str
    audio_location: str
    timings: list[dict] = Field(default_factory=list)


EventType = Literal[
    "session.state",
    "features.frame",
    "vision.frame",
    "attempt.summary",
    "coach.decision",
    "audio.start",
    "audio.end",
    "audio.cancelled",
    "provider.status",
    "error",
    "audio.timings",
    "command.ack",
    "metrics",
]


class Event(Model):
    schema_version: Literal[1] = 1
    type: EventType
    session_id: UUID
    attempt_id: UUID | None = None
    generation_id: UUID | None = None
    event_id: UUID = Field(default_factory=uuid4)
    seq: int = Field(ge=0)
    payload: dict


class Configure(Model):
    type: Literal["session.configure"]
    target_id: TargetId
    audio_enabled: bool
    assistance_level: Literal["guided", "reduced"] = "guided"


class Start(Model):
    type: Literal["attempt.start"]
    source: Literal["synthetic", "microphone"]
    sample_rate: int = Field(default=24000, ge=8000, le=96000)


class End(Model):
    type: Literal["attempt.end"]
    final_sample: int = Field(ge=0)
    vision_frames: list[VisionMetrics] = Field(default_factory=list, max_length=300)
    keyframes: list[VisionKeyframe] = Field(default_factory=list, max_length=4)


class VisionFrameCommand(Model):
    type: Literal["vision.frame"]
    frame: VisionMetrics


class Control(Model):
    type: Literal["feedback.cancel", "session.pause", "session.resume"]


class Playback(Model):
    type: Literal["audio.playback_started", "audio.playback_ended"]
    generation_id: UUID


CommandBody = Annotated[
    Configure | Start | End | VisionFrameCommand | Control | Playback, Field(discriminator="type")
]


class Command(Model):
    schema_version: Literal[1] = 1
    command_id: UUID
    expected_revision: int = Field(ge=0)
    payload: CommandBody
