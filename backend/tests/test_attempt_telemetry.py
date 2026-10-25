"""attemptId on telemetry (docs/telemetry.md "Attempt id"): set by request scope, copied into worker threads."""

import asyncio
import json
import threading

import pytest
from fastapi.testclient import TestClient

from app import telemetry
from app.classroom import provision
from app.main import create_app
from tests.support import make_settings
from tests.test_articulation_route import AID, H, Q, URL, WAV, FakeHistory, make, ok_handler
from tests.test_live_api import FakeClient
from tests.test_live_word import word_decision
from tests.test_pitch_table import _sine_wav
from tests.test_word_acoustics import anthropic_client, body

OTHER = "7c2f4a9e-1b3d-4e5f-8a6b-9c0d1e2f3a4b"


@pytest.fixture
def sent(monkeypatch):
    """Run the real `emit` (so the attempt scope is applied) and capture what would go to the reducer."""
    seen: list[tuple[str, dict]] = []
    lock = threading.Lock()

    def spawn(args):
        with lock:
            seen.append((args[2], json.loads(args[4])))
        with telemetry._lock:
            telemetry._inflight = max(0, telemetry._inflight - 1)

    class Loop:  # events from worker threads are handed over synchronously
        def is_closed(self):
            return False

        def call_soon_threadsafe(self, fn, *args):
            fn(*args)

    monkeypatch.setattr(telemetry, "_client", object())
    monkeypatch.setattr(telemetry, "_loop", Loop())
    monkeypatch.setattr(telemetry, "_spawn", spawn)
    return seen


def of(seen, prefix):
    return [(k, p) for k, p in seen if k.startswith(prefix)]


def test_emit_outside_any_request_has_no_attempt_id(sent):
    telemetry.emit("backend", "db", "db.read", "read x", {"table": "x", "rows": 1})
    telemetry.emit("backend", "db", "db.read", "read y")
    assert [p for _, p in sent] == [{"table": "x", "rows": 1}, {}]
    assert telemetry.current_attempt.get() is None


def test_scope_adds_attempt_id_without_overriding_an_explicit_one(sent):
    with telemetry.attempt_scope(AID):
        telemetry.emit("backend", "db", "db.read", "read x", {"table": "x"})
        telemetry.emit("backend", "db", "db.read", "read y", None)
        telemetry.emit("backend", "db", "db.read", "read z", {"attemptId": OTHER})
        with telemetry.attempt_scope(None):  # a missing id keeps the outer scope
            telemetry.emit("backend", "db", "db.read", "read w", {})
    telemetry.emit("backend", "db", "db.read", "after", {})
    assert [p.get("attemptId") for _, p in sent] == [AID, AID, OTHER, AID, None]


def test_scope_reaches_to_thread_and_tasks(sent):
    async def write():
        await asyncio.sleep(0)
        telemetry.emit("backend", "db", "db.write", "w", {})

    async def go():
        with telemetry.attempt_scope(AID):
            await asyncio.to_thread(telemetry.emit, "pitch", "backend", "pitch.result", "f0", {})
            task = asyncio.create_task(write())
        await task  # created inside the scope, finishes after it closed

    asyncio.run(go())
    assert [p["attemptId"] for _, p in sent] == [AID, AID]


def test_word_coach_claude_and_pitch_events_carry_the_attempt_id(tmp_path, sent):
    fake = FakeClient(word_decision())
    r = anthropic_client(tmp_path, fake).post("/v1/live/coach", json=body())
    assert r.status_code == 200 and r.json()["attemptId"] == AID
    claude, pitch = of(sent, "claude."), of(sent, "pitch.")
    assert [k for k, _ in claude] == ["claude.request", "claude.response"]  # the model call ran in a worker thread
    assert [k for k, _ in pitch] == ["pitch.extract", "pitch.result"]
    assert all(p["attemptId"] == AID for _, p in claude + pitch)
    assert all(p.get("attemptId") == AID for k, p in sent if k.startswith("coach."))
    assert telemetry.current_attempt.get() is None


def test_two_requests_do_not_share_an_attempt_id(tmp_path, sent):
    client = anthropic_client(tmp_path, FakeClient(word_decision()))
    first = body()
    second = body()
    second["attemptId"] = second["word"]["attemptId"] = OTHER
    assert client.post("/v1/live/coach", json=first).status_code == 200
    split = len(sent)
    assert client.post("/v1/live/coach", json=second).status_code == 200
    assert {p.get("attemptId") for k, p in sent[:split] if k.startswith(("claude.", "pitch."))} == {AID}
    assert {p.get("attemptId") for k, p in sent[split:] if k.startswith(("claude.", "pitch."))} == {OTHER}


def test_articulation_background_job_carries_the_attempt_id(tmp_path, sent):
    c, h = make(tmp_path, ok_handler)
    assert c.post(URL + Q, content=WAV, headers=H).status_code == 202 and len(h.recorded) == 1
    sparc = of(sent, "sparc.")
    assert [k for k, _ in sparc] == ["sparc.request", "sparc.features"]
    assert all(p["attemptId"] == AID for _, p in sparc)


def test_articulation_skipped_carries_the_attempt_id(tmp_path, sent):
    c, _ = make(tmp_path, url="", pitch_table_enabled=False)
    assert c.post(URL + Q, content=WAV, headers=H).json() == {"accepted": False, "reason": "disabled"}
    assert of(sent, "sparc.") == [("sparc.skipped", {"reason": "disabled", "attemptId": AID})]


# ---- /v1/word-match: one id for the stored table, the classroom card and the events


@pytest.fixture
def classroom(tmp_path, monkeypatch):
    store = tmp_path / "store"
    store.mkdir(parents=True, exist_ok=True)
    (store / "classroom_owner.json").write_text(
        json.dumps({"token": "owner", "database": "articulate-classroom", "uri": "http://127.0.0.1:3000"}),
        encoding="utf-8",
    )
    calls: list[list] = []

    async def fake_reducer(owner, token, reducer, args):
        calls.append(args)

    monkeypatch.setattr(provision, "call_reducer", fake_reducer)
    return calls


def _match(tmp_path, query):
    app = create_app(make_settings(tmp_path, articulation_url=""))
    history = FakeHistory()
    app.state.live_history = history
    r = TestClient(app).post(f"/v1/word-match?profileId=learner-abc{query}", content=_sine_wav(), headers=H)
    return r, history


def test_word_match_uses_one_attempt_id_for_card_table_and_events(tmp_path, sent, classroom):
    r, history = _match(tmp_path, "")
    assert r.status_code == 200
    minted = r.json()["attemptId"]
    assert history.recorded[0][1] == minted
    assert classroom[0][1] == minted  # learner_attempt_cards.attempt_id
    pitch = of(sent, "pitch.")
    assert pitch and all(p["attemptId"] == minted for _, p in pitch)
    assert [p["attemptId"] for _, p in of(sent, "classroom.summary")] == [minted]


def test_word_match_keeps_the_browser_attempt_id(tmp_path, sent, classroom):
    r, history = _match(tmp_path, f"&attemptId={AID}")
    assert r.status_code == 200 and r.json()["attemptId"] == AID
    assert history.recorded[0][1] == AID and classroom[0][1] == AID
    assert all(p["attemptId"] == AID for _, p in of(sent, "pitch."))


def test_word_match_rejects_a_malformed_attempt_id(tmp_path, sent):
    r, _ = _match(tmp_path, "&attemptId=not-a-uuid")
    assert r.status_code == 422
