"""Kind-routed component telemetry (docs/telemetry.md): azure.*, classroom.*, sparc.features and backend.up flags."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import telemetry
from app.api import classroom_routes
from app.audio import azure_pronunciation
from app.classroom import provision
from app.live import orchestrator
from app.live.schemas import LiveCoachRequest
from app.main import create_app
from tests.support import make_settings
from tests.test_articulation_route import AID, H, Q, URL, WAV, make, ok_handler
from tests.test_azure_pronunciation import raise_timeout, run_assess, sample
from tests.test_consonant_coach import client_for, draft, post
from tests.test_openai_coach import FakeOpenAI
from tests.test_word_acoustics import REAL, body

AZURE = dict(azure_speech_key="k", azure_speech_region="westus2")


@pytest.fixture
def events(monkeypatch):
    seen: list[tuple[str, str, str, dict]] = []

    def record(source, target, kind, label, payload=None):
        seen.append((source, target, kind, dict(payload or {})))

    monkeypatch.setattr(telemetry, "emit", record)
    return seen


def kinds(seen, prefix):
    return [e for e in seen if e[2].startswith(prefix)]


# ---- azure


def test_azure_request_and_result_carry_no_transcript_or_phoneme_scores(tmp_path, events):
    result, _ = run_assess(tmp_path, lambda r: httpx.Response(200, json=sample()))
    assert result is not None
    got = kinds(events, "azure.")
    assert [(s, t, k) for s, t, k, _ in got] == [("backend", "db", "azure.request"), ("backend", "db", "azure.result")]
    assert got[0][3] == {"word": "track"}
    res = got[1][3]
    assert set(res) == {"ms", "ok", "accuracy"} and res["ok"] is True and res["accuracy"] == 80.0
    assert isinstance(res["ms"], int) and res["ms"] >= 0
    assert "Track" not in json.dumps(res)


@pytest.mark.parametrize(("handler", "error"), [
    (lambda r: httpx.Response(500), "HTTPStatusError"),
    (raise_timeout, "ReadTimeout"),
    (lambda r: httpx.Response(200, json=sample(status="NoMatch")), "RecognitionFailed"),
])
def test_azure_failures_emit_error_with_type_name(tmp_path, events, handler, error):
    result, _ = run_assess(tmp_path, handler)
    assert result is None
    got = kinds(events, "azure.")
    assert [k for _, _, k, _ in got] == ["azure.request", "azure.error"]
    assert got[1][3]["error"] == error and isinstance(got[1][3]["ms"], int)


def test_azure_not_configured_assess_emits_nothing(tmp_path, events):
    async def go():
        return await azure_pronunciation.assess(REAL, "track", make_settings(tmp_path))

    assert asyncio.run(go()) is None
    assert kinds(events, "azure.") == []


def test_word_coach_reports_azure_skipped_not_configured(tmp_path, events):
    req = LiveCoachRequest.model_validate(body())
    block, ms = asyncio.run(orchestrator._assess_azure(make_settings(tmp_path), req, REAL))
    assert block is None and ms is None
    assert [(k, p) for _, _, k, p in kinds(events, "azure.")] == [("azure.skipped", {"reason": "not_configured"})]


def test_word_coach_reports_azure_skipped_without_audio(tmp_path, events):
    req = LiveCoachRequest.model_validate(body())
    asyncio.run(orchestrator._assess_azure(make_settings(tmp_path, **AZURE), req, None))
    assert [p["reason"] for _, _, k, p in kinds(events, "azure.skipped")] == ["no_audio"]


def test_word_coach_reports_azure_timeout(tmp_path, events, monkeypatch):
    async def slow(wav, ref, settings, http=None):
        await asyncio.sleep(0.5)

    monkeypatch.setattr(azure_pronunciation, "assess", slow)
    monkeypatch.setattr(orchestrator, "_AZURE_TIMEOUT_S", 0.05)
    req = LiveCoachRequest.model_validate(body())
    block, ms = asyncio.run(orchestrator._assess_azure(make_settings(tmp_path, **AZURE), req, REAL))
    assert block is None and ms is not None
    skipped = kinds(events, "azure.skipped")
    assert len(skipped) == 1 and skipped[0][3]["reason"] == "timeout" and isinstance(skipped[0][3]["ms"], int)


def test_consonant_coach_reports_azure_skipped_not_configured(tmp_path, events):
    post(client_for(tmp_path, FakeOpenAI(draft())))
    assert [p for _, _, k, p in kinds(events, "azure.")] == [{"reason": "not_configured"}]


# ---- classroom


@pytest.fixture
def classroom(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    store = tmp_path / "store"
    store.mkdir(parents=True, exist_ok=True)
    (store / "classroom_owner.json").write_text(
        json.dumps({"token": "owner", "database": "articulate-classroom", "uri": "http://127.0.0.1:3000"}),
        encoding="utf-8",
    )
    reducers: list[str] = []

    async def fake_reducer(owner, token, reducer, args):
        reducers.append(reducer)

    async def fake_identity(owner):
        return f"tok-{len(reducers)}"

    monkeypatch.setattr(provision, "call_reducer", fake_reducer)
    monkeypatch.setattr(provision, "_new_identity", fake_identity)
    monkeypatch.setattr(provision, "roster_path", lambda s: tmp_path / "roster.json")
    return settings, reducers


def test_classroom_session_and_scale_emit(classroom, events):
    settings, _ = classroom
    c = TestClient(create_app(settings))
    r = c.post("/v1/dev/classroom/session", json={"role": "teacher", "name": "ada", "classroom": "room-1"})
    assert r.status_code == 200
    r = c.post("/v1/dev/classroom/scale")
    assert r.status_code == 200 and len(r.json()["rooms"]) == len(provision.SCALE_ROOMS)
    got = kinds(events, "classroom.")
    assert [(s, t, k, p) for s, t, k, p in got] == [
        ("backend", "db", "classroom.session", {"role": "teacher"}),
        ("backend", "db", "classroom.scale", {"rooms": len(provision.SCALE_ROOMS)}),
    ]


def test_classroom_summary_emits_verified_flag(classroom, events):
    settings, reducers = classroom
    args = ["learner-1", "id", "head", True, "none", "verified", "x", "y", "z", "{}", False]
    assert asyncio.run(provision.commit_verified_summary(settings, args)) is True
    synthetic = [*args[:5], "synthetic", *args[6:]]
    assert asyncio.run(provision.commit_verified_summary(settings, synthetic)) is True
    assert reducers == ["commit_verified_summary", "commit_verified_summary"]
    assert [p for _, _, k, p in kinds(events, "classroom.summary")] == [{"verified": True}, {"verified": False}]


def test_classroom_summary_failure_emits_nothing(classroom, events, monkeypatch):
    settings, _ = classroom

    async def failing(owner, token, reducer, args):
        raise provision.ClassroomError("reducer failed", 409)

    monkeypatch.setattr(provision, "call_reducer", failing)
    assert asyncio.run(provision.commit_verified_summary(settings, ["p"] * 11)) is False
    assert kinds(events, "classroom.") == []


def test_classroom_routes_import_the_shared_emitter():
    assert classroom_routes.emit_classroom is provision.emit_classroom


# ---- sparc


def test_sparc_features_carries_ms_and_feature_count(tmp_path, events):
    c, h = make(tmp_path, ok_handler)
    r = c.post(URL + Q, content=WAV, headers=H)
    assert r.status_code == 202 and len(h.recorded) == 1
    feats = kinds(events, "sparc.features")
    assert len(feats) == 1
    source, target, _, payload = feats[0]
    assert (source, target) == ("sparc", "backend")
    assert isinstance(payload["ms"], int) and payload["ms"] >= 0 and payload["latencyMs"] == payload["ms"]
    stored = h.recorded[0][3]
    assert isinstance(payload["n"], int) and payload["n"] >= 1
    assert payload["n"] == len([k for k in stored if k != "pitchTable"])  # counted before the pitch table joins
    assert len(json.dumps(payload)) <= telemetry.PAYLOAD_MAX_BYTES
    assert AID not in json.dumps(payload)


def test_sparc_skipped_is_kept(tmp_path, events):
    c, _ = make(tmp_path, url="", pitch_table_enabled=False)
    assert c.post(URL + Q, content=WAV, headers=H).json() == {"accepted": False, "reason": "disabled"}
    assert [p for _, _, k, p in kinds(events, "sparc.")] == [{"reason": "disabled"}]


# ---- backend.up


def test_backend_up_reports_component_flags(tmp_path, events):
    settings = make_settings(tmp_path, word_acoustics_enabled=False, **AZURE)
    telemetry.emit_backend_up(settings, "configured")
    (_, _, kind, payload), = events
    assert kind == "backend.up"
    assert payload["azure"] is True and payload["praat"] is False and payload["classroom"] is False

    store = tmp_path / "store"
    store.mkdir(parents=True, exist_ok=True)
    (store / "classroom_owner.json").write_text(json.dumps({"token": "t", "database": "d", "uri": "http://127.0.0.1:3000"}),
                                                encoding="utf-8")
    telemetry.emit_backend_up(make_settings(tmp_path), "anonymous")
    payload = events[-1][3]
    assert payload["classroom"] is True and payload["azure"] is False and payload["praat"] is True
    assert {"provider", "model", "articulation", "pitchTable", "coordination", "telemetryIdentity"} <= set(payload)
