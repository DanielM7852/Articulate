"""Post-session recap: one Claude call turns this session and past totals into summary, habits and exercises; email.

Runs in-process as a background task in every coordination mode (beta). Recaps live in a small in-memory store.
Model output is untrusted: text is clamped and stripped of links.
"""

import asyncio
import html
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import Settings
from app.live import llm
from app.live.notes import SOUND_SPELLING
from app.live.schemas import valid_profile_id

logger = logging.getLogger(__name__)

RECAP_TTL_S = 6 * 3600.0
RECAP_MAX = 500
HISTORY_LIMIT = 200
HISTORY_RETRY_DELAY_S = 2.0  # the coach record may persist a moment after the lesson ends
MAX_FIELD = 300
MAX_SUMMARY = 600
CALL_TIMEOUT_S = 120.0  # the single Claude call; LIVE_RECAP_TIMEOUT_S caps the whole recap
RECAP_MAX_TOKENS = 16000  # adaptive thinking counts against max_tokens
MAX_PENDING_PER_PROFILE = 1
MAX_STARTS_PER_HOUR = 10
EMAIL_RE = re.compile(r"^[^@\s<>\"',;()\[\]\\]{1,64}@[^@\s<>\"',;()\[\]\\]{1,190}\.[^@\s<>\"',;()\[\]\\]{2,24}$")
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z' -]{0,39}$")
TOKEN_RE = re.compile(r"^[A-Za-z]{1,6}$")
_VERDICTS = {"on_target", "close", "off", "insufficient", "matches", "partly", "mismatch", "hit", "partial", "miss",
             "skipped"}
_ZONE_KINDS = {"vowel", "tuner", "stop", "liquid", "fricative", "nasal"}

RecapState = Literal["pending", "ready", "failed", "empty"]
EmailState = Literal["none", "queued", "sent", "failed", "not_configured"]


# ---- wire models (camelCase is the contract with the web client) ----

class RecapRequest(BaseModel):
    profileId: str
    attemptIds: list[str] = Field(min_length=1, max_length=200)
    word: str | None = Field(default=None, max_length=60)
    email: str | None = Field(default=None, max_length=254)

    @field_validator("profileId")
    @classmethod
    def _profile(cls, v: str) -> str:
        if not valid_profile_id(v):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return v

    @field_validator("attemptIds")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        if any(not i or len(i) > 64 for i in v):
            raise ValueError("each attemptId must be 1-64 characters")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        return _check_email(v) if v else None


class RecapEmailRequest(BaseModel):
    profileId: str
    email: str = Field(max_length=254)

    @field_validator("profileId")
    @classmethod
    def _profile(cls, v: str) -> str:
        if not valid_profile_id(v):
            raise ValueError("profileId must match [A-Za-z0-9_.:@-]{1,64}")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _check_email(v)


def _check_email(value: str) -> str:
    value = value.strip()
    if not EMAIL_RE.fullmatch(value):
        raise ValueError("invalid email address")
    return value


class FocusArea(BaseModel):
    part: str
    whatHappened: str
    trend: Literal["improving", "same", "new", "harder"]


class Habit(BaseModel):
    title: str
    when: str
    how: str
    minutes: int = Field(ge=1, le=15)


class Exercise(BaseModel):
    title: str
    targets: str
    steps: list[str] = Field(min_length=1, max_length=5)
    reps: str


class Recap(BaseModel):
    headline: str
    summary: str
    wins: list[str] = Field(default_factory=list, max_length=3)
    focusAreas: list[FocusArea] = Field(default_factory=list, max_length=3)
    habits: list[Habit] = Field(default_factory=list, max_length=3)
    exercises: list[Exercise] = Field(default_factory=list, max_length=4)
    sessionAttempts: int = 0


class RecapStatus(BaseModel):
    recapId: str
    status: RecapState
    recap: Recap | None = None
    error: str | None = None
    emailStatus: EmailState = "none"
    emailTo: str | None = None


# ---- model output drafts (loose; clamped by code) ----

class FocusDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part: str
    whatHappened: str
    trend: Literal["improving", "same", "new", "harder"]


class HabitDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    when: str
    how: str
    minutes: int


class ExerciseDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    targets: str
    steps: list[str]
    reps: str


class RecapDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    headline: str
    summary: str
    wins: list[str]
    focusAreas: list[FocusDraft]
    habits: list[HabitDraft]
    exercises: list[ExerciseDraft]


# ---- prompts ----

_TONE = (
    "The learner is deaf or hard of hearing and is practising speech sounds. Be kind and encouraging, never shaming. "
    "Use plain everyday words and short sentences. Do not mention hearing or sound quality as something to 'listen' for. "
    "Use only facts in the user message; never invent scores, counts or diagnoses. Never include links or markdown."
)

RECAP_SYSTEM = f"""You write a practice recap after a word lesson (one or more words), with small daily habits and exercises.
{_TONE}
You receive this session's attempts (session) and the learner's earlier practice as totals (past), plus saved coach notes.
- headline: at most 80 characters, friendly, about this session.
- pastTotals.words counts every earlier try of each word (clearTries: clear enough to check; onTarget: fully right).
  pastTotals.parts counts only clear tries. Something is "new" only if it has no earlier tries at all.
- summary: 2-4 short sentences. Say what went well, then what is still tricky, weighing THIS session against past sessions.
- wins: up to 3 short, specific things that went well (empty if nothing yet).
- focusAreas: up to 3 parts that need work. part names a sound or part of the word (for example "the ck in track").
  whatHappened is one plain sentence. trend: improving (better than past), same, new (no earlier practice), harder (worse than past).
- habits: exactly 3 short habits, small moments in the learner's day. Each has title, when (a daily moment, like "after
  breakfast"), how (one or two plain sentences) and minutes (1 to 15).
- exercises: 2 to 4 practice exercises aimed at the focus areas. Each has title, targets (the sound or part), steps (1 to 5
  short steps) and reps (like "3 rounds of 5"). Use your own knowledge of speech practice.
- Use visual and touch cues rather than listening: a mirror, a hand in front of the mouth to feel air, a finger on the
  throat to feel voicing. Keep everything practical and safe, and make no medical claims."""


# ---- sanitising ----

_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_SPACE = re.compile(r"\s+")


def clean_text(value: Any, limit: int = MAX_FIELD) -> str:
    text = _MD_LINK.sub(r"\1", value if isinstance(value, str) else "")
    text = _SPACE.sub(" ", _URL.sub("", text)).strip()
    return text[:limit].rstrip()


def _clean_list(values: Any, limit: int, item_limit: int = MAX_FIELD) -> list[str]:
    out = [clean_text(v, item_limit) for v in values] if isinstance(values, list) else []
    return [v for v in out if v][:limit]


@dataclass
class _Entry:
    recap_id: str
    profile_id: str
    key: tuple[str, frozenset[str]]
    created: float
    status: RecapState = "pending"
    recap: Recap | None = None
    error: str | None = None
    email: str | None = None
    email_status: EmailState = "none"
    sending: bool = False

    def view(self) -> RecapStatus:
        return RecapStatus(recapId=self.recap_id, status=self.status, recap=self.recap, error=self.error,
                           emailStatus=self.email_status, emailTo=self.email)


# ---- history -> model input ----

def _enum(value: Any, allowed: set[str]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _zone_label(word: str | None, zone: dict[str, Any]) -> str | None:
    phoneme = zone.get("phoneme")
    if not isinstance(phoneme, str) or not TOKEN_RE.fullmatch(phoneme):
        return None
    kind = _enum(zone.get("kind"), _ZONE_KINDS) or "sound"
    where = f" in {word}" if word else ""
    return f"the {phoneme} ({kind}){where}"


def _word_of(attempt: dict[str, Any]) -> str | None:
    w = attempt.get("word")
    return w.strip().lower() if isinstance(w, str) and WORD_RE.fullmatch(w.strip()) else None


def _session_item(attempt: dict[str, Any]) -> dict[str, Any]:
    """Whitelisted view of one turn. Free-text fields (caption, clientSummary, ...) never reach the model."""
    if attempt.get("kind") == "word":
        word = _word_of(attempt)
        zones = []
        for z in attempt.get("zones") or []:
            if not isinstance(z, dict) or _enum(z.get("verdict"), _VERDICTS) is None:
                continue
            label = _zone_label(word, z)
            if label:
                zones.append({"part": label, "verdict": z["verdict"], "countsTowardResult": not z.get("advisory")})
        return {"kind": "word", "word": word, "verdict": _enum(attempt.get("verdict"), _VERDICTS),
                "usable": attempt.get("quality") == "usable", "parts": zones[:12]}
    fraction = attempt.get("inTargetFraction")
    return {"kind": "sound", "sound": SOUND_SPELLING.get(attempt.get("sound")),
            "audioVerdict": _enum(attempt.get("audioVerdict"), _VERDICTS),
            "mouthVerdict": _enum(attempt.get("videoVerdict"), _VERDICTS),
            "inTargetFraction": round(fraction, 2) if isinstance(fraction, (int, float)) else None}


def _past_totals(past: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, int]]]:
    parts: dict[str, dict[str, int]] = {}
    words: dict[str, dict[str, int]] = {}

    def bump(table: dict[str, dict[str, int]], key: str, hit: bool) -> None:
        row = table.setdefault(key, {"tries": 0, "onTarget": 0})
        row["tries"] += 1
        row["onTarget"] += int(hit)

    for a in past:
        if a.get("kind") == "word":
            word = _word_of(a)
            usable = a.get("quality") == "usable"
            if word:  # every earlier try counts as practice, clear or not
                row = words.setdefault(word, {"tries": 0, "clearTries": 0, "onTarget": 0})
                row["tries"] += 1
                row["clearTries"] += int(usable)
                row["onTarget"] += int(usable and a.get("verdict") == "on_target")
            if not usable:
                continue
            for z in a.get("zones") or []:
                if isinstance(z, dict) and z.get("verdict") in ("hit", "partial", "miss") and not z.get("advisory"):
                    label = _zone_label(None, z)
                    if label:
                        bump(parts, label, z["verdict"] == "hit")
        elif a.get("audioVerdict") in ("on_target", "close", "off"):
            name = SOUND_SPELLING.get(a.get("sound"))
            if name:
                bump(parts, f"the {name} sound", a["audioVerdict"] == "on_target")
    return {"parts": dict(list(parts.items())[:20]), "words": dict(list(words.items())[:20])}


def _past_notes(notes: Any) -> dict[str, Any] | None:
    if not isinstance(notes, dict):
        return None
    struggles = [clean_text(s.get("pattern"), 120) for s in notes.get("struggles") or [] if isinstance(s, dict)]
    out = {"summary": clean_text(notes.get("summary"), 400), "struggles": [s for s in struggles if s][:6]}
    return out if out["summary"] or out["struggles"] else None


def build_prompt(session: list[dict], past: list[dict], notes: Any, word: str | None,
                         words: list[str] | None = None) -> str:
    ordered = list(reversed(session))  # history is newest first; the model reads the session in order
    payload: dict[str, Any] = {"word": word}
    if words:
        payload["words"] = words
    payload.update({
        "session": [_session_item(a) for a in ordered],
        "pastTotals": _past_totals(past),
        "pastNotes": _past_notes(notes),
    })
    return json.dumps(payload, ensure_ascii=False)


# ---- validation ----

def build_recap(draft: RecapDraft, session_attempts: int) -> Recap:
    habits = []
    for h in draft.habits:
        title, when, how = clean_text(h.title, 100), clean_text(h.when, 100), clean_text(h.how)
        if title and how:
            habits.append(Habit(title=title, when=when, how=how, minutes=max(1, min(15, int(h.minutes)))))
        if len(habits) == 3:
            break
    exercises = []
    for e in draft.exercises:
        title, steps = clean_text(e.title, 100), _clean_list(e.steps, 5)
        if title and steps:
            exercises.append(Exercise(title=title, targets=clean_text(e.targets, 150), steps=steps,
                                      reps=clean_text(e.reps, 100)))
        if len(exercises) == 4:
            break
    focus = [FocusArea(part=clean_text(f.part, 100), whatHappened=clean_text(f.whatHappened), trend=f.trend)
             for f in draft.focusAreas if clean_text(f.part, 100) and clean_text(f.whatHappened)][:3]
    return Recap(
        headline=clean_text(draft.headline, 120) or "Your practice recap",
        summary=clean_text(draft.summary, MAX_SUMMARY),
        wins=_clean_list(draft.wins, 3),
        focusAreas=focus, habits=habits, exercises=exercises, sessionAttempts=session_attempts,
    )


# ---- email ----

def render_email(recap: Recap) -> tuple[str, str, str]:
    """(subject, html, text). Every model string and URL is escaped in the HTML."""
    esc = html.escape
    subject = f"Your practice recap: {recap.headline}"[:200]
    h: list[str] = [f"<h2>{esc(recap.headline)}</h2>", f"<p>{esc(recap.summary)}</p>"]
    t: list[str] = [recap.headline, "", recap.summary]
    if recap.wins:
        h.append("<h3>What went well</h3><ul>" + "".join(f"<li>{esc(w)}</li>" for w in recap.wins) + "</ul>")
        t += ["", "What went well"] + [f"- {w}" for w in recap.wins]
    if recap.focusAreas:
        h.append("<h3>Keep working on</h3><ul>" + "".join(
            f"<li><strong>{esc(f.part)}</strong>: {esc(f.whatHappened)} ({esc(f.trend)})</li>" for f in recap.focusAreas
        ) + "</ul>")
        t += ["", "Keep working on"] + [f"- {f.part}: {f.whatHappened} ({f.trend})" for f in recap.focusAreas]
    if recap.habits:
        h.append("<h3>Three small habits</h3><ol>" + "".join(
            f"<li><strong>{esc(x.title)}</strong> ({esc(x.when)}, {x.minutes} min): {esc(x.how)}"
            f"</li>" for x in recap.habits) + "</ol>")
        t += ["", "Three small habits"] + [
            f"{i}. {x.title} ({x.when}, {x.minutes} min): {x.how}"
            for i, x in enumerate(recap.habits, 1)]
    if recap.exercises:
        h.append("<h3>Practice exercises</h3>")
        t += ["", "Practice exercises"]
        for x in recap.exercises:
            h.append(f"<h4>{esc(x.title)}</h4><p>{esc(x.targets)} - {esc(x.reps)}</p><ol>"
                     + "".join(f"<li>{esc(s)}</li>" for s in x.steps) + "</ol>")
            t += ["", f"{x.title} ({x.targets}; {x.reps})"] + [
                f"  {i}. {s}" for i, s in enumerate(x.steps, 1)]
    return subject, "<div>" + "".join(h) + "</div>", "\n".join(t)


# ---- service ----

Mailer = Callable[[str, str, str, str], Awaitable[str]]


class RecapLimitError(Exception):
    """Too many recaps for this profile (one pending at a time, a few per hour)."""


class RecapService:
    def __init__(self, app) -> None:
        self.app = app
        self.clock = time.monotonic
        self._entries: dict[str, _Entry] = {}
        self._tasks: set[asyncio.Task] = set()
        self._starts: dict[str, list[float]] = {}
        self._client: Any = None

    async def aclose(self) -> None:
        tasks = list(self._tasks)
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        http = getattr(self.app.state, "recap_http", None)
        if http is not None:
            await http.aclose()
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # noqa: BLE001
                logger.warning("recap client close failed")
            self._client = None

    # -- store --
    def _purge(self) -> None:
        now = self.clock()
        for rid in [k for k, e in self._entries.items() if now - e.created > RECAP_TTL_S]:
            del self._entries[rid]
        while len(self._entries) >= RECAP_MAX:
            oldest = next((k for k, e in self._entries.items() if e.status != "pending"), None)
            if oldest is None:
                break  # never evict a running recap; allow exceeding RECAP_MAX
            del self._entries[oldest]

    def get(self, recap_id: str) -> _Entry | None:
        self._purge_expired_only()
        return self._entries.get(recap_id)

    def _purge_expired_only(self) -> None:
        now = self.clock()
        for rid in [k for k, e in self._entries.items() if now - e.created > RECAP_TTL_S]:
            del self._entries[rid]

    # -- seams --
    def _settings(self) -> Settings:
        return self.app.state.settings

    def _history(self):
        from app.live.runtime import get_runtime

        state = self.app.state
        return getattr(state, "live_history", None) or get_runtime(self.app).history(
            getattr(state, "live_spacetime_transport", None))

    def _claude(self):
        """Injected Anthropic-style client (live_client), else one cached client built with the recap timeout
        (the shared runtime client carries the coach's shorter timeout)."""
        injected = getattr(self.app.state, "live_client", None)
        if injected is not None:
            return injected
        if self._client is None:
            self._client = llm.build_client(self._settings(), CALL_TIMEOUT_S)
        return self._client

    def _http(self) -> httpx.AsyncClient:
        client = getattr(self.app.state, "recap_http", None)
        if client is None:
            client = self.app.state.recap_http = httpx.AsyncClient()
        return client

    def _mailer(self) -> Mailer | None:
        injected = getattr(self.app.state, "recap_mailer", None)
        if injected is not None:
            return injected
        s = self._settings()
        if not s.resend_configured:
            return None

        async def send(to: str, subject: str, html_body: str, text: str) -> str:
            from app.integrations.resend_email import send_email

            return await send_email(self._http(), s.resend_api_key, s.recap_email_from, to, subject, html_body, text)

        return send

    # -- API --
    def start(self, profile_id: str, attempt_ids: list[str], word: str | None, email: str | None) -> _Entry:
        self._purge_expired_only()
        key = (profile_id, frozenset(attempt_ids))
        for entry in self._entries.values():
            if entry.key == key and entry.status in ("pending", "ready"):
                if email and not entry.email:
                    self._set_email(entry, email)
                    if entry.status in ("ready", "pending"):
                        self._spawn_delivery_if_ready(entry)
                return entry
        now = self.clock()
        starts = [t for t in self._starts.get(profile_id, []) if now - t < 3600.0]
        pending = sum(1 for e in self._entries.values() if e.profile_id == profile_id and e.status == "pending")
        if pending >= MAX_PENDING_PER_PROFILE or len(starts) >= MAX_STARTS_PER_HOUR:
            self._starts[profile_id] = starts
            raise RecapLimitError(profile_id)
        starts.append(now)
        self._starts[profile_id] = starts
        self._purge()
        entry = _Entry(recap_id=str(uuid.uuid4()), profile_id=profile_id, key=key, created=self.clock())
        self._entries[entry.recap_id] = entry
        if email:
            self._set_email(entry, email)
        safe_word = word.strip().lower() if isinstance(word, str) and WORD_RE.fullmatch(word.strip()) else None
        self._spawn(self._run(entry, set(attempt_ids), safe_word))
        return entry

    def _spawn(self, coro) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _spawn_delivery_if_ready(self, entry: _Entry) -> None:
        if entry.status == "ready":
            self._spawn(self.deliver(entry))

    def _set_email(self, entry: _Entry, email: str) -> None:
        entry.email = email
        entry.email_status = "queued" if self._mailer() is not None else "not_configured"

    async def set_email(self, entry: _Entry, email: str) -> None:
        self._set_email(entry, email)
        if entry.status == "ready":
            await self.deliver(entry)
        elif entry.status in ("failed", "empty"):
            entry.email_status = "none" if entry.email_status == "queued" else entry.email_status

    async def deliver(self, entry: _Entry) -> None:
        if entry.email_status != "queued" or entry.recap is None or entry.email is None or entry.sending:
            return
        mailer = self._mailer()
        if mailer is None:
            entry.email_status = "not_configured"
            return
        entry.sending = True
        try:
            while True:
                to = entry.email
                subject, html_body, text = render_email(entry.recap)
                try:
                    await mailer(to, subject, html_body, text)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("recap email failed: %s", type(exc).__name__)
                    if entry.email == to:
                        entry.email_status = "failed"
                        break
                else:
                    if entry.email == to:
                        entry.email_status = "sent"
                        break
                # the address changed during the send: the new one is queued, send again
                if entry.email_status != "queued" or entry.email is None:
                    break
        finally:
            entry.sending = False

    # -- pipeline --
    async def _run(self, entry: _Entry, attempt_ids: set[str], word: str | None) -> None:
        try:
            await asyncio.wait_for(self._pipeline(entry, attempt_ids, word), self._settings().live_recap_timeout_s)
        except asyncio.TimeoutError:
            entry.status, entry.error = "failed", "timeout"
        except Exception as exc:  # noqa: BLE001
            logger.warning("recap failed: %s", type(exc).__name__)
            entry.status, entry.error = "failed", "recap_unavailable"
        if entry.status != "ready" and entry.email_status == "queued":
            entry.email_status = "failed" if entry.status == "failed" else "none"
        await self.deliver(entry)

    async def _load(self, profile_id: str, attempt_ids: set[str]):
        history = self._history()
        for tries_left in (1, 0):
            context = await history.load(profile_id, HISTORY_LIMIT)
            turns = [t for t in (*context.attempts, *context.word_attempts) if isinstance(t, dict)]
            session = [t for t in turns if t.get("attemptId") in attempt_ids]
            if session or not tries_left:
                past = [t for t in turns if t.get("attemptId") not in attempt_ids]
                return context, session, past
            await asyncio.sleep(HISTORY_RETRY_DELAY_S)

    async def _pipeline(self, entry: _Entry, attempt_ids: set[str], word: str | None) -> None:
        s = self._settings()
        context, session, past = await self._load(entry.profile_id, attempt_ids)
        if not session:
            entry.status = "empty"
            return
        words = sorted({w for w in (_word_of(a) for a in session if a.get("kind") == "word") if w})
        if len(words) > 1:
            word = None
        elif words:
            word = words[0]
        try:
            draft = await llm.ask_claude(
                s, self._claude(), RECAP_SYSTEM,
                build_prompt(session, past, context.notes, word, words if len(words) > 1 else None), RecapDraft,
                s.live_recap_effort, min(CALL_TIMEOUT_S, s.live_recap_timeout_s), RECAP_MAX_TOKENS,
                model=s.live_recap_model)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            raise  # the caller reports a timeout
        except Exception as exc:  # noqa: BLE001
            logger.warning("recap call failed: %s", type(exc).__name__)
            entry.status, entry.error = "failed", "summary_unavailable"
            return
        entry.recap = build_recap(draft, len(session))
        entry.status = "ready"


def get_service(app) -> RecapService:
    service = getattr(app.state, "recap_service", None)
    if service is None:
        service = app.state.recap_service = RecapService(app)
    return service
