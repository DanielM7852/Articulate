"""Wire models for /v1/live/*. Field names are the contract with the web client."""

import math
import re
from typing import Annotated, Literal

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


ZoneKind = Literal["vowel", "tuner", "stop"]
ZoneVerdict = Literal["hit", "partial", "miss", "skipped"]
ZONE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
EVIDENCE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,39}$")


class WordZoneResult(BaseModel):
    """One zone of a word attempt. Mirrors ZoneResult in web/src/game/types.ts."""

    model_config = ConfigDict(extra="ignore")

    zoneId: str
    phoneme: str = Field(min_length=1, max_length=8)
    kind: ZoneKind
    verdict: ZoneVerdict
    dwellMs: float = Field(ge=0, le=60_000)
    startMs: float | None = None
    endMs: float | None = None
    evidence: dict[str, float] = Field(default_factory=dict, max_length=24)

    @field_validator("zoneId")
    @classmethod
    def _zone(cls, value: str) -> str:
        if not ZONE_ID_RE.fullmatch(value):
            raise ValueError("zoneId must match [A-Za-z0-9_-]{1,16}")
        return value

    @field_validator("evidence")
    @classmethod
    def _evidence(cls, value: dict[str, float]) -> dict[str, float]:
        # Keys become evidence field names (word.<zoneId>.<key>); non-finite values are dropped.
        if any(not EVIDENCE_KEY_RE.fullmatch(k) for k in value):
            raise ValueError("evidence keys must be short camelCase names")
        return {k: v for k, v in value.items() if math.isfinite(v)}


class WordAttempt(BaseModel):
    """A finished word attempt from the board. Mirrors WordAttemptResult in web/src/game/types.ts."""

    model_config = ConfigDict(extra="ignore")

    word: str = Field(min_length=1, max_length=32)
    attemptId: str = Field(min_length=1, max_length=80)
    durationMs: float = Field(ge=0, le=120_000)
    zones: list[WordZoneResult] = Field(min_length=1, max_length=12)
    quality: Literal["usable", "unclear"]
    qualityReason: Literal["silence", "clipped", "too-short", "no-voice"] | None = None
    lipUsable: bool = False

    @field_validator("zones")
    @classmethod
    def _unique(cls, value: list[WordZoneResult]) -> list[WordZoneResult]:
        ids = [z.zoneId for z in value]
        if len(set(ids)) != len(ids):
            raise ValueError("zone ids must be unique")
        return value


WordVerdict = Literal["on_target", "close", "off", "insufficient"]


class WordScore(BaseModel):
    """Server-side roll-up of a word attempt. Zone verdicts come from the board unchanged."""

    word: str
    verdict: WordVerdict
    zoneCount: int
    hitCount: int
    weakestZoneId: str | None = None
    zones: list[WordZoneResult]
    lipUsable: bool


class LiveCoachRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    attemptId: str
    profileId: str
    # Word mode still sends a sound (the word's vowel, "a" for track) so stored history keeps its shape.
    sound: SoundId
    metricsSource: Literal["spacetimedb", "inline"]
    clientSummary: ClientSummary
    frames: Frames | None = None
    # Present: coach this word attempt (word mode). Absent: the vowel path, unchanged.
    word: WordAttempt | None = None

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
    persisted: bool | None = None  # None: queued in the background
    model: str | None = None
    timingsMs: dict[str, int] | None = None
    # Word mode only.
    word: WordScore | None = None
    focusZoneId: str | None = None


class CoachDecision(BaseModel):
    """What the model may choose. Evidence values are filled in by the server."""

    model_config = ConfigDict(extra="forbid")

    observation: str = Field(min_length=1, max_length=600)
    caption: str = Field(min_length=1, max_length=600)
    cueId: CueId | None = None
    nextAction: NextAction
    evidenceFields: list[str] = Field(default_factory=list, max_length=12)
    # Word mode: the zone the caption coaches; must be one of the attempt's zone ids. Ignored for vowels.
    focusZoneId: str | None = Field(default=None, max_length=16)


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


# ---- Therapist-led conversation sessions (/v1/live/session/*) ----

TalkAction = Literal["demonstrate", "prompt_attempt", "await_reply", "next_sound", "end_session"]
TalkIntent = Literal["question", "request_demo", "ready", "skip", "stop", "smalltalk", "unclear"]
TurnSource = Literal["agent", "fallback", "scripted"]
ControlName = Literal["ready", "show_again", "skip", "end"]


class SessionStartRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    profileId: str
    displayName: str = Field(max_length=80)
    sounds: list[SoundId] | None = Field(default=None, min_length=1, max_length=3)

    @field_validator("profileId")
    @classmethod
    def _profile(cls, value: str) -> str:
        if not valid_profile_id(value):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return value


class CoachSummaryEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    caption: str = Field(max_length=600)
    cueId: CueId | None = None
    nextAction: NextAction
    audioVerdict: AudioVerdict
    videoVerdict: VideoVerdict | None = None


class UtteranceEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["utterance"]
    text: str = Field(max_length=300)  # STT transcript: untrusted
    currentSound: SoundId


class AttemptFeedbackEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["attempt_feedback"]
    attemptId: str
    currentSound: SoundId
    coach: CoachSummaryEvent

    @field_validator("attemptId")
    @classmethod
    def _attempt(cls, value: str) -> str:
        if not valid_attempt_id(value):
            raise ValueError("attemptId must be a UUID")
        return value


class ControlEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["control"]
    control: ControlName


class SilenceEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["silence"]
    seconds: float = Field(ge=0, le=3600)


class AnalysisReadyEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["analysis_ready"]
    attemptId: str
    currentSound: SoundId

    @field_validator("attemptId")
    @classmethod
    def _attempt(cls, value: str) -> str:
        if not valid_attempt_id(value):
            raise ValueError("attemptId must be a UUID")
        return value


TalkEvent = Annotated[
    UtteranceEvent | AttemptFeedbackEvent | ControlEvent | SilenceEvent | AnalysisReadyEvent,
    Field(discriminator="kind"),
]


class SessionTurnRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    sessionId: str
    profileId: str
    event: TalkEvent
    expectedRevision: int | None = Field(default=None, ge=1)

    @field_validator("sessionId")
    @classmethod
    def _session(cls, value: str) -> str:
        if not valid_attempt_id(value):
            raise ValueError("sessionId must be a UUID")
        return value

    @field_validator("profileId")
    @classmethod
    def _profile(cls, value: str) -> str:
        if not valid_profile_id(value):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return value


class SessionTurn(BaseModel):
    sessionId: str
    say: str = Field(max_length=260)
    action: TalkAction
    sound: SoundId
    cueId: CueId | None = None
    showSideView: bool = False
    source: TurnSource
    timingsMs: dict[str, int] | None = None
    revision: int | None = None


class TalkDraft(BaseModel):
    """Model output for one conversation turn. Code validates it and decides the final action."""

    model_config = ConfigDict(extra="forbid")

    say: str = Field(min_length=1, max_length=600)
    action: TalkAction
    sound: SoundId
    cueId: CueId | None = None
    showSideView: bool = False
    intent: TalkIntent | None = None


class WordAskCoaching(BaseModel):
    model_config = ConfigDict(extra="ignore")

    caption: str = Field(max_length=600)
    focusZoneId: str | None = Field(default=None, max_length=16)


class WordAskAttempt(BaseModel):
    model_config = ConfigDict(extra="ignore")

    verdict: str | None = Field(default=None, max_length=32)
    hitCount: int | None = None
    zoneCount: int | None = None
    weakestZoneId: str | None = Field(default=None, max_length=16)


class WordAskRequest(BaseModel):
    """A learner's question about the word lesson, relayed by Ava's ask_coach tool."""

    model_config = ConfigDict(extra="ignore")

    profileId: str
    word: str = Field(min_length=1, max_length=32)
    question: str = Field(min_length=1, max_length=500)
    lastCoaching: WordAskCoaching | None = None
    lastAttempt: WordAskAttempt | None = None
    tries: int = Field(default=0, ge=0, le=10000)

    @field_validator("profileId")
    @classmethod
    def _profile(cls, value: str) -> str:
        if not valid_profile_id(value):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return value


class WordAskResponse(BaseModel):
    say: str
    source: Literal["model", "fallback"]


class WordAskDraft(BaseModel):
    """Model output for one answer. Code validates it."""

    model_config = ConfigDict(extra="forbid")

    say: str = Field(min_length=1, max_length=600)
