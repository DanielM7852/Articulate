"""Same-origin /phones relay, exercised against a stub upstream on an ephemeral port."""

import asyncio
import json
import logging
import socket
import threading
import time

import pytest
import uvicorn
import websockets
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from tests.support import make_settings

INDEX = "<!doctype html><title>Articulate app</title>"


def _stub_app() -> FastAPI:
    stub = FastAPI()
    stub.state.ws_origins = []
    stub.state.ws_open = 0

    @stub.get("/health")
    async def health(request: Request):
        return JSONResponse({"ok": True, "q": request.query_params.get("a")})

    @stub.post("/v1/phones/score")
    async def score(request: Request):
        body = await request.body()
        ctype = request.headers.get("content-type", "").encode()
        return Response(
            content=ctype + b"|" + body[::-1],
            status_code=202,
            media_type="application/x-test",
        )

    @stub.websocket("/ws/phones")
    async def ws_phones(ws: WebSocket):
        stub.state.ws_origins.append(ws.headers.get("origin"))
        stub.state.ws_open += 1
        await ws.accept()
        await ws.send_json({"type": "ready"})
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                stub.state.ws_open -= 1
                return
            if message.get("bytes") is not None:
                await ws.send_bytes(b"echo:" + message["bytes"])
            else:
                await ws.send_text("echo:" + message["text"])

    return stub


def _serve(app):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    assert server.started
    return server, thread, port


@pytest.fixture(scope="module")
def upstream():
    stub = _stub_app()
    server, thread, port = _serve(stub)
    yield stub, f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def backend_factory(tmp_path):
    started = []

    def start(phones_url, **overrides):
        server, thread, port = _serve(create_app(make_settings(tmp_path, phones_url=phones_url, **overrides)))
        started.append((server, thread))
        return f"ws://127.0.0.1:{port}/phones/ws"

    yield start
    for server, thread in started:
        server.should_exit = True
        thread.join(timeout=5)


def _client(tmp_path, phones_url, **overrides) -> TestClient:
    return TestClient(create_app(make_settings(tmp_path, phones_url=phones_url, **overrides)))


def _dead_url() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def test_http_get_relays_path_and_query(tmp_path, upstream):
    client = _client(tmp_path, upstream[1] + "/")
    res = client.get("/phones/health?a=1")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "q": "1"}


def test_http_post_relays_body_content_type_and_status(tmp_path, upstream):
    client = _client(tmp_path, upstream[1])
    res = client.post("/phones/v1/phones/score", content=b"abc", headers={"content-type": "application/x-in"})
    assert res.status_code == 202
    assert res.content == b"application/x-in|cba"
    assert res.headers["content-type"].startswith("application/x-test")


def test_http_disabled_is_json_404_even_with_frontend(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(INDEX, encoding="utf-8")
    client = TestClient(create_app(make_settings(tmp_path, static_dir=str(dist))))
    res = client.get("/phones/whatever")
    assert res.status_code == 404
    assert res.json() == {"detail": "phones_disabled"}
    nothing = client.get("/phones/ws-nothing")
    assert nothing.status_code == 404
    assert nothing.json() == {"detail": "phones_disabled"}


def test_spa_fallback_skips_phones_but_not_lookalikes(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(INDEX, encoding="utf-8")
    client = TestClient(create_app(make_settings(tmp_path, static_dir=str(dist))))
    assert client.get("/phones").status_code == 404
    assert client.get("/phones").headers["content-type"].startswith("application/json")
    assert client.get("/phones/anything").json() == {"detail": "phones_disabled"}
    assert client.get("/phones-practice").text == INDEX


def test_http_upstream_down_is_503(tmp_path):
    res = _client(tmp_path, _dead_url()).get("/phones/health")
    assert res.status_code == 503
    assert res.json() == {"detail": "phones_unavailable"}


def test_http_body_over_limit_is_413(tmp_path, upstream):
    client = _client(tmp_path, upstream[1])
    res = client.post("/phones/v1/phones/score", content=b"0" * (10 * 1024 * 1024 + 1))
    assert res.status_code == 413


async def test_ws_relays_binary_and_text_both_ways(upstream, backend_factory):
    stub, url = upstream
    stub.state.ws_origins.clear()
    async with websockets.connect(backend_factory(url)) as ws:
        assert json.loads(await ws.recv()) == {"type": "ready"}
        await ws.send(b"\x01\x02" * 800)
        assert await ws.recv() == b"echo:" + b"\x01\x02" * 800
        await ws.send('{"type":"reset"}')
        assert await ws.recv() == 'echo:{"type":"reset"}'
    assert stub.state.ws_origins == [None]
    for _ in range(100):
        if stub.state.ws_open == 0:
            break
        await asyncio.sleep(0.05)
    assert stub.state.ws_open == 0  # closing the browser side closes the upstream side


async def test_ws_bad_origin_rejected_1008(upstream, backend_factory):
    url = backend_factory(upstream[1])
    async with websockets.connect(url, origin="https://evil.example") as ws:
        assert json.loads(await ws.recv()) == {"type": "error", "message": "origin not allowed"}
        with pytest.raises(websockets.ConnectionClosed):
            await ws.recv()
    assert ws.close_code == 1008


async def test_ws_normal_browser_close_logs_no_error(upstream, backend_factory):
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    stub, url = upstream
    target = backend_factory(url)  # start first: uvicorn resets its loggers' handlers on startup
    handler = Capture(level=logging.WARNING)
    loggers = [logging.getLogger(n) for n in ("uvicorn.error", "app")]
    for lg in loggers:
        lg.addHandler(handler)
    try:
        async with websockets.connect(target) as ws:
            assert json.loads(await ws.recv()) == {"type": "ready"}
            await ws.send(b"\x00" * 64)
            assert await ws.recv() == b"echo:" + b"\x00" * 64
        await asyncio.sleep(0.5)  # let the relay's finally-block run
    finally:
        for lg in loggers:
            lg.removeHandler(handler)
    assert [r.getMessage() for r in records] == []


async def test_ws_same_host_forwarded_host_and_regex_origins_accepted(upstream, backend_factory):
    stub, url = upstream
    stub.state.ws_origins.clear()
    target = backend_factory(url, phones_proxy_origin_regex=r"https://[a-z0-9]+-8000\.proxy\.runpod\.net")
    host = target.split("/")[2]
    cases = [
        {"origin": f"http://{host}"},
        {"origin": "https://pod-8000.proxy.runpod.net", "headers": {"X-Forwarded-Host": "pod-8000.proxy.runpod.net"}},
        {"origin": "https://abc123-8000.proxy.runpod.net"},
        {"origin": "http://localhost:5173"},
    ]
    for case in cases:
        async with websockets.connect(
            target, origin=case["origin"], additional_headers=case.get("headers")
        ) as ws:
            assert json.loads(await ws.recv()) == {"type": "ready"}
    # The browser Origin is never forwarded upstream.
    assert stub.state.ws_origins == [None] * len(cases)


def test_ws_upstream_down_sends_error_then_closes_1011(tmp_path):
    client = _client(tmp_path, _dead_url())
    with client.websocket_connect("/phones/ws") as ws:
        assert ws.receive_json() == {"type": "error", "message": "phone model unavailable"}
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 1011


def test_ws_disabled_sends_error_then_closes_1011(tmp_path):
    client = _client(tmp_path, "")
    with client.websocket_connect("/phones/ws") as ws:
        assert ws.receive_json()["type"] == "error"
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 1011
