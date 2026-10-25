"""Classroom owner from the backend's SpacetimeDB settings, and dev identities on a non-local database."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.classroom_routes import router as classroom_router
from app.classroom import provision
from app.classroom.owner import load_owner
from tests.support import make_settings

MAINCLOUD = "https://maincloud.spacetimedb.com"


def env_settings(tmp_path, **overrides):
    data = {"spacetime_token": "backend-token", "spacetime_database": "articulate-live"}
    data.update(overrides)
    return make_settings(tmp_path, **data)


def client_for(settings) -> TestClient:
    app = FastAPI()
    app.state.settings = settings
    app.include_router(classroom_router)
    return TestClient(app)


@pytest.fixture
def minted(tmp_path, monkeypatch):
    calls: list[tuple] = []

    async def fake_reducer(owner, token, reducer, args):
        calls.append((owner["database"], token, reducer))

    async def fake_identity(owner):
        return "learner-token"

    monkeypatch.setattr(provision, "call_reducer", fake_reducer)
    monkeypatch.setattr(provision, "_new_identity", fake_identity)
    return calls


def test_owner_from_env(tmp_path):
    assert load_owner(env_settings(tmp_path)) == {"token": "backend-token", "database": "articulate-live", "uri": MAINCLOUD}


def test_classroom_settings_override(tmp_path):
    owner = load_owner(env_settings(tmp_path, classroom_database="other", classroom_uri="https://example.test"))
    assert owner == {"token": "backend-token", "database": "other", "uri": "https://example.test"}


def test_no_token_or_database_means_no_owner(tmp_path):
    assert load_owner(env_settings(tmp_path, spacetime_token=None)) is None
    assert load_owner(env_settings(tmp_path, spacetime_database=None)) is None


def test_owner_file_wins_over_env(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    (store / "classroom_owner.json").write_text(
        json.dumps({"token": "file", "database": "articulate-classroom", "uri": "http://127.0.0.1:3000"}), encoding="utf-8"
    )
    assert load_owner(env_settings(tmp_path))["token"] == "file"


def test_dev_routes_off_for_maincloud_by_default(tmp_path, minted):
    client = client_for(env_settings(tmp_path))
    assert client.get("/v1/dev/classroom/status").json()["configured"] is False
    r = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": "lea", "classroom": "room-1"})
    assert r.status_code == 404 and minted == []


def test_dev_routes_open_for_maincloud_with_flag(tmp_path, minted):
    client = client_for(env_settings(tmp_path, classroom_dev_identities=True))
    status = client.get("/v1/dev/classroom/status").json()
    assert status["configured"] is True and status["database"] == "articulate-live" and status["uri"] == MAINCLOUD
    r = client.post("/v1/dev/classroom/session", json={"role": "teacher", "name": "ada", "classroom": "room-1"})
    assert r.status_code == 200
    assert r.json()["uri"] == MAINCLOUD and r.json()["database"] == "articulate-live"
    assert minted == [("articulate-live", "backend-token", "mint_invite"), ("articulate-live", "learner-token", "accept_invite")]


def test_remote_roster_key_is_scoped_and_roster_follows_store_dir(tmp_path, minted):
    settings = env_settings(tmp_path, classroom_dev_identities=True)
    client_for(settings).post("/v1/dev/classroom/session", json={"role": "learner", "name": "lea", "classroom": "room-1"})
    path = tmp_path / "store" / "dev_classroom.json"
    assert provision.roster_path(settings) == path
    assert list(json.loads(path.read_text(encoding="utf-8"))) == ["articulate-live@maincloud.spacetimedb.com/room-1/learner/lea"]


def test_local_roster_key_is_unchanged(tmp_path):
    owner = {"token": "t", "database": "articulate-classroom", "uri": "http://127.0.0.1:3000"}
    assert provision.roster_key(owner, "room-1", "learner", "lea") == "room-1/learner/lea"


def test_relative_store_dir_resolves_under_backend_root():
    from app.paths import BACKEND_ROOT

    from app.config import Settings

    settings = Settings(_env_file=None, store_dir=".local_store")
    assert provision.roster_path(settings) == BACKEND_ROOT / ".local_store" / "dev_classroom.json"
