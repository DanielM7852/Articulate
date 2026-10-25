"""Development identities for the classroom database.

A display name is not authority. The owner token mints a one-time invite, and
only the identity that accepts that invite is bound. The same name returns the
same token so two browsers for one learner share a profile.
"""

import json
import secrets
from pathlib import Path
from typing import Any

import httpx

from app.classroom.owner import load_owner
from app.config import Settings
from app.paths import BACKEND_ROOT

_NAMES = __import__("re").compile(r"^[a-z0-9-]{1,24}$")


class ClassroomError(RuntimeError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _known(body: str) -> str:
    lowered = body.lower()
    for code in (
        "revision conflict",
        "idempotency conflict",
        "not a teacher",
        "not a learner",
        "not in classroom",
        "backend only",
        "superseded",
        "expired",
        "invalid settings",
        "unknown invite",
        "invite already used",
        "identity already bound",
    ):
        if code in lowered:
            return code
    return "reducer failed"


def roster_path(settings: Settings) -> Path:
    del settings
    return BACKEND_ROOT / ".local_store" / "dev_classroom.json"


def _load_roster(settings: Settings) -> dict[str, Any]:
    path = roster_path(settings)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _save_roster(settings: Settings, roster: dict[str, Any]) -> None:
    path = roster_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(roster, indent=2), encoding="utf-8")


async def call_reducer(owner: dict, token: str, reducer: str, args: list[Any]) -> None:
    url = f"{owner['uri'].rstrip('/')}/v1/database/{owner['database']}/call/{reducer}"
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps(args),
        )
    if response.status_code >= 300:
        raise ClassroomError(_known(response.text), 409 if response.status_code >= 400 else 502)


async def _new_identity(owner: dict) -> str:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(f"{owner['uri'].rstrip('/')}/v1/identity")
    if response.status_code >= 300:
        raise ClassroomError("identity service unavailable", 503)
    token = response.json().get("token")
    if not isinstance(token, str) or not token:
        raise ClassroomError("identity service unavailable", 503)
    return token


async def open_dev_session(settings: Settings, role: str, name: str, classroom: str) -> dict[str, str]:
    owner = load_owner(settings)
    if owner is None:
        raise ClassroomError("classroom database is not configured", 503)
    if role not in {"teacher", "learner"} or not _NAMES.fullmatch(name) or not _NAMES.fullmatch(classroom):
        raise ClassroomError("invalid development identity", 422)
    key = f"{classroom}/{role}/{name}"
    roster = _load_roster(settings)
    existing = roster.get(key)
    if existing:
        return {**existing, "uri": owner["uri"], "database": owner["database"], "label": "development identity"}
    profile_id = f"{classroom}-{role}-{name}"
    code = secrets.token_hex(16)
    await call_reducer(
        owner,
        owner["token"],
        "mint_invite",
        [code, role, profile_id, classroom, name],
    )
    token = await _new_identity(owner)
    await call_reducer(owner, token, "accept_invite", [code])
    record = {
        "role": role,
        "name": name,
        "profileId": profile_id,
        "classroomId": classroom,
        "token": token,
    }
    roster[key] = record
    _save_roster(settings, roster)
    return {**record, "uri": owner["uri"], "database": owner["database"], "label": "development identity"}


async def commit_verified_summary(settings: Settings, args: list[Any]) -> bool:
    owner = load_owner(settings)
    if owner is None:
        return False
    try:
        await call_reducer(owner, owner["token"], "commit_verified_summary", args)
    except ClassroomError:
        return False
    return True
