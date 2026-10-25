"""Minimal SpacetimeDB HTTP client (SQL reads and reducer calls) for the backend identity.

Wire format assumptions (not verified against Maincloud; see docs/live-metrics.md):
  POST {uri}/v1/database/{db}/sql        body = SQL text -> JSON array of {schema, rows}
  POST {uri}/v1/database/{db}/call/{fn}  body = JSON array of positional args
The token is only ever sent as a Bearer header and is never logged or returned.
"""

import json
import logging
import re
from typing import Any

import httpx

from app import telemetry
from app.config import Settings

logger = logging.getLogger(__name__)

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_IDENT = r'(?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)'
_FROM = re.compile(rf"\bfrom\s+({_IDENT}(?:\s*\.\s*{_IDENT})*)", re.IGNORECASE)
_STRING = re.compile(r"'(?:[^']|'')*'")
_PROFILE = re.compile(r"^[A-Za-z0-9_.:@-]{1,64}$")


class SpacetimeError(RuntimeError):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def sql_literal(value: str) -> str:
    """Single-quoted SQL string literal with quotes doubled."""
    return "'" + value.replace("'", "''") + "'"


def uuid_literal(value: str) -> str:
    if not _UUID.fullmatch(value):
        raise SpacetimeError("invalid attempt id")
    return sql_literal(value)


def profile_literal(value: str) -> str:
    if not _PROFILE.fullmatch(value):
        raise SpacetimeError("invalid profile id")
    return sql_literal(value)


def table_of(query: str) -> str:
    """Table of the first FROM in a SQL string: literals ignored, quotes and schema prefix dropped."""
    try:
        match = _FROM.search(_STRING.sub("''", query))
        if not match:
            return "unknown"
        name = re.findall(_IDENT, match.group(1))[-1]
        if name[:1] == '"':
            name = name[1:-1].replace('""', '"')
        elif name[:1] in ("`", "["):
            name = name[1:-1]
        return name or "unknown"
    except Exception:  # noqa: BLE001 - only labels a telemetry event
        return "unknown"


def unwrap(value: Any) -> Any:
    """Unwrap option encodings: {"some": x}, {"none": ...}, [0, x] / [1, []]."""
    if isinstance(value, dict):
        if "some" in value:
            return unwrap(value["some"])
        if "none" in value:
            return None
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], int) and value[0] in (0, 1):
        return None if value[0] == 1 else unwrap(value[1])
    return value


def _column_name(element: Any, index: int) -> str:
    name = element.get("name") if isinstance(element, dict) else element
    name = unwrap(name)
    return name if isinstance(name, str) else f"col{index}"


def rows_as_dicts(result: Any) -> list[dict[str, Any]]:
    """Map positional rows to {column: value} using the response schema. Tolerates dict rows."""
    out: list[dict[str, Any]] = []
    sets = result if isinstance(result, list) else [result]
    for item in sets:
        if not isinstance(item, dict):
            continue
        schema = item.get("schema") or {}
        elements = schema.get("elements") if isinstance(schema, dict) else None
        names = [_column_name(e, i) for i, e in enumerate(elements or [])]
        for row in item.get("rows") or []:
            if isinstance(row, dict):
                out.append(row)
            elif isinstance(row, list):
                out.append({(names[i] if i < len(names) else f"col{i}"): v for i, v in enumerate(row)})
    return out


def timestamp_micros(value: Any) -> int:
    """Best-effort microseconds since epoch from a SpacetimeDB timestamp (used for ordering only)."""
    value = unwrap(value)
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, dict):
        for v in value.values():
            return timestamp_micros(v)
    if isinstance(value, list) and value:
        return timestamp_micros(value[0])
    return 0


def new_http_client(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """Long-lived pooled client (keeps TLS connections warm across requests)."""
    return httpx.AsyncClient(
        transport=transport,
        timeout=8.0,
        headers={"Authorization": f"Bearer {settings.spacetime_token or ''}"},
    )


class SpacetimeClient:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._http = http
        self._base = f"{settings.spacetime_uri.rstrip('/')}/v1/database/{settings.spacetime_database}"
        self._token = settings.spacetime_token or ""
        self._transport = transport
        self._timeout = 8.0

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=self._transport,
            timeout=self._timeout,
            headers={"Authorization": f"Bearer {self._token}"},
        )

    async def sql(self, query: str) -> list[dict[str, Any]]:
        if self._http is not None:
            response = await self._http.post(f"{self._base}/sql", content=query.encode("utf-8"))
        else:
            async with self._client() as client:
                response = await client.post(f"{self._base}/sql", content=query.encode("utf-8"))
        if response.status_code >= 300:
            raise SpacetimeError(f"sql failed: HTTP {response.status_code}")
        try:
            rows = rows_as_dicts(response.json())
        except ValueError as exc:
            raise SpacetimeError("sql returned invalid JSON") from exc
        table = table_of(query)
        telemetry.emit("backend", "db", "db.read", f"read {table}", {"table": table, "rows": len(rows)})
        return rows

    async def call(self, reducer: str, args: list[Any]) -> None:
        url, content, headers = f"{self._base}/call/{reducer}?confirmed=true", json.dumps(args), {"Content-Type": "application/json"}
        if self._http is not None:
            response = await self._http.post(url, content=content, headers=headers)
        else:
            async with self._client() as client:
                response = await client.post(url, content=content, headers=headers)
        if response.status_code >= 300:
            # Only expose known policy errors, never an arbitrary provider body or credentials.
            known = ("queue full", "revision conflict", "session not found", "profile mismatch",
                     "idempotency conflict", "attempt already exists", "stale lease", "session busy", "job already leased")
            code = next((value for value in known if value in response.text.lower()), None)
            raise SpacetimeError(f"reducer {reducer} failed: HTTP {response.status_code}", code)
        if reducer != telemetry.REDUCER:  # never report the telemetry reducer itself (would loop)
            telemetry.emit("backend", "db", "db.write", f"write {reducer}", {"table": reducer, "rows": 1})
