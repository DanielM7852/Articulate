"""Word ask: earlier lines and hard parts reach the model; history failures never fail the answer."""

import asyncio
import json

from fastapi.testclient import TestClient

from app.live import word_ask
from app.live.history import LearnerContext
from app.live.schemas import WordAskDraft
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import FakeClient


def zone(zid, phoneme, verdict, label=None):
    return {"id": zid, "phoneme": phoneme, "verdict": verdict, "advisory": False, "inScope": True}


def turn(word, caption, verdict="miss"):
    return {"kind": "word", "word": word, "caption": caption, "quality": "usable", "focusZoneId": "k",
            "zones": [zone("k", "k", verdict)]}


class FakeHistory:
    def __init__(self, timeline=None, exc=None, delay=0):
        self.timeline, self.exc, self.delay = timeline or [], exc, delay

    async def load(self, profile_id, limit):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return LearnerContext(timeline=self.timeline)


def ask(tmp_path, history):
    fake = FakeClient(WordAskDraft(say="Lift the back of the tongue, then let go."))
    app = create_app(make_settings(tmp_path, anthropic_api_key="k"))
    app.state.live_client = fake
    app.state.live_history = history
    r = TestClient(app).post("/v1/live/word/ask", json={"profileId": "p", "word": "track", "question": "How?"})
    return r, json.loads(fake.calls[0]["messages"][0]["content"])


def test_memory_reaches_the_model(tmp_path):
    timeline = [turn("track", "New image."), turn("track", "Old one."), turn("track", "New image."),
                turn("sheep", "Other word."), turn("track", "a"), turn("track", "b")]
    r, payload = ask(tmp_path, FakeHistory(timeline))
    assert r.json()["source"] == "model"
    assert payload["earlierLines"] == ["New image.", "Old one.", "a"]
    assert payload["hardParts"] == ["ck"]


def test_no_hard_part_when_not_persistent(tmp_path):
    _, payload = ask(tmp_path, FakeHistory([turn("track", "Hi.", "hit")]))
    assert payload["earlierLines"] == ["Hi."] and "hardParts" not in payload


def test_failures_and_timeout_omit_memory(tmp_path, monkeypatch):
    monkeypatch.setattr(word_ask, "HISTORY_TIMEOUT_S", 0.05)
    for h in (FakeHistory(exc=RuntimeError("boom")), FakeHistory([turn("track", "x")], delay=1), FakeHistory()):
        r, payload = ask(tmp_path, h)
        assert r.json()["source"] == "model"
        assert "earlierLines" not in payload and "hardParts" not in payload


def test_prompts_ask_for_another_way():
    from app.live import llm

    for text in (llm.COACH_SYSTEM, llm.WORD_COACH_SYSTEM, word_ask.WORD_ASK_SYSTEM):
        assert "another way" in text
