import asyncio
from types import SimpleNamespace

from app.live.history import LearnerContext
from app.live.notes import (
    practice_miss_counts,
    update_notes,
    word_vowel_misses,
)
from app.live.session import build_plan


def word(aid, phoneme="iy", verdict="miss", quality="usable", advisory=False, in_scope=True, kind="vowel"):
    return {
        "kind": "word",
        "attemptId": aid,
        "word": "sheep",
        "quality": quality,
        "zones": [
            {"id": "ee", "phoneme": phoneme, "kind": kind, "verdict": verdict, "advisory": advisory, "inScope": in_scope}
        ],
    }


def vowel(aid, sound="i"):
    return {"attemptId": aid, "sound": sound, "audioVerdict": "off", "videoVerdict": None}


def ctx(attempts=(), words=(), timeline=None):
    tl = timeline if timeline is not None else sorted(
        [*attempts, *words], key=lambda t: -int(t["attemptId"][1:])
    )
    return LearnerContext(attempts=list(attempts), word_attempts=list(words), timeline=list(tl))


def test_only_word_turns_drive_notes_and_plan():
    context = ctx(words=[word("a3"), word("a2")])
    assert practice_miss_counts(context) == {"i": (2, "a3")}
    assert build_plan(None, context)[0] == "i"

    class H:
        async def load(self, profile_id, limit):
            return context

        async def save_notes(self, profile_id, notes):
            return True

    deps = SimpleNamespace(get_history=lambda: H(), model_available=False)
    notes = asyncio.run(update_notes(deps, "p"))
    assert [(s.sound, s.count, s.lastAttemptId) for s in notes.struggles] == [("i", 2, "a3")]
    assert notes.attemptsConsidered == 2


def test_uncounted_word_turns():
    turns = [
        word("a1", quality="unusable"),
        word("a2", advisory=True),
        word("a3", in_scope=False),
        word("a4", verdict="partial"),
        word("a5", verdict="hit"),
        word("a6", phoneme="ae"),
        word("a7", kind="stop"),
    ]
    assert word_vowel_misses(turns) == {}


def test_mixed_counts_use_timeline_order():
    context = ctx(attempts=[vowel("a2")], words=[word("a3"), word("a1")])
    assert practice_miss_counts(context) == {"i": (3, "a3")}
    context = ctx(attempts=[vowel("a5")], words=[word("a3")])
    assert practice_miss_counts(context) == {"i": (2, "a5")}
    # word id absent from timeline: keep the vowel one
    context = ctx(attempts=[vowel("a1")], words=[word("a9")], timeline=[vowel("a1")])
    assert practice_miss_counts(context) == {"i": (2, "a1")}


def _deps_with_model(context, monkeypatch, struggles):
    from app.live import notes as notes_mod
    from app.live.schemas import NotesDraft, Struggle

    calls = []

    async def fake_ask(*args, **kwargs):
        calls.append(args)
        return NotesDraft(
            summary="The ah sound has needed extra tries.",
            struggles=[Struggle(sound=s, pattern="", count=0, lastAttemptId=None) for s in struggles],
            habits=[],
        )

    monkeypatch.setattr(notes_mod.llm, "ask", fake_ask)

    class H:
        async def load(self, profile_id, limit):
            return context

        async def save_notes(self, profile_id, notes):
            return True

    settings = SimpleNamespace(live_notes_effort="low", live_coach_timeout_s=1, live_notes_model="m")
    return SimpleNamespace(get_history=lambda: H(), model_available=True, settings=settings, llm_client=None), calls


def test_word_turns_alone_skip_the_model(monkeypatch):
    deps, calls = _deps_with_model(ctx(words=[word("a2"), word("a1")]), monkeypatch, ["i"])
    notes = asyncio.run(update_notes(deps, "p"))
    assert calls == []
    assert notes.source == "fallback"
    assert [s.sound for s in notes.struggles] == ["i"]


def test_model_notes_keep_word_struggles_it_did_not_name(monkeypatch):
    deps, calls = _deps_with_model(ctx(attempts=[vowel("a3", "a")], words=[word("a2")]), monkeypatch, ["a"])
    notes = asyncio.run(update_notes(deps, "p"))
    assert len(calls) == 1
    assert notes.source == "agent"
    assert [(s.sound, s.lastAttemptId) for s in notes.struggles] == [("a", "a3"), ("i", "a2")]
