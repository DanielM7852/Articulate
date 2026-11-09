"""Abuse guard: per-IP and global limits on provider-spending routes, and the /phones/ws connection cap."""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.rate_limit import WINDOW_S, RateLimitMiddleware, SlidingWindow
from app.main import create_app
from tests.support import make_settings

SESSION = "/v1/realtime/session"
COACH_ROUTES = [
    "/v1/coach", "/v1/lesson-plan", "/v1/speech", "/v1/speech/token", "/v1/word-match",
    "/v1/live/coach", "/v1/live/word/ask", "/v1/live/consonant", "/v1/live/notes",
    "/v1/live/session/start", "/v1/live/session/turn", "/v1/live/articulation",
    "/v1/live/recap", "/v1/live/recap/abc123/email", "/v1/live/phrases", "/v1/live/phrases/assess",
]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def _stub(scope, receive, send):
    """Stands in for the real app: every HTTP request is 200, every websocket stays open until the client leaves."""
    if scope["type"] == "http":
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"ok"})
    elif scope["type"] == "websocket":
        await receive()
        await send({"type": "websocket.accept"})
        while (await receive())["type"] != "websocket.disconnect":
            pass


def _with_ip(app):
    """Outermost wrapper: the test picks the client IP per request via X-Test-IP (uvicorn does this from the socket)."""

    async def wrapper(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope["headers"])
            scope = {**scope, "client": (headers.get(b"x-test-ip", b"1.1.1.1").decode(), 5000)}
        await app(scope, receive, send)

    return wrapper


def _settings(tmp_path, **overrides):
    return make_settings(tmp_path, rate_limits_enabled=True, **overrides)


def _client(tmp_path, clock=None, **overrides) -> TestClient:
    middleware = RateLimitMiddleware(_stub, _settings(tmp_path, **overrides), **({"clock": clock} if clock else {}))
    return TestClient(_with_ip(middleware))


def _post(client, path, ip="1.1.1.1"):
    return client.post(path, headers={"x-test-ip": ip})


def test_sliding_window_expires_hits():
    clock = Clock()
    window = SlidingWindow(clock=clock)
    window.record("k")
    assert window.retry_after("k", 1) == WINDOW_S
    clock.now += WINDOW_S
    assert window.retry_after("k", 1) is None


def test_disabled_by_default_installs_nothing(tmp_path):
    settings = make_settings(tmp_path)
    assert settings.rate_limits_enabled is False
    app = create_app(settings)
    assert all(m.cls is not RateLimitMiddleware for m in app.user_middleware)
    with TestClient(app) as client:
        for _ in range(20):
            assert client.post(SESSION).status_code != 429


def test_enabled_installs_middleware(tmp_path):
    app = create_app(_settings(tmp_path))
    assert any(m.cls is RateLimitMiddleware for m in app.user_middleware)


def test_enabled_app_answers_429_before_the_route(tmp_path):
    settings = _settings(tmp_path, rate_limit_realtime_per_ip_hour=1)
    with TestClient(create_app(settings)) as client:
        assert client.post(SESSION).status_code != 429
        response = client.post(SESSION)
        assert response.status_code == 429
        assert client.get("/health").status_code == 200


def test_per_ip_limit_then_other_ip_then_window_reset(tmp_path):
    clock = Clock()
    client = _client(tmp_path, clock, rate_limit_realtime_per_ip_hour=2)
    assert _post(client, SESSION).status_code == 200
    clock.now += 10
    assert _post(client, SESSION).status_code == 200
    clock.now += 10
    blocked = _post(client, SESSION)
    assert blocked.status_code == 429
    # The oldest hit (t=1000) leaves the window at t=4600; now is t=1020.
    assert blocked.json() == {"detail": "rate_limited", "scope": "per_ip", "retryAfterS": 3580}
    assert blocked.headers["retry-after"] == "3580"
    assert _post(client, SESSION, ip="2.2.2.2").status_code == 200
    clock.now += 3580
    assert _post(client, SESSION).status_code == 200


def test_global_limit_spans_ips(tmp_path):
    client = _client(tmp_path, rate_limit_realtime_global_hour=2)
    assert _post(client, SESSION, ip="1.1.1.1").status_code == 200
    assert _post(client, SESSION, ip="2.2.2.2").status_code == 200
    blocked = _post(client, SESSION, ip="3.3.3.3")
    assert blocked.status_code == 429
    body = blocked.json()
    assert body["scope"] == "global"
    assert body["detail"] == "rate_limited"
    assert body["retryAfterS"] == int(blocked.headers["retry-after"]) >= 1


def test_blocked_request_does_not_use_budget(tmp_path):
    clock = Clock()
    client = _client(tmp_path, clock, rate_limit_realtime_per_ip_hour=1, rate_limit_realtime_global_hour=2)
    assert _post(client, SESSION, ip="1.1.1.1").status_code == 200
    for _ in range(5):
        assert _post(client, SESSION, ip="1.1.1.1").status_code == 429
    assert _post(client, SESSION, ip="2.2.2.2").status_code == 200


def test_coach_routes_share_one_budget(tmp_path):
    client = _client(tmp_path, rate_limit_coach_per_ip_hour=len(COACH_ROUTES))
    for path in COACH_ROUTES:
        assert _post(client, path).status_code == 200, path
    for path in COACH_ROUTES:
        assert _post(client, path).status_code == 429, path
    # A separate group: the realtime budget is untouched.
    assert _post(client, SESSION).status_code == 200


def test_unlimited_routes_are_never_limited(tmp_path):
    client = _client(
        tmp_path, rate_limit_coach_per_ip_hour=1, rate_limit_realtime_per_ip_hour=1,
    )
    for _ in range(5):
        assert client.get("/health", headers={"x-test-ip": "1.1.1.1"}).status_code == 200
        assert client.get("/v1/live/identity").status_code == 200
        assert client.get("/v1/live/recap/abc123").status_code == 200
        assert client.get(SESSION).status_code == 200  # GET is never limited, even on a limited path
        assert client.post("/phones/health").status_code == 200
        assert client.post("/v1/live/jobs/abc").status_code == 200


def test_phones_ws_per_ip_cap_and_release(tmp_path):
    client = _client(tmp_path, rate_limit_phones_ws_per_ip=2, rate_limit_phones_ws_global=10)
    headers = {"x-test-ip": "1.1.1.1"}
    with client.websocket_connect("/phones/ws", headers=headers):
        with client.websocket_connect("/phones/ws", headers=headers):
            with client.websocket_connect("/phones/ws", headers=headers) as third:
                assert third.receive_json()["type"] == "error"
                with pytest.raises(WebSocketDisconnect) as closed:
                    third.receive_json()
                assert closed.value.code == 1008
            # Another IP is unaffected.
            with client.websocket_connect("/phones/ws", headers={"x-test-ip": "2.2.2.2"}) as other:
                other.send_text("hi")
        # One of the two is gone, so a new one fits again.
        with client.websocket_connect("/phones/ws", headers=headers) as again:
            again.send_text("hi")


def test_phones_ws_global_cap(tmp_path):
    client = _client(tmp_path, rate_limit_phones_ws_per_ip=2, rate_limit_phones_ws_global=2)
    with client.websocket_connect("/phones/ws", headers={"x-test-ip": "1.1.1.1"}):
        with client.websocket_connect("/phones/ws", headers={"x-test-ip": "2.2.2.2"}):
            with client.websocket_connect("/phones/ws", headers={"x-test-ip": "3.3.3.3"}) as third:
                assert third.receive_json()["type"] == "error"
                with pytest.raises(WebSocketDisconnect) as closed:
                    third.receive_json()
                assert closed.value.code == 1008


def test_phones_ws_released_when_relay_closes_immediately(tmp_path):
    """Real app, no PHONES_URL: the relay accepts then closes 1011 itself; each connection must still be released."""
    settings = _settings(tmp_path, rate_limit_phones_ws_per_ip=1, rate_limit_phones_ws_global=1)
    with TestClient(create_app(settings)) as client:
        for _ in range(3):
            with client.websocket_connect("/phones/ws") as ws:
                assert ws.receive_json()["message"] == "phone model unavailable"
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 1011
