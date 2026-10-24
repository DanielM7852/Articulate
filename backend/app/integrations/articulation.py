"""Client for the local articulation collector (services/articulation). Optional; failures return None."""

import asyncio
import logging

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

SCHEMA = "articulate.articulation/1"
MAX_RETRY_WAIT_S = 5.0


class ArticulationClient:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = f"{settings.articulation_url.strip().rstrip('/')}/v1/articulation/analyze"
        self._models = settings.articulation_models
        self._timeout = settings.articulation_timeout_s
        self._transport = transport
        self._http = http

    async def _post(self, client: httpx.AsyncClient, wav: bytes, params: dict) -> httpx.Response:
        return await client.post(
            self._url, params=params, content=wav, headers={"Content-Type": "audio/wav"}, timeout=self._timeout
        )

    async def analyze(
        self,
        wav: bytes,
        *,
        attempt_id: str,
        capture_start_monotonic_ms: float | None,
        time_origin_unix_ms: float | None,
    ) -> dict | None:
        params: dict[str, str | float] = {"models": self._models, "attempt_id": attempt_id}
        if capture_start_monotonic_ms is not None and time_origin_unix_ms is not None:
            params["capture_start_monotonic_ms"] = capture_start_monotonic_ms
            params["time_origin_unix_ms"] = time_origin_unix_ms
        owned = self._http is None
        client = self._http or httpx.AsyncClient(transport=self._transport, timeout=self._timeout)
        try:
            response = await self._post(client, wav, params)
            if response.status_code == 503:
                try:
                    wait = float(response.headers.get("Retry-After", "2"))
                except ValueError:
                    wait = 2.0
                await asyncio.sleep(max(0.0, min(wait, MAX_RETRY_WAIT_S)))
                response = await self._post(client, wav, params)
            if response.status_code != 200:
                logger.warning("articulation analyze failed: status %s", response.status_code)
                return None
            bundle = response.json()
            if not isinstance(bundle, dict) or bundle.get("schemaVersion") != SCHEMA:
                logger.warning("articulation analyze failed: bad bundle")
                return None
            return bundle
        except Exception as exc:  # noqa: BLE001
            logger.warning("articulation analyze failed: %s", type(exc).__name__)
            return None
        finally:
            if owned:
                await client.aclose()
