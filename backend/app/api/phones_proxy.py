"""Same-origin relay to the local phone-recognition service.

One exposed backend port reaches the phone model without CORS: WebSocket /phones/ws goes to
{phones_url}/ws/phones and HTTP /phones/{path} goes to {phones_url}/{path}. Disabled when
settings.phones_url is blank.
"""

import asyncio
import logging
import re
from urllib.parse import urlsplit

import httpx
import websockets
from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_BODY_BYTES = 10 * 1024 * 1024
UPSTREAM_TIMEOUT_S = 30.0
WS_CONNECT_TIMEOUT_S = 5.0
_FORWARD_REQUEST_HEADERS = ("content-type", "accept")


def _base(request_or_ws) -> str:
    return request_or_ws.app.state.settings.phones_url.strip().rstrip("/")


def _ws_url(base: str) -> str:
    parts = urlsplit(base)
    scheme = {"https": "wss", "http": "ws"}.get(parts.scheme, parts.scheme)
    return f"{scheme}://{parts.netloc}{parts.path.rstrip('/')}/ws/phones"


@router.api_route("/phones/{path:path}", methods=["GET", "POST"], include_in_schema=False)
async def relay_http(path: str, request: Request) -> Response:
    base = _base(request)
    if not base:
        return JSONResponse({"detail": "phones_disabled"}, status_code=404)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "payload_too_large"}, status_code=413)
    buffer = bytearray()
    async for chunk in request.stream():
        buffer.extend(chunk)
        if len(buffer) > MAX_BODY_BYTES:
            return JSONResponse({"detail": "payload_too_large"}, status_code=413)
    body = bytes(buffer)
    headers = {k: v for k in _FORWARD_REQUEST_HEADERS if (v := request.headers.get(k))}
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S) as client:
            upstream = await client.request(
                request.method,
                f"{base}/{path}",
                params=request.query_params.multi_items(),
                content=body or None,
                headers=headers,
            )
    except httpx.HTTPError:
        return JSONResponse({"detail": "phones_unavailable"}, status_code=503)
    out = {}
    if (ctype := upstream.headers.get("content-type")):
        out["content-type"] = ctype
    return Response(content=upstream.content, status_code=upstream.status_code, headers=out)


def _origin_allowed(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    if not origin:
        return True
    settings = ws.app.state.settings
    origin_host = urlsplit(origin).netloc
    hosts = {ws.headers.get("host"), ws.headers.get("x-forwarded-host")}
    if origin_host and origin_host in hosts:
        return True
    if origin in settings.cors_origin_list:
        return True
    pattern = settings.phones_proxy_origin_regex
    return bool(pattern) and re.fullmatch(pattern, origin) is not None


async def _safe(call) -> None:
    """Await a send/close on a socket the browser may already have closed."""
    try:
        await call
    except (WebSocketDisconnect, RuntimeError):
        pass


async def _browser_to_upstream(ws: WebSocket, upstream) -> None:
    while True:
        message = await ws.receive()
        if message["type"] == "websocket.disconnect":
            return
        if message.get("bytes") is not None:
            await upstream.send(message["bytes"])
        elif message.get("text") is not None:
            await upstream.send(message["text"])


async def _upstream_to_browser(ws: WebSocket, upstream) -> None:
    async for message in upstream:
        if isinstance(message, bytes):
            await ws.send_bytes(message)
        else:
            await ws.send_text(message)


@router.websocket("/phones/ws")
async def relay_ws(ws: WebSocket) -> None:
    if not _origin_allowed(ws):
        logger.warning(
            "phones ws rejected origin=%r host=%r x-forwarded-host=%r",
            ws.headers.get("origin"),
            ws.headers.get("host"),
            ws.headers.get("x-forwarded-host"),
        )
        # Accept first so the browser sees close code 1008, not a 403 handshake failure (1006).
        await ws.accept()
        await _safe(ws.send_json({"type": "error", "message": "origin not allowed"}))
        await _safe(ws.close(code=1008))
        return
    await ws.accept()
    base = _base(ws)
    upstream = None
    if base:
        try:
            upstream = await websockets.connect(
                _ws_url(base), open_timeout=WS_CONNECT_TIMEOUT_S, max_size=None, origin=None
            )
        except (OSError, TimeoutError, websockets.WebSocketException):
            upstream = None
    if upstream is None:
        await _safe(ws.send_json({"type": "error", "message": "phone model unavailable"}))
        await _safe(ws.close(code=1011))
        return
    pumps = [
        asyncio.create_task(_browser_to_upstream(ws, upstream)),
        asyncio.create_task(_upstream_to_browser(ws, upstream)),
    ]
    try:
        await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in pumps:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
        await upstream.close()
        await _safe(ws.close())
