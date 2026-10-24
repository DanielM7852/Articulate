"""POST /v1/realtime/session: mint an OpenAI Realtime ephemeral client secret for the browser.

The browser uses the secret (ek_...) to POST its SDP offer to CALLS_URL. The project key never leaves here.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.realtime.session_config import CALLS_URL, CLIENT_SECRETS_URL, client_secret_request
from app.realtime.settings import RealtimeSettings, get_realtime_settings

logger = logging.getLogger("app.realtime")

router = APIRouter(prefix="/v1/realtime", tags=["realtime"])


class RealtimeSessionResponse(BaseModel):
    client_secret: str
    expires_at: int
    model: str
    calls_url: str
    session_id: str | None = None


async def mint_client_secret(settings: RealtimeSettings, client: httpx.AsyncClient | None = None) -> dict:
    """Return OpenAI's client-secret response (value, expires_at, session). Raises HTTPException on failure."""
    if not settings.openai_configured:
        raise HTTPException(status_code=503, detail="openai_not_configured")
    headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
    owns = client is None
    active = client or httpx.AsyncClient(timeout=settings.realtime_timeout_s)
    try:
        try:
            res = await active.post(CLIENT_SECRETS_URL, headers=headers, json=client_secret_request(settings))
        except httpx.HTTPError as exc:
            logger.info("realtime client secret request failed (%s)", type(exc).__name__)
            raise HTTPException(status_code=502, detail="realtime_secret_failed") from exc
    finally:
        if owns:
            await active.aclose()
    if res.status_code != 200:
        # OpenAI error bodies do not echo the key; log status and a truncated message only.
        logger.info("realtime client secret rejected: %s %s", res.status_code, res.text[:300])
        raise HTTPException(status_code=502, detail="realtime_secret_failed")
    data = res.json()
    if not isinstance(data, dict) or not isinstance(data.get("value"), str) or not data["value"]:
        raise HTTPException(status_code=502, detail="realtime_secret_failed")
    return data


def get_realtime_http() -> httpx.AsyncClient | None:
    """Override in tests with a client on an httpx.MockTransport; None opens a short-lived client per call."""
    return None


@router.post("/session", response_model=RealtimeSessionResponse)
async def realtime_session(
    settings: RealtimeSettings = Depends(get_realtime_settings),
    client: httpx.AsyncClient | None = Depends(get_realtime_http),
) -> RealtimeSessionResponse:
    data = await mint_client_secret(settings, client)
    session = data.get("session") if isinstance(data.get("session"), dict) else {}
    return RealtimeSessionResponse(
        client_secret=data["value"],
        expires_at=int(data.get("expires_at") or 0),
        model=str(session.get("model") or settings.realtime_model),
        calls_url=CALLS_URL,
        session_id=session.get("id"),
    )
