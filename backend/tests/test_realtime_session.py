"""Realtime persona: session config payload and the client-secret route (no network)."""

import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.realtime.persona import CLIENT_TOOLS, TOOLS, instructions
from app.realtime.routes import get_realtime_http, router
from app.realtime.session_config import CLIENT_SECRETS_URL, client_secret_request, session_config
from app.realtime.settings import RealtimeSettings, get_realtime_settings


def _settings(**overrides) -> RealtimeSettings:
    data = {"openai_api_key": "sk-test-not-real"}
    data.update(overrides)
    return RealtimeSettings(_env_file=None, **data)


def test_session_config_is_text_only_with_semantic_vad_and_transcription():
    cfg = session_config(_settings())
    assert cfg["type"] == "realtime"
    assert cfg["model"] == "gpt-realtime-2.1-mini"
    assert cfg["output_modalities"] == ["text"]
    audio_in = cfg["audio"]["input"]
    assert audio_in["turn_detection"] == {
        "type": "semantic_vad",
        "eagerness": "medium",
        "create_response": True,
        "interrupt_response": True,
    }
    assert audio_in["transcription"]["model"]
    assert "output" not in cfg["audio"]
    assert cfg["tool_choice"] == "auto"
    assert "Ava" in cfg["instructions"]


def test_model_and_eagerness_are_configurable():
    cfg = session_config(_settings(realtime_model="gpt-realtime-2.1", realtime_vad_eagerness="low"))
    assert cfg["model"] == "gpt-realtime-2.1"
    assert cfg["audio"]["input"]["turn_detection"]["eagerness"] == "low"


def test_tools_are_the_persona_tools():
    names = [t["name"] for t in TOOLS]
    assert names == ["get_coaching", "start_practice", "end_practice", "learner_attempt", "stay_quiet", "ask_coach"]
    assert all(t["type"] == "function" for t in TOOLS)
    coaching = TOOLS[0]["parameters"]
    assert coaching["required"] == ["attempt_id"]
    assert CLIENT_TOOLS == {"start_practice", "end_practice", "learner_attempt", "stay_quiet"}
    by_name = {t["name"]: t["parameters"] for t in TOOLS}
    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    assert by_name["learner_attempt"] == empty and by_name["stay_quiet"] == empty
    assert by_name["ask_coach"]["required"] == ["question"]
    json.dumps(TOOLS)  # serialisable as sent


def test_instructions_carry_the_persona_rules():
    text = instructions("Ava").lower()
    for rule in ("one or two short sentences", "never judge pronunciation", "never say \"listen\", \"hear\"",
                 "stay silent", "get_coaching", "captions", "digits"):
        assert rule in text, rule


def test_instructions_classify_turns_and_route_through_tools():
    text = instructions("Ava")
    for token in ("[app]", "learner_attempt", "stay_quiet", "ask_coach", "start_practice", "end_practice",
                  "truck", "three words or fewer", "untrusted", "Claude speech coach"):
        assert token in text, token
    assert len(text.split()) < 900


def test_client_secret_request_wraps_session_with_ttl():
    body = client_secret_request(_settings(realtime_secret_ttl_s=300))
    assert body["expires_after"] == {"anchor": "created_at", "seconds": 300}
    assert body["session"]["output_modalities"] == ["text"]


def _app(settings: RealtimeSettings, handler) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_realtime_settings] = lambda: settings
    app.dependency_overrides[get_realtime_http] = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TestClient(app)


def test_route_mints_and_returns_the_secret_only():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "value": "ek_test",
            "expires_at": 1_900_000_000,
            "session": {"id": "sess_1", "model": "gpt-realtime-2.1-mini", "type": "realtime"},
        })

    res = _app(_settings(), handler).post("/v1/realtime/session")
    assert res.status_code == 200
    assert res.json() == {
        "client_secret": "ek_test",
        "expires_at": 1_900_000_000,
        "model": "gpt-realtime-2.1-mini",
        "calls_url": "https://api.openai.com/v1/realtime/calls",
        "session_id": "sess_1",
    }
    assert seen["url"] == CLIENT_SECRETS_URL
    assert seen["auth"] == "Bearer sk-test-not-real"
    assert seen["body"]["session"]["output_modalities"] == ["text"]
    assert "sk-test-not-real" not in res.text


def test_route_without_key_is_503():
    res = _app(_settings(openai_api_key=None), lambda r: httpx.Response(500)).post("/v1/realtime/session")
    assert res.status_code == 503
    assert res.json()["detail"] == "openai_not_configured"


def test_route_upstream_error_is_502_without_leaking():
    res = _app(_settings(), lambda r: httpx.Response(400, json={"error": {"message": "bad model"}})).post(
        "/v1/realtime/session"
    )
    assert res.status_code == 502
    assert res.json()["detail"] == "realtime_secret_failed"
    assert "sk-test" not in res.text
