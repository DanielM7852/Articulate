"""Live coaching on OpenAI: model routing, attempt audio, deterministic fallbacks, telemetry. No network."""

import asyncio
import base64
from types import SimpleNamespace

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app import telemetry
from app.api import live_routes
from app.live import llm
from app.live.schemas import CoachDecision, NotesDraft, WordAskDraft
from app.main import create_app
from tests.support import make_settings
from tests.test_live_word import MISSING_CK, attempt_dict, coach_body, word_decision

WAV = b"RIFF" + (60).to_bytes(4, "little") + b"WAVE" + b"fmt " + bytes(48)
WAV_B64 = base64.b64encode(WAV).decode("ascii")
AUDIO = {"format": "wav", "data": WAV_B64, "durationMs": 1200}
GOOD = "Almost there. For the ck, lift the back of the tongue, then release."


class FakeOpenAI:
    """Records chat.completions.parse kwargs; answers with a text-style or forced-tool-style response."""

    def __init__(self, parsed=None, exc=None, refusal=None, via_tool=False):
        self.calls = []
        self.parsed, self.exc, self.refusal, self.via_tool = parsed, exc, refusal, via_tool
        outer = self

        class Completions:
            def parse(self, **kw):
                outer.calls.append(kw)
                if outer.exc:
                    raise outer.exc
                tool = SimpleNamespace(function=SimpleNamespace(parsed_arguments=outer.parsed))
                msg = SimpleNamespace(
                    parsed=None if "tools" in kw else outer.parsed,
                    refusal=outer.refusal,
                    tool_calls=[tool] if "tools" in kw else None,
                )
                return SimpleNamespace(
                    choices=[SimpleNamespace(message=msg)],
                    usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7),
                )

        self.chat = SimpleNamespace(completions=Completions())


def client_for(tmp_path, fake, **settings):
    settings.setdefault("live_coach_provider", "openai")
    settings.setdefault("openai_api_key", "k")
    app = create_app(make_settings(tmp_path, **settings))
    app.state.live_openai_client = fake
    return TestClient(app)


def word_post(client, audio=None):
    body = coach_body(attempt_dict(**MISSING_CK))
    if audio is not None:
        body["attemptAudio"] = audio
    return client.post("/v1/live/coach", json=body)


def user_text(call):
    content = call["messages"][1]["content"]
    return content if isinstance(content, str) else content[0]["text"]


def test_defaults_are_openai(tmp_path):
    from app.config import Settings

    s = Settings(_env_file=None)
    assert s.live_coach_provider == "openai" and s.live_openai_model == "gpt-5.4-mini"
    assert s.live_openai_background_model == "gpt-5.5" and s.live_openai_audio_model == "gpt-audio-1.5"
    assert not s.openai_configured and Settings(_env_file=None, openai_api_key="x").openai_configured


def test_word_coach_with_audio_uses_audio_model_and_forced_tool(tmp_path):
    fake = FakeOpenAI(word_decision(caption=GOOD))
    r = word_post(client_for(tmp_path, fake), AUDIO)
    assert r.status_code == 200 and r.json()["source"] == "agent"
    assert r.json()["model"] == "gpt-audio-1.5"
    call = fake.calls[0]
    assert call["model"] == "gpt-audio-1.5" and call["modalities"] == ["text"]
    assert "reasoning_effort" not in call and "response_format" not in call
    assert call["tool_choice"] == {"type": "function", "function": {"name": "submit"}}
    assert call["tools"][0]["function"]["name"] == "submit"
    assert llm.WORD_COACH_AUDIO_NOTE in call["messages"][0]["content"]
    assert call["messages"][0]["content"].startswith(llm.WORD_COACH_SYSTEM)
    parts = call["messages"][1]["content"]
    assert parts[1] == {"type": "input_audio", "input_audio": {"data": WAV_B64, "format": "wav"}}
    assert "word.k.burstDetected" in parts[0]["text"]


def test_word_coach_without_audio_uses_text_model(tmp_path):
    fake = FakeOpenAI(word_decision(caption=GOOD))
    r = word_post(client_for(tmp_path, fake))
    assert r.json()["source"] == "agent" and r.json()["model"] == "gpt-5.4-mini"
    call = fake.calls[0]
    assert call["model"] == "gpt-5.4-mini" and call["reasoning_effort"] == "medium"
    assert call["response_format"] is CoachDecision and "tools" not in call
    assert call["messages"][0]["content"] == llm.WORD_COACH_SYSTEM
    assert llm.WORD_COACH_AUDIO_NOTE not in call["messages"][0]["content"]


@pytest.mark.parametrize("data", [
    "!!!not base64!!!" + "A" * 40,
    base64.b64encode(b"RIFF" + bytes(4) + b"AVI " + bytes(40)).decode(),
    base64.b64encode(b"x" * 60).decode(),
])
def test_bad_audio_is_ignored_not_rejected(tmp_path, data):
    fake = FakeOpenAI(word_decision(caption=GOOD))
    r = word_post(client_for(tmp_path, fake), {"format": "wav", "data": data, "durationMs": 100})
    assert r.status_code == 200 and r.json()["source"] == "agent"
    assert fake.calls[0]["model"] == "gpt-5.4-mini" and "tools" not in fake.calls[0]


def test_oversized_audio_is_422(tmp_path):
    fake = FakeOpenAI(word_decision())
    r = word_post(client_for(tmp_path, fake), {"format": "wav", "data": "A" * 480_001, "durationMs": 100})
    assert r.status_code == 422 and not fake.calls


def test_anthropic_provider_ignores_audio_and_openai_client(tmp_path):
    from tests.test_live_api import FakeClient

    claude = FakeClient(word_decision(caption=GOOD))
    openai_fake = FakeOpenAI(word_decision())
    app = create_app(make_settings(tmp_path, anthropic_api_key="k"))
    app.state.live_client, app.state.live_openai_client = claude, openai_fake
    r = word_post(TestClient(app), AUDIO)
    assert r.json()["source"] == "agent" and r.json()["model"] == "claude-sonnet-5-5"
    assert claude.calls and not openai_fake.calls
    assert llm.WORD_COACH_AUDIO_NOTE not in claude.calls[0]["system"]


@pytest.mark.parametrize("make_fake", [
    lambda: FakeOpenAI(exc=RuntimeError("boom")),
    lambda: FakeOpenAI(exc=TimeoutError()),
    lambda: FakeOpenAI(word_decision(), refusal="no"),
    lambda: FakeOpenAI(None),
    lambda: FakeOpenAI(word_decision(focusZoneId="zz")),
])
@pytest.mark.parametrize("audio", [None, AUDIO])
def test_word_coach_failures_use_deterministic_fallback(tmp_path, make_fake, audio):
    fake = make_fake()
    data = word_post(client_for(tmp_path, fake), audio).json()
    assert data["source"] == "fallback" and data["model"] is None
    assert data["caption"] == "The ck at the end went missing. Back of the tongue up, then release."
    assert len(fake.calls) == 1  # no retry


def ask_body():
    return {"profileId": "learner-1", "word": "track", "question": "How do I say the ck at the end?"}


def test_word_ask_uses_text_model_and_falls_back(tmp_path):
    good = FakeOpenAI(WordAskDraft(say="Lift the back of the tongue, then let go at the end."))
    r = client_for(tmp_path, good).post("/v1/live/word/ask", json=ask_body())
    assert r.json() == {"say": "Lift the back of the tongue, then let go at the end.", "source": "model"}
    call = good.calls[0]
    assert call["model"] == "gpt-5.4-mini" and call["response_format"] is WordAskDraft
    for bad in (FakeOpenAI(exc=RuntimeError("x")), FakeOpenAI(WordAskDraft(say="x"), refusal="no"), FakeOpenAI(None)):
        j = client_for(tmp_path, bad).post("/v1/live/word/ask", json=ask_body()).json()
        assert j["source"] == "fallback" and j["say"].startswith("Watch the board")


def ask(settings, fake, fmt, purpose, effort="medium", **kw):
    return asyncio.run(llm.ask(settings, fake, "sys", "{}", fmt, effort, 5, 100, model="claude-x", purpose=purpose, **kw))


def test_background_purposes_use_background_model_and_text_purposes_the_text_model(tmp_path):
    s = make_settings(tmp_path, live_coach_provider="openai")
    for purpose, model in (("notes", "gpt-5.5"), ("insight", "gpt-5.5"), ("decide", "gpt-5.4-mini"),
                           ("session", "gpt-5.4-mini"), ("ask", "gpt-5.4-mini"), ("word", "gpt-5.4-mini")):
        fake = FakeOpenAI(NotesDraft(summary="s"))
        ask(s, fake, NotesDraft, purpose)
        assert fake.calls[0]["model"] == model, purpose


def test_claude_only_efforts_map_to_high_and_audio_has_no_effort(tmp_path):
    s = make_settings(tmp_path, live_coach_provider="openai")
    for effort in ("xhigh", "max"):
        fake = FakeOpenAI(NotesDraft(summary="s"))
        ask(s, fake, NotesDraft, "notes", effort)
        assert fake.calls[0]["reasoning_effort"] == "high"
    fake = FakeOpenAI(NotesDraft(summary="s"))
    ask(s, fake, NotesDraft, "word", "high", audio_wav=WAV)
    assert "reasoning_effort" not in fake.calls[0] and fake.calls[0]["model"] == "gpt-audio-1.5"


def test_empty_and_refusal_raise(tmp_path):
    from app.live.decision import DecisionError

    s = make_settings(tmp_path, live_coach_provider="openai")
    with pytest.raises(DecisionError, match="empty_model_output"):
        ask(s, FakeOpenAI(None), NotesDraft, "notes")
    with pytest.raises(llm.ModelRefusal):
        ask(s, FakeOpenAI(NotesDraft(summary="s"), refusal="no"), NotesDraft, "notes")


def test_timeout_is_enforced(tmp_path):
    import time

    class Slow:
        def __init__(self):
            self.chat = SimpleNamespace(completions=SimpleNamespace(parse=lambda **kw: time.sleep(0.5)))

    s = make_settings(tmp_path, live_coach_provider="openai")
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(llm.ask(s, Slow(), "sys", "{}", NotesDraft, "low", 0.05, 100, purpose="notes"))


def test_model_available_is_provider_aware(tmp_path):
    from app.live.orchestrator import LiveDeps

    assert not LiveDeps(make_settings(tmp_path, live_coach_provider="openai")).model_available
    assert LiveDeps(make_settings(tmp_path, live_coach_provider="openai", openai_api_key="k")).model_available
    assert LiveDeps(make_settings(tmp_path, live_coach_provider="openai"), openai_client=object()).model_available
    # a Claude key or client does not enable the OpenAI provider, and vice versa
    assert not LiveDeps(make_settings(tmp_path, live_coach_provider="openai", anthropic_api_key="k"),
                        anthropic_client=object()).model_available
    assert LiveDeps(make_settings(tmp_path, anthropic_api_key="k")).model_available
    assert not LiveDeps(make_settings(tmp_path, openai_api_key="k")).model_available


def test_telemetry_has_provider_usage_and_line_without_audio(tmp_path, monkeypatch):
    events = []
    monkeypatch.setattr(telemetry, "emit", lambda source, target, kind, label, payload=None: events.append((kind, label, payload)))
    s = make_settings(tmp_path, live_coach_provider="openai")
    ask(s, FakeOpenAI(WordAskDraft(say="Lift the tongue.")), WordAskDraft, "ask")
    ask(s, FakeOpenAI(word_decision(caption=GOOD)), CoachDecision, "word", audio_wav=WAV)
    kinds = [e[0] for e in events]
    assert kinds == ["claude.request", "claude.response", "claude.request", "claude.response"]
    assert all(e[2]["provider"] == "openai" for e in events)
    response = events[1][2]
    assert response["inputTokens"] == 11 and response["outputTokens"] == 7 and response["line"] == "Lift the tongue."
    assert WAV_B64 not in repr(events)


def test_attempt_audio_is_dropped_before_a_shared_job(tmp_path, monkeypatch):
    sent = {}

    class Coordination:
        async def submit(self, kind, payload, key=None):
            sent.update(kind=kind, payload=payload)
            return JSONResponse({"jobId": "j"}, status_code=202)

    monkeypatch.setattr(live_routes, "_shared", lambda request, profile_id: True)
    monkeypatch.setattr(live_routes, "_coordination", lambda request: Coordination())
    r = word_post(client_for(tmp_path, FakeOpenAI()), AUDIO)
    assert r.status_code == 202 and sent["kind"] == "attempt.coach"
    assert "attemptAudio" not in sent["payload"] and WAV_B64 not in repr(sent)


def test_audio_is_not_stored_in_history(tmp_path):
    fake = FakeOpenAI(word_decision(caption=GOOD))
    client = client_for(tmp_path, fake)
    assert word_post(client, AUDIO).status_code == 200
    stored = [p for p in (tmp_path / "store").rglob("*") if p.is_file()]
    assert stored and all(WAV_B64 not in p.read_text(encoding="utf-8", errors="ignore") for p in stored)
