"""Silent virtual learners (web/src/classroom/autoJoin.ts) on the hosts where the teacher backend runs.

The development route's guard is where the classroom database lives (the owner URI), not who is calling: the
deployed teaching console (deploy/teach) keeps the database on 127.0.0.1 inside the container and proxies
/v1/dev/ from its public host, so a learner on that host can be provisioned without a login.
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.classroom_routes import router as classroom_router
from app.classroom import provision
from tests.support import make_settings

PUBLIC = "lq1ms0f5forp7b-80.proxy.runpod.net"


def teach_service(settings) -> TestClient:
    """The deployed sign-in service (app.classroom.serve) with injected settings."""
    app = FastAPI()
    app.state.settings = settings
    app.include_router(classroom_router)
    return TestClient(app)


def write_owner(tmp_path, uri: str) -> None:
    store = tmp_path / "store"
    store.mkdir(parents=True, exist_ok=True)
    (store / "classroom_owner.json").write_text(
        json.dumps({"token": "owner", "database": "articulate-classroom", "uri": uri}), encoding="utf-8"
    )


@pytest.fixture
def minted(tmp_path, monkeypatch):
    invites: list[list] = []

    async def fake_reducer(owner, token, reducer, args):
        if reducer == "mint_invite":
            invites.append(args)

    async def fake_identity(owner):
        return f"tok-{len(invites)}"

    monkeypatch.setattr(provision, "call_reducer", fake_reducer)
    monkeypatch.setattr(provision, "_new_identity", fake_identity)
    monkeypatch.setattr(provision, "roster_path", lambda s: tmp_path / "roster.json")
    return invites


def test_public_host_mints_a_virtual_learner(tmp_path, minted):
    write_owner(tmp_path, "http://127.0.0.1:3000")
    client = teach_service(make_settings(tmp_path, classroom_public_from_host=True))
    r = client.post(
        "/v1/dev/classroom/session",
        json={"role": "learner", "name": "lea-k3f9", "classroom": "room-1"},
        headers={"Host": PUBLIC, "X-Forwarded-Proto": "https"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "learner" and body["profileId"] == "room-1-learner-lea-k3f9"
    assert body["uri"] == f"https://{PUBLIC}"  # the browser reaches the database through the public host
    assert len(minted) == 1 and minted[0][1:] == ["learner", "room-1-learner-lea-k3f9", "room-1", "lea-k3f9"]


def test_device_suffix_separates_profiles_and_a_device_keeps_its_own(tmp_path, minted):
    write_owner(tmp_path, "http://127.0.0.1:3000")
    client = teach_service(make_settings(tmp_path))
    first = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": "lea-k3f9", "classroom": "room-1"}).json()
    again = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": "lea-k3f9", "classroom": "room-1"}).json()
    other = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": "lea-p2x7", "classroom": "room-1"}).json()
    assert first["token"] == again["token"] and first["profileId"] == again["profileId"]
    assert other["profileId"] != first["profileId"] and other["token"] != first["token"]
    assert len(minted) == 2


def test_longest_virtual_learner_name_fits(tmp_path, minted):
    write_owner(tmp_path, "http://127.0.0.1:3000")
    client = teach_service(make_settings(tmp_path))
    name = "abcdefghijklmnopqrs-k3f9"  # 19 + "-" + 4 = 24, the cap autoJoin.ts keeps to
    assert len(name) == 24
    r = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": name, "classroom": "room-1"})
    assert r.status_code == 200
    r = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": name + "x", "classroom": "room-1"})
    assert r.status_code == 422


@pytest.mark.parametrize("role", ["learner", "teacher"])
def test_non_local_owner_still_refuses_both_roles(tmp_path, minted, role):
    write_owner(tmp_path, "https://maincloud.spacetimedb.com")
    client = teach_service(make_settings(tmp_path, classroom_public_from_host=True))
    r = client.post(
        "/v1/dev/classroom/session",
        json={"role": role, "name": "lea-k3f9", "classroom": "room-1"},
        headers={"Host": PUBLIC, "X-Forwarded-Proto": "https"},
    )
    assert r.status_code == 404
    assert minted == []


def test_no_owner_refuses_quietly(tmp_path, minted):
    client = teach_service(make_settings(tmp_path))
    r = client.post("/v1/dev/classroom/session", json={"role": "learner", "name": "learner-k3f9", "classroom": "room-1"})
    assert r.status_code == 404
    assert minted == []
