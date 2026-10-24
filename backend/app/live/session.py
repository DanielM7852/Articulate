"""Therapist-led conversation sessions: in-memory state, event handling, validation, scripted fallbacks.

Deterministic events (controls, silence, retry/rest feedback) never call the model. Model turns
(intro, utterance, next-sound transition) are validated here; any failure uses the scripted line.
"""

import json
import logging
import re
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException

from app.live import llm
from app.live import talk_prompts as tp
from app.live.decision import _SHAMING, _sentences
from app.live.history import LearnerContext
from app.live.notes import miss_counts
from app.live.orchestrator import LiveDeps
from app.live.schemas import (
    AttemptFeedbackEvent,
    ControlEvent,
    SessionStartRequest,
    SessionTurn,
    SessionTurnRequest,
    SilenceEvent,
    TalkDraft,
    UtteranceEvent,
)
from app.live.targets import SOUND_CUE

logger = logging.getLogger(__name__)

SAY_MAX = 260
SAY_MAX_SENTENCES = 3
HISTORY_TURNS = 10
MAX_SESSIONS = 500
SESSION_HISTORY_ATTEMPTS = 50
TALK_MAX_TOKENS = 6000
DEFAULT_ORDER = ["i", "u", "a"]

_DIGIT = re.compile(r"\d")
_JUNK = re.compile(r"https?:|www\.|[<>{}\[\]`]", re.IGNORECASE)
# Observation claims only: "I saw/noticed/watched/(could|can) see" followed in the clause by a body or attempt word.
# Conversational "I see, good question" / "I see why you're asking" / "I see what you mean" do not match.
_OBSERVED = re.compile(
    r"\bI\s+(?:saw|see|noticed|watched|could\s+see|can\s+see)\b[^.!?]*?"
    r"\b(?:lips?|jaw|mouth|tongue|face|you(?:r)?\s+(?:were|did|made|said|tried|moved|opened|\w+ed))\b",
    re.IGNORECASE,
)
_BODY_PAST = re.compile(
    r"\byour\s+(?:lips?|jaw|mouth)\s+(?:(?!(?:is|are)\b)\w+\s+)?(?:was|were|looked|moved|stayed|did|opened|rounded|spread)\b",
    re.IGNORECASE,
)
_BODY_PRESENT = re.compile(r"\byour\s+(?:lips?|jaw|mouth)\s+(?:\w+\s+)?(?:is|are)\b", re.IGNORECASE)
_BODY_JUDGED = re.compile(
    r"\byour\s+(?:lips?|jaw|mouth)\s+(?:is|are)\s+(?:too|not|still|a\s+bit|slightly|very|quite|tight|tense|closed|wrong)\b",
    re.IGNORECASE,
)
_TARGET_FRAME = re.compile(r"\b(?:for\s+(?:ee|oo|ah)|when\s+you\s+(?:say|make))\b", re.IGNORECASE)


def _body_claim(say: str) -> bool:
    # Past/observational forms always claim; present is/are claims only without "for <sound>"/"when you say|make"
    # framing, or when followed by a judgement word ("too", "not", "tight", ...).
    if _BODY_PAST.search(say) or _OBSERVED.search(say) or _BODY_JUDGED.search(say):
        return True
    return bool(_BODY_PRESENT.search(say)) and not _TARGET_FRAME.search(say)


# Tongue rule. Any mention is rejected unless the turn shows the demo (demonstrate / next_sound), where
# instructional or present-tense descriptions of the target are allowed ("the tongue rises high at the front",
# "keep your tongue low"). Claims about what the learner's tongue did are rejected in every action:
# "your tongue" + a verb (was/is/stayed/moved/any -ed word), "I can see/saw ... tongue", and "tongue ... too ...".
_TONGUE_ANY = re.compile(r"\btongue\b", re.IGNORECASE)
_TONGUE_LEARNER_CLAIM = re.compile(
    r"(?<!keep )(?<!let )(?<!hold )(?<!make )(?<!help )\byour\s+tongue\s+(?:\w+\s+)?(?:was|were|is|are|has|had|stayed|moved|went|did|sat|touched|rose|dropped|\w+ed)\b"
    r"|\bI\s+(?:can\s+|could\s+)?(?:see|saw|noticed|watched|spotted)\b[^.!?]{0,40}\btongue\b"
    r"|\btongue\b[^.!?]{0,25}\btoo\b",
    re.IGNORECASE,
)

# Articulation facts (see talk_prompts.ARTICULATION): per sound, an articulator word and a contradicting descriptor
# in either order within one clause. Spans containing a negation ("not low") are skipped.
_SOUND_WORD = re.compile(r"\b(ee|oo|ah)\b", re.IGNORECASE)
_SOUND_KEY = {v: k for k, v in tp.SPELL.items()}
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|[:;]")
_NEGATION = re.compile(r"\bnot\b|n't\b|\bnever\b|\bno\b", re.IGNORECASE)


def _contradiction(articulator: str, bad: str) -> re.Pattern:
    gap = r"[^.!?;:,]{0,30}?"
    return re.compile(rf"\b{articulator}\b{gap}\b(?:{bad})\b|\b(?:{bad})\b{gap}\b{articulator}\b", re.IGNORECASE)


_CONTRADICTIONS = {
    "u": [_contradiction("tongue", r"low|flat|front|forward|down"), _contradiction("lips?", r"spread|smile|smiling|wide"),
          _contradiction("jaw", r"open|wide|drop\w*")],
    "i": [_contradiction("tongue", r"low|back|flat|down"), _contradiction("lips?", r"round\w*|pucker\w*|forward"),
          _contradiction("jaw", r"open|wide|drop\w*")],
    "a": [_contradiction("tongue", r"high|rais\w+|lift\w*|up"), _contradiction("jaw", r"closed|shut"),
          _contradiction("lips?", r"round\w*|pucker\w*|spread|smile|smiling")],
}


def _contradicts_articulation(say: str, default: str) -> bool:
    for sent in _SENT_SPLIT.split(say):
        marks = [(m.start(), _SOUND_KEY[m.group(1).lower()]) for m in _SOUND_WORD.finditer(sent)]
        for sound, pats in _CONTRADICTIONS.items():
            for pat in pats:
                for m in pat.finditer(sent):
                    # Sound for this clause: nearest sound named before it, else the first one after, else the draft's.
                    before = [k for pos, k in marks if pos < m.start()]
                    ref = before[-1] if before else (marks[0][1] if marks else default)
                    if ref == sound and not _NEGATION.search(sent[max(0, m.start() - 15) : m.end()]):
                        return True
    return False


@dataclass
class SessionState:
    session_id: str
    profile_id: str
    first_name: str
    plan: list[str]
    index: int = 0
    turns: deque = field(default_factory=lambda: deque(maxlen=HISTORY_TURNS))
    silence_count: int = 0
    unclear_streak: int = 0
    retries: int = 0
    rests: int = 0
    attempts: int = 0
    last_video_verdict: str | None = None
    ended: bool = False
    last_used: float = 0.0

    @property
    def sound(self) -> str:
        return self.plan[self.index]

    @property
    def next_sound(self) -> str | None:
        return self.plan[self.index + 1] if self.index + 1 < len(self.plan) else None


class SessionStore:
    def __init__(self, ttl_s: float, clock=time.monotonic) -> None:
        self.ttl_s = ttl_s
        self._clock = clock
        self._items: dict[str, SessionState] = {}

    def _purge(self) -> None:
        now = self._clock()
        for key in [k for k, v in self._items.items() if now - v.last_used > self.ttl_s]:
            del self._items[key]

    def add(self, state: SessionState) -> None:
        self._purge()
        while len(self._items) >= MAX_SESSIONS:
            oldest = min(self._items, key=lambda k: self._items[k].last_used)
            del self._items[oldest]
        state.last_used = self._clock()
        self._items[state.session_id] = state

    def get(self, session_id: str, profile_id: str) -> SessionState:
        self._purge()
        state = self._items.get(session_id)
        if state is None:
            raise HTTPException(status_code=404, detail="session_not_found")
        if state.profile_id != profile_id:
            raise HTTPException(status_code=403, detail="profile_mismatch")
        state.last_used = self._clock()
        return state


def get_store(deps: LiveDeps, app) -> SessionStore:
    store = getattr(app.state, "live_sessions", None)
    if store is None:
        store = SessionStore(deps.settings.live_session_ttl_s)
        app.state.live_sessions = store
    return store


# ---- helpers ----


def first_name(display_name: str) -> str:
    cleaned = re.sub(r"[^\w'\-]", " ", display_name, flags=re.UNICODE)
    parts = cleaned.split()
    return parts[0][:30] if parts else ""


def build_plan(requested: list[str] | None, context: LearnerContext) -> list[str]:
    if requested:
        return list(dict.fromkeys(requested))
    counts = miss_counts(context.attempts)
    return sorted(DEFAULT_ORDER, key=lambda s: (-counts.get(s, (0, None))[0], DEFAULT_ORDER.index(s)))


def _turn(
    state: SessionState, say: str, action: str, sound: str, source: str, started: float, llm_ms: int = 0
) -> SessionTurn:
    show = action in ("demonstrate", "next_sound")
    state.turns.append(("therapist", say))
    if action == "end_session":
        state.ended = True
    return SessionTurn(
        sessionId=state.session_id,
        say=say,
        action=action,
        sound=sound,
        cueId=SOUND_CUE[sound] if show else None,
        showSideView=show,
        source=source,
        timingsMs={"llm": llm_ms, "total": int((time.perf_counter() - started) * 1000)},
    )


def _payload(state: SessionState, mode: str, deps: LiveDeps, **extra: Any) -> str:
    data: dict[str, Any] = {
        "mode": mode,
        "therapistName": deps.settings.live_therapist_name,
        "learner": {"firstName": state.first_name},
        "plan": [f"{tp.SPELL[s]} ({s})" for s in state.plan],
        "currentSound": state.sound,
        "nextSound": state.next_sound,
        "previousWasUnclear": state.unclear_streak > 0,
        "recentTurns": [{"role": r, "text": t} for r, t in state.turns],
    }
    data.update(extra)
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def validate_draft(
    draft: TalkDraft,
    state: SessionState,
    *,
    allowed_actions: set[str],
    must_sound: str | None,
    must_mention: list[str] | None = None,
) -> None:
    """Raise ValueError on any rule violation."""
    say = draft.say.strip()
    if not say or len(say) > SAY_MAX or _sentences(say) > SAY_MAX_SENTENCES:
        raise ValueError("say_length")
    if _DIGIT.search(say) or _JUNK.search(say):
        raise ValueError("say_chars")
    if _SHAMING.search(say):
        raise ValueError("shaming")
    if _TONGUE_ANY.search(say):
        if _TONGUE_LEARNER_CLAIM.search(say):
            raise ValueError("tongue_claim")
        if draft.action not in ("demonstrate", "next_sound"):
            raise ValueError("tongue_outside_demo")
    if _contradicts_articulation(say, draft.sound):
        raise ValueError("articulation_contradiction")
    if state.last_video_verdict in (None, "insufficient") and _body_claim(say):
        raise ValueError("body_claim")
    if draft.sound not in state.plan:
        raise ValueError("sound_not_in_plan")
    if must_sound is not None and draft.sound != must_sound:
        raise ValueError("unexpected_sound")
    if draft.cueId not in (None, SOUND_CUE[draft.sound]):
        raise ValueError("cue_mismatch")
    if draft.action not in allowed_actions:
        raise ValueError("action_not_allowed")
    lowered = say.lower()
    for needle in must_mention or []:
        if needle and needle.lower() not in lowered:
            raise ValueError("missing_required_mention")


async def _ask(deps: LiveDeps, payload: str) -> tuple[TalkDraft | None, int]:
    if not deps.model_available:
        return None, 0
    s = deps.settings
    t0 = time.perf_counter()
    try:
        draft = await llm.ask(
            s,
            deps.anthropic_client,
            tp.TALK_SYSTEM.format(therapist=s.live_therapist_name),
            payload,
            TalkDraft,
            s.live_talk_effort,
            s.live_coach_timeout_s,
            TALK_MAX_TOKENS,
            model=s.live_coach_model,
            thinking=s.live_coach_thinking,
        )
        return draft, int((time.perf_counter() - t0) * 1000)
    except Exception as exc:  # noqa: BLE001
        logger.warning("talk turn used fallback: %s", type(exc).__name__)
        return None, int((time.perf_counter() - t0) * 1000)


def _heuristic_intent(text: str) -> str:
    t = text.lower().strip()
    if len(re.sub(r"[^a-z]", "", t)) < 2:
        return "unclear"
    if re.search(r"\b(stop|quit|end|finish|done|enough|bye)\b", t):
        return "stop"
    if re.search(r"\b(skip|next|move on|different)\b", t):
        return "skip"
    if re.search(r"\b(again|show|demo|demonstrate|repeat)\b", t):
        return "request_demo"
    if "?" in t or re.match(r"(what|why|how|can|could|is|do|does|where|when)\b", t):
        return "question"
    if re.search(r"\b(ready|yes|yeah|ok|okay|sure|go|start|lets|let's)\b", t):
        return "ready"
    return "smalltalk"


# ---- start ----


async def start_session(deps: LiveDeps, store: SessionStore, req: SessionStartRequest) -> SessionTurn:
    started = time.perf_counter()
    try:
        context = await deps.get_history().load(req.profileId, SESSION_HISTORY_ATTEMPTS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("session history load failed: %s", type(exc).__name__)
        context = LearnerContext()
    state = SessionState(
        session_id=str(uuid.uuid4()),
        profile_id=req.profileId,
        first_name=first_name(req.displayName),
        plan=build_plan(req.sounds, context),
    )
    therapist = deps.settings.live_therapist_name
    say, source = tp.intro_line(state.first_name, therapist, state.plan), "fallback"
    struggles = [{"sound": s, "misses": c} for s, (c, _) in miss_counts(context.attempts).items()]
    draft, llm_ms = await _ask(deps, _payload(state, "intro", deps, struggles=struggles))
    if draft is not None:
        try:
            validate_draft(
                draft,
                state,
                allowed_actions={"demonstrate"},
                must_sound=state.plan[0],
                must_mention=[therapist, state.first_name],
            )
            say, source = draft.say.strip(), "agent"
        except ValueError as exc:
            logger.warning("intro draft rejected: %s", exc)
            logger.debug("rejected intro say: %r", draft.say)
    store.add(state)
    return _turn(state, say, "demonstrate", state.sound, source, started, llm_ms)


# ---- turns ----


def _advance(state: SessionState) -> None:
    state.index += 1
    state.retries = 0
    state.silence_count = 0


async def take_turn(deps: LiveDeps, store: SessionStore, req: SessionTurnRequest) -> SessionTurn:
    started = time.perf_counter()
    state = store.get(req.sessionId, req.profileId)
    event = req.event
    current = getattr(event, "currentSound", None)
    if current in state.plan:
        state.index = state.plan.index(current)
    if isinstance(event, SilenceEvent):
        return _silence(state, started)
    state.silence_count = 0
    if isinstance(event, ControlEvent):
        return _control(state, event, started)
    if isinstance(event, AttemptFeedbackEvent):
        return await _feedback(deps, state, event, started)
    return await _utterance(deps, state, event, started)


def _silence(state: SessionState, started: float) -> SessionTurn:
    state.silence_count += 1
    if state.silence_count == 1:
        return _turn(state, tp.nudge_line(), "prompt_attempt", state.sound, "scripted", started)
    if state.silence_count == 2:
        return _turn(state, tp.offer_line(), "await_reply", state.sound, "scripted", started)
    state.silence_count = 0
    return _turn(state, tp.demo_line(state.sound, again=True), "demonstrate", state.sound, "scripted", started)


def _skip_or_end(state: SessionState, started: float) -> SessionTurn:
    nxt = state.next_sound
    if nxt is None:
        return _turn(state, tp.close_line(), "end_session", state.sound, "scripted", started)
    _advance(state)
    return _turn(state, tp.skip_line(nxt), "next_sound", nxt, "scripted", started)


def _control(state: SessionState, event: ControlEvent, started: float) -> SessionTurn:
    state.unclear_streak = 0
    if event.control == "ready":
        return _turn(state, tp.READY_LINE, "prompt_attempt", state.sound, "scripted", started)
    if event.control == "show_again":
        return _turn(state, tp.demo_line(state.sound, again=True), "demonstrate", state.sound, "scripted", started)
    if event.control == "skip":
        return _skip_or_end(state, started)
    return _turn(state, tp.close_line(), "end_session", state.sound, "scripted", started)


async def _feedback(deps: LiveDeps, state: SessionState, event: AttemptFeedbackEvent, started: float) -> SessionTurn:
    state.unclear_streak = 0
    state.attempts += 1
    state.last_video_verdict = event.coach.videoVerdict
    action = event.coach.nextAction
    if action == "retry":
        state.retries += 1
        return _turn(state, tp.retry_line(state.retries - 1), "prompt_attempt", state.sound, "scripted", started)
    nxt = state.next_sound
    if action == "rest":
        state.rests += 1
        if nxt is None:
            return _turn(state, tp.rest_line(None), "end_session", state.sound, "scripted", started)
        _advance(state)
        return _turn(state, tp.rest_line(nxt), "next_sound", nxt, "scripted", started)
    # coach says the sound is done: move on, with a natural model-written transition
    if nxt is None:
        return _turn(state, tp.close_line(), "end_session", state.sound, "scripted", started)
    draft, llm_ms = await _ask(deps, _payload(state, "transition", deps, nextSound=nxt))
    say, source = tp.transition_line(nxt), ("fallback" if deps.model_available else "scripted")
    if draft is not None:
        try:
            validate_draft(draft, state, allowed_actions={"next_sound", "demonstrate"}, must_sound=nxt)
            say, source = draft.say.strip(), "agent"
        except ValueError as exc:
            logger.warning("transition draft rejected: %s", exc)
            logger.debug("rejected transition say: %r", draft.say)
    _advance(state)
    return _turn(state, say, "next_sound", nxt, source, started, llm_ms)


async def _utterance(deps: LiveDeps, state: SessionState, event: UtteranceEvent, started: float) -> SessionTurn:
    text = event.text.strip()
    state.turns.append(("learner", text))
    draft, llm_ms = await _ask(deps, _payload(state, "utterance", deps, learnerUtterance=text))
    say: str | None = None
    intent: str | None = None
    if draft is not None:
        try:
            validate_draft(
                draft,
                state,
                allowed_actions={"demonstrate", "prompt_attempt", "await_reply", "next_sound", "end_session"},
                must_sound=state.sound,
            )
            say, intent = draft.say.strip(), draft.intent
        except ValueError as exc:
            logger.warning("utterance draft rejected: %s", exc)
            logger.debug("rejected utterance say: %r", draft.say)
    if say is not None and _TONGUE_ANY.search(say) and intent != "request_demo":
        say, intent = None, draft.intent if draft is not None else None  # tongue talk only fits a demonstration turn
    source = "agent" if say is not None else "fallback"
    if intent is None:
        intent = _heuristic_intent(text)
    sound = state.sound

    if intent == "unclear":
        streak = state.unclear_streak
        state.unclear_streak += 1
        if streak >= 1 or say is None:
            say, source = tp.unclear_line(streak), ("scripted" if streak >= 1 else "fallback")
        return _turn(state, say, "prompt_attempt", sound, source, started, llm_ms)
    state.unclear_streak = 0

    if intent == "stop":
        return _turn(state, say or tp.STOP_LINE, "end_session", sound, source, started, llm_ms)
    if intent == "skip":
        nxt = state.next_sound
        if nxt is None:
            return _turn(state, tp.close_line(), "end_session", sound, "scripted", started, llm_ms)
        _advance(state)
        return _turn(state, tp.skip_line(nxt), "next_sound", nxt, "scripted", started, llm_ms)
    if intent == "request_demo":
        return _turn(state, say or tp.demo_line(sound, again=True), "demonstrate", sound, source, started, llm_ms)
    if intent == "ready":
        return _turn(state, say or tp.READY_LINE, "prompt_attempt", sound, source, started, llm_ms)
    if intent == "question":
        return _turn(state, say or tp.QUESTION_FALLBACK, "await_reply", sound, source, started, llm_ms)
    return _turn(state, say or tp.SMALLTALK_FALLBACK, "prompt_attempt", sound, source, started, llm_ms)
