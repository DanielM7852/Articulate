"""Wire models for /v1/live/*. Field names are the contract with the web client."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SoundId = Literal["i", "u", "a"]
CueId = Literal["round-lips", "spread-lips", "open-jaw"]
NextAction = Literal["retry", "next_sound", "rest"]
AudioVerdict = Literal["on_target", "close", "off", "insufficient"]
VideoVerdict = Literal["matches", "partly", "mismatch", "insufficient"]

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
PROFILE_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,64}$")


def valid_profile_id(value: str) -> bool:
    return bool(PROFILE_RE.fullmatch(value))


def valid_attempt_id(value: str) -> bool:
    return bool(UUID_RE.fullmatch(value))


class AudioFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")

    t: float
    f1: float | None = None
    f2: float | None = None
    conf: float | None = None
    rms: float = 0.0
    valid: bool = False
    reason: str | None = None


class LipFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")

    t: float
    ok: bool = False
    flags: list[str] = Field(default_factory=list)
    lipOpening: float | None = None
    outerLipHeight: float | None = None
    lipWidth: float | None = None
    lipAspectRatio: float | None = None
    lipProtrusionZ: float | None = None
    jawDrop: float | None = None
    mouthSymmetry: float | None = None
    innerMouthArea: float | None = None
    rounding: float | None = None
    spread: float | None = None
    openness: float | None = None
    yawDeg: float | None = None
    pitchDeg: float | None = None
    rollDeg: float | None = None


class Frames(BaseModel):
    model_config = ConfigDict(extra="ignore")

    audio: list[AudioFrame] = Field(default_factory=list, max_length=1500)
    video: list[LipFrame] = Field(default_factory=list, max_length=600)


class ClientSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    durationSec: float
    usableVoicedSec: float
    timeInTargetSec: float | None = None
    longestHoldSec: float | None = None
    quality: str = Field(max_length=40)
    qualityReason: str | None = Field(default=None, max_length=80)


class LiveCoachRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    attemptId: str
    profileId: str
    sound: SoundId
    metricsSource: Literal["spacetimedb", "inline"]
    clientSummary: ClientSummary
    frames: Frames | None = None

    @field_validator("attemptId")
    @classmethod
    def _attempt(cls, value: str) -> str:
        if not valid_attempt_id(value):
            raise ValueError("attemptId must be a UUID")
        return value

    @field_validator("profileId")
    @classmethod
    def _profile(cls, value: str) -> str:
        if not valid_profile_id(value):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return value


class AudioScore(BaseModel):
    frames: int
    voicedFrames: int
    f1Median: float | None = None
    f2Median: float | None = None
    inTargetFraction: float = 0.0
    f1Offset: float | None = None
    f2Offset: float | None = None
    spread: float | None = None
    verdict: AudioVerdict


class VideoScore(BaseModel):
    frames: int
    usableFrames: int
    roundingMean: float | None = None
    spreadMean: float | None = None
    opennessMean: float | None = None
    lipOpeningMean: float | None = None
    jawDropMean: float | None = None
    expectation: str
    verdict: VideoVerdict


class EvidenceItem(BaseModel):
    field: str
    value: float | str


class LiveCoachResponse(BaseModel):
    attemptId: str
    source: Literal["agent", "fallback"]
    metricsSource: Literal["spacetimedb", "inline", "none"]
    audio: AudioScore
    video: VideoScore | None = None
    observation: str
    caption: str
    cueId: CueId | None = None
    showSideView: bool
    nextAction: NextAction
    evidence: list[EvidenceItem]
    persisted: bool = False


class CoachDecision(BaseModel):
    """What the model may choose. Evidence values are filled in by the server."""

    model_config = ConfigDict(extra="forbid")

    observation: str = Field(min_length=1, max_length=600)
    caption: str = Field(min_length=1, max_length=600)
    cueId: CueId | None = None
    nextAction: NextAction
    evidenceFields: list[str] = Field(default_factory=list, max_length=12)


class NotesRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    profileId: str

    @field_validator("profileId")
    @classmethod
    def _profile(cls, value: str) -> str:
        if not valid_profile_id(value):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return value


class Struggle(BaseModel):
    sound: SoundId
    pattern: str = Field(max_length=120)
    count: int = Field(ge=0)
    lastAttemptId: str | None = None


class NotesDraft(BaseModel):
    """Model output for the notes update."""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=400)
    struggles: list[Struggle] = Field(default_factory=list, max_length=6)
    habits: list[str] = Field(default_factory=list, max_length=6)


class LearnerNotes(BaseModel):
    profileId: str
    summary: str = Field(max_length=400)
    struggles: list[Struggle] = Field(default_factory=list, max_length=6)
    habits: list[str] = Field(default_factory=list, max_length=6)
    attemptsConsidered: int = 0
    source: Literal["agent", "fallback"]
    persisted: bool = False
