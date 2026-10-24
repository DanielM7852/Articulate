"""Short-lived Cartesia token route for browser streaming speech."""

import json

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from tests.support import make_settings

KEY = "sk_secret_key_123"


def _client(tmp_path, handler=None, **overrides):
    settings = make_settings(tmp_path, **overrides)
    app = create_app(settings)
    if handler is not None:
        app.state.cartesia_client = httpx.Client(transport=httpx.MockTransport(handler))
    return TestClient(app)


def test_token_configured_returns_fields_and_no_key(tmp_path):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["version"] = request.headers["Cartesia-Version"]
        seen["body"] = request.content
        return httpx.Response(200, json={"token": "short-lived-token"})

    client = _client(tmp_path, handler, cartesia_api_key=KEY, cartesia_voice_id="voice-1")
    response = client.post("/v1/speech/token")
    assert response.status_code == 200
    data = response.json()
    assert data["token"] == "short-lived-token"
    assert data["voice_id"] == "voice-1"
    assert data["ws_url"] == "wss://api.cartesia.ai/tts/websocket"
    assert data["sample_rate"] == 24000
    assert data["encoding"] == "pcm_f32le"
    assert data["cartesia_version"] == "2026-08-14"
    assert data["model_id"] and data["expires_at"].endswith("Z")
    assert seen["url"] == "https://api.cartesia.ai/access-token"
    assert seen["auth"] == f"Bearer {KEY}"
    assert b'"expires_in":120' in seen["body"].replace(b" ", b"")
    assert json.loads(seen["body"])["grants"] == {"tts": True, "stt": True}
    assert KEY not in response.text


def test_token_not_configured_is_503(tmp_path):
    response = _client(tmp_path).post("/v1/speech/token")
    assert response.status_code == 503
    assert response.json() == {"detail": "cartesia_not_configured"}


def test_token_upstream_error_is_502(tmp_path):
    client = _client(tmp_path, lambda r: httpx.Response(401, json={"error": "bad"}), cartesia_api_key=KEY, cartesia_voice_id="v")
    response = client.post("/v1/speech/token")
    assert response.status_code == 502
    assert response.json() == {"detail": "cartesia_token_failed"}
    assert KEY not in response.text


def test_token_upstream_timeout_is_502(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    client = _client(tmp_path, handler, cartesia_api_key=KEY, cartesia_voice_id="v")
    assert client.post("/v1/speech/token").json() == {"detail": "cartesia_token_failed"}


def test_token_missing_field_is_502(tmp_path):
    client = _client(tmp_path, lambda r: httpx.Response(200, json={"nope": 1}), cartesia_api_key=KEY, cartesia_voice_id="v")
    assert client.post("/v1/speech/token").status_code == 502
