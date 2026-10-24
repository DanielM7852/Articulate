"""Learner progress storage: local JSON, SpacetimeDB over a mocked transport, and the coach flow."""

import asyncio
import json
from types import SimpleNamespace

import httpx

from app.reasoning.learner_progress import (
    LessonPlan,
    LocalProgressStore,
    SpacetimeProgressStore,
    apply_attempt,
    build_progress_store,
    empty_progress,
)
from app.reasoning.vowel_coach import VowelCoachRequest, coach_attempt
from app.integrations.spacetime import SpacetimeClient
from tests.support import make_settings

SPACE = dict(spacetime_database="mydb", spacetime_token="secret-token", spacetime_uri="https://stdb.test")
PLAN = LessonPlan(sound="i", pace="unhurried", assistance="cue-target")


def _attempt(attempt_id="a1", sound="i", quality="usable"):
    return SimpleNamespace(attemptId=attempt_id, sound=sound, quality=quality)


def _request(attempt_id="attempt-1", **extra):
    attempt = {
        "attemptId": attempt_id,
        "sound": "i",
        "kind": "guided",
        "assistance": "cue-target",
        "startedAt": 1,
        "durationSec": 3.2,
        "usableVoicedSec": 2.4,
        "timeInTargetSec": None,
        "longestHoldSec": None,
        "quality": "usable",
        "recognizedText": None,
    }
    return VowelCoachRequest.model_validate(
        {"attempt": attempt, "history": [], "learnerId": "kid-1", "plan": PLAN.model_dump(), **extra}
    )


def test_apply_attempt_counts_once_copies_history_only_into_an_empty_record_and_does_not_mutate():
    base = empty_progress("kid-1")
    first = apply_attempt(base, "kid-1", _attempt("a1"), PLAN, [_attempt("h1", quality="unclear")])
    assert first.sounds["i"].usable == 1 and first.sounds["i"].unclear == 1
    assert base.counted_attempt_ids == []
    again = apply_attempt(first, "kid-1", _attempt("a1"), PLAN, [_attempt("h2")])
    assert again.sounds["i"].usable == 1 and again.counted_attempt_ids == ["h1", "a1"]
    later = apply_attempt(first, "kid-1", _attempt("a2"), PLAN, [_attempt("h2")])
    assert later.counted_attempt_ids == ["h1", "a1", "a2"] and later.plan == PLAN


def test_local_store_round_trip_and_path_layout(tmp_path):
    store = LocalProgressStore(str(tmp_path))
    assert asyncio.run(store.load("A@Example.com")) is None
    progress = apply_attempt(None, "A@Example.com", _attempt(), PLAN, [])
    assert asyncio.run(store.save(progress)) is True
    assert (tmp_path / "learner_progress" / "a@example.com.json").exists()
    assert asyncio.run(store.load("A@Example.com")) == progress
    assert asyncio.run(store.save(empty_progress("bad id!"))) is False
    assert asyncio.run(store.load("bad id!")) is None


def test_build_progress_store_follows_the_spacetime_settings(tmp_path):
    assert isinstance(build_progress_store(make_settings(tmp_path)), LocalProgressStore)
    assert isinstance(build_progress_store(make_settings(tmp_path, **SPACE)), SpacetimeProgressStore)


def _spacetime_store(tmp_path, handler):
    settings = make_settings(tmp_path, **SPACE)
    return SpacetimeProgressStore(SpacetimeClient(settings, httpx.MockTransport(handler), None))


def test_spacetime_store_loads_a_row_and_saves_through_the_reducer(tmp_path):
    saved = apply_attempt(None, "kid-1", _attempt(), PLAN, [])
    seen = {"sql": [], "calls": []}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer secret-token"
        if request.url.path.endswith("/sql"):
            seen["sql"].append(request.content.decode())
            return httpx.Response(200, json=[{"rows": [{"profile_id": "kid-1", "progress": saved.model_dump_json()}]}])
        seen["calls"].append((request.url.path.rsplit("/", 1)[1], json.loads(request.content)))
        return httpx.Response(200, text="")

    store = _spacetime_store(tmp_path, handler)
    assert asyncio.run(store.load("kid-1")) == saved
    assert seen["sql"] == ["SELECT * FROM learner_progress WHERE profile_id = 'kid-1'"]
    assert asyncio.run(store.save(saved)) is True
    name, args = seen["calls"][0]
    assert name == "set_learner_progress" and args[0] == "kid-1" and json.loads(args[1]) == saved.model_dump()


def test_spacetime_store_failures_return_none_or_false(tmp_path):
    def down(request):
        raise httpx.ConnectError("down")

    def empty(request):
        return httpx.Response(200, json=[{"rows": []}])

    def garbage(request):
        return httpx.Response(200, json=[{"rows": [{"profile_id": "kid-1", "progress": "not json"}]}])

    def refused(request):
        return httpx.Response(500, text="")

    progress = empty_progress("kid-1")
    store = _spacetime_store(tmp_path, down)
    assert asyncio.run(store.load("kid-1")) is None and asyncio.run(store.save(progress)) is False
    assert asyncio.run(_spacetime_store(tmp_path, empty).load("kid-1")) is None
    assert asyncio.run(_spacetime_store(tmp_path, garbage).load("kid-1")) is None
    assert asyncio.run(_spacetime_store(tmp_path, refused).save(progress)) is False


def test_spacetime_store_skips_ids_the_module_would_reject_without_calling_the_network(tmp_path):
    def forbidden(request):
        raise AssertionError("network must not be called")

    store = _spacetime_store(tmp_path, forbidden)
    for bad in ("a+b@example.com", "has space", "x" * 65, ""):
        assert asyncio.run(store.load(bad)) is None
        assert asyncio.run(store.save(empty_progress(bad))) is False


class FakeStore:
    def __init__(self):
        self.progress = None
        self.saves = []

    async def load(self, learner_id):
        return self.progress

    async def save(self, progress):
        self.saves.append(progress)
        self.progress = progress
        return True


def test_coach_attempt_advances_with_a_fake_store_and_saves_once_per_new_attempt(tmp_path):
    settings = make_settings(tmp_path)
    store = FakeStore()
    first = asyncio.run(coach_attempt(settings, _request("attempt-1"), progress_store=store))
    assert first.plan.assistance == "target-only" and first.nextAction == "reduce-assistance"
    assert len(store.saves) == 1 and store.saves[0].learner_id == "kid-1"
    second = asyncio.run(
        coach_attempt(settings, _request("attempt-2", plan=first.plan.model_dump()), progress_store=store)
    )
    assert second.plan.assistance == "none"
    assert len(store.saves) == 2 and store.progress.sounds["i"].usable == 2
    replay = asyncio.run(coach_attempt(settings, _request("attempt-2", plan=first.plan.model_dump()), progress_store=store))
    assert replay.plan == second.plan and len(store.saves) == 2


def test_coach_attempt_without_a_learner_id_touches_no_store(tmp_path):
    store = FakeStore()
    body = _request()
    body.learnerId = None
    asyncio.run(coach_attempt(make_settings(tmp_path), body, progress_store=store))
    assert store.saves == []


def test_coach_route_persists_progress_in_spacetime_when_configured(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/sql"):
            return httpx.Response(200, json=[{"rows": []}])
        calls.append((request.url.path.rsplit("/", 1)[1], json.loads(request.content)))
        return httpx.Response(200, text="")

    app = create_app(make_settings(tmp_path, **SPACE))
    app.state.live_spacetime_transport = httpx.MockTransport(handler)
    with TestClient(app) as client:
        body = _request().model_dump(mode="json")
        assert client.post("/v1/coach", json=body).status_code == 200
    assert [name for name, _ in calls] == ["set_learner_progress"] and calls[0][1][0] == "kid-1"
    assert not (tmp_path / "store" / "learner_progress").exists()
