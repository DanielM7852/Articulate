"""Coach model/thinking mapping and background persistence."""

import asyncio
import logging

import pytest

from app.live import llm
from app.live.orchestrator import LiveDeps, coach_attempt
from app.live.schemas import LiveCoachRequest
from tests.support import make_settings
from tests.test_live_api import AID, FakeClient, body, decision, make

SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"


def test_thinking_mapping():
    assert llm.request_options(SONNET, "off", "medium") == ({"thinking": {"type": "between_tools"}}, "medium")
    assert llm.request_options(HAIKU, "off", "low") == ({"thinking": {"type": "disabled"}}, "low")
    assert llm.request_options(SONNET, "on", "medium") == ({}, "medium")
    assert llm.request_options(HAIKU, "on", "high") == ({}, "high")


def test_effort_clamped_when_thinking_off_and_unknown_model_warns_once(caplog):
    llm._warned.clear()
    with caplog.at_level(logging.WARNING, logger="app.live.llm"):
        assert llm.request_options(SONNET, "off", "max") == ({"thinking": {"type": "between_tools"}}, "high")
        extra, effort = llm.request_options("other-model", "off", "low")
        llm.request_options("other-model", "off", "low")
    assert extra == {} and effort == "low"
    assert sum("other-model" in r.getMessage() for r in caplog.records) == 1


@pytest.mark.parametrize(
    "model,thinking,expected",
    [(SONNET, "off", {"type": "between_tools"}), (HAIKU, "off", {"type": "disabled"}), (HAIKU, "on", None)],
)
def test_settings_reach_the_api_call(tmp_path, model, thinking, expected):
    fake = FakeClient(decision())
    c = make(tmp_path, fake, anthropic_api_key="k", live_coach_model=model, live_coach_thinking=thinking)
    j = c.post("/v1/live/coach", json=body()).json()
    call = fake.calls[0]
    assert call["model"] == model and j["model"] == model
    assert call.get("thinking") == expected
    assert not ({"temperature", "top_p", "top_k"} & set(call))


def test_notes_use_notes_model(tmp_path):
    fake = FakeClient(decision())
    c = make(tmp_path, fake, anthropic_api_key="k", live_notes_model=HAIKU)
    assert c.app.state.settings.live_notes_model == HAIKU


class SlowHistory:
    def __init__(self, fail=False):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.finished = False
        self.fail = fail

    async def load(self, profile_id, limit):
        from app.live.history import LearnerContext

        return LearnerContext()

    async def record(self, profile_id, attempt_id, summary, decision):
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("boom")
        self.finished = True
        return True


def test_response_returns_before_slow_persist_and_drain_completes_it(tmp_path):
    async def run():
        hist = SlowHistory()
        deps = LiveDeps(settings=make_settings(tmp_path, anthropic_api_key="k"), anthropic_client=FakeClient(decision()), history=hist)
        queued = []
        response = await coach_attempt(deps, LiveCoachRequest.model_validate(body()), queued.append)
        assert response.persisted is None and not hist.finished and len(queued) == 1
        assert set(response.timingsMs) == {"frames", "history", "scoring", "llm", "validate", "total"}
        hist.release.set()
        await queued[0]()
        assert hist.finished

    asyncio.run(run())


def test_persist_failure_is_logged_and_response_still_200(tmp_path, caplog):
    async def run():
        hist = SlowHistory(fail=True)
        hist.release.set()
        deps = LiveDeps(settings=make_settings(tmp_path), history=hist)
        queued = []
        await coach_attempt(deps, LiveCoachRequest.model_validate(body()), queued.append)
        await queued[0]()

    with caplog.at_level(logging.WARNING, logger="app.live.orchestrator"):
        asyncio.run(run())
    assert any(AID in r.getMessage() and "persist failed" in r.getMessage() for r in caplog.records)


def test_http_persists_in_background_and_row_is_stored(tmp_path):
    c = make(tmp_path)
    r = c.post("/v1/live/coach", json=body())
    assert r.status_code == 200 and r.json()["persisted"] is None and r.json()["model"] is None
    notes = c.post("/v1/live/notes", json={"profileId": "kid-1"}).json()
    assert notes["attemptsConsidered"] == 1
