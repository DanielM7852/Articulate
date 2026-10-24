import json
from types import SimpleNamespace
from uuid import uuid4

from app import providers
from app.config import Settings
from app.features import summarize, synthetic_frame
from app.decisions import fallback
from app.schemas import CoachingContext, CoachingProposal


async def test_moss_filter_and_stale_index_version_are_checked(runtime):
    runtime.settings.mock_mode = False
    cue = runtime.repository.cues[0].model_copy(update={"review_status": "approved"})
    runtime.repository.cues = [cue]
    captured = []

    async def query(name, text, options):
        captured.append(options.filter)
        return SimpleNamespace(
            docs=[
                SimpleNamespace(
                    id=f"i:{cue.id}", text=cue.text, metadata={"corpus_revision": "1", "cue_version": "0"}
                )
            ]
        )

    runtime.repository.client = SimpleNamespace(query=query)
    assert not await runtime.repository.query("i")
    assert {"field": "review_status", "condition": {"$eq": "approved"}} in captured[0]["$and"]


async def test_claude_gets_bounded_features_and_exact_candidates(runtime):
    runtime.settings.mock_mode = False
    runtime.settings.claude_model = "configured-test-model"
    s = summarize(uuid4(), "i", [synthetic_frame("i", n) for n in range(20)], 24000, 19200, "synthetic")
    g = uuid4()
    cues = [runtime.repository.cues[0].model_copy(update={"review_status": "approved"})]
    captured = []

    async def parse(**kwargs):
        captured.append(kwargs)
        selected = fallback(s, g, cues)
        return SimpleNamespace(
            parsed_output=CoachingProposal(
                attempt_id=s.attempt_id,
                generation_id=g,
                observation_id=selected.observation_id,
                cue_id=selected.cue_id,
                cue_version=selected.cue_version,
                next_action=selected.next_action,
            )
        )

    runtime.reasoner.client = SimpleNamespace(messages=SimpleNamespace(parse=parse))
    decision = await runtime.reasoner.decide(s, g, cues, CoachingContext())
    request = json.loads(captured[0]["messages"][0]["content"])
    assert request["cues"][0]["text"] == cues[0].text
    assert request["summary"]["f1_mean"] == s.f1_mean
    assert set(request) == {
        "summary",
        "generation_id",
        "attempt_id",
        "plan",
        "cues",
        "recent_outcomes",
        "policy_version",
    }
    assert captured[0]["output_format"] is CoachingProposal
    assert decision.generation_id == g


async def test_cartesia_reuses_socket_and_finalizes_complete_contexts(monkeypatch):
    class Socket:
        def __init__(self):
            self.sent = []
            self.responses = []
            self.closed = False

        async def send(self, value):
            item = json.loads(value)
            self.sent.append(item)
            if "transcript" in item:
                context = item["context_id"]
                self.responses += [
                    json.dumps({"type": "chunk", "data": "AAA=", "context_id": context}),
                    json.dumps({"type": "done", "done": True, "context_id": context}),
                ]

        async def recv(self):
            return self.responses.pop(0)

        async def close(self):
            self.closed = True

    socket = Socket()
    opens = []

    async def connect(*args, **kwargs):
        opens.append(kwargs)
        return socket

    monkeypatch.setattr(providers, "connect", connect)
    settings = Settings(
        _env_file=None,
        mock_mode=False,
        cartesia_api_key="test-key",
        cartesia_model="test-model",
        cartesia_voice="test-voice",
    )
    speech = providers.Speech(settings)
    for _ in range(2):
        assert [item async for item in speech.stream("Complete approved cue.", uuid4())] == [
            ("audio", b"\0\0")
        ]
    assert len(opens) == 1
    assert socket.sent[0]["context_id"] != socket.sent[1]["context_id"]
    assert all(item["max_buffer_delay_ms"] == 0 and item["continue"] is False for item in socket.sent)
    assert opens[0]["additional_headers"]["X-API-Key"] == "test-key"
    await speech.close()
    assert socket.closed
