"""API/worker round trips across independent replicas. No live providers or database.

Reducer concurrency and atomicity are exercised separately by the WASM datastore tests.
This small HTTP fake checks Python's real wire arguments, result polling and recovery.
"""

import json
import time
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.live.coordination import Coordination
from app.live.history import LearnerContext
from app.live.identity import COOKIE
from app.live.orchestrator import LiveDeps
from app.live.runtime import get_runtime
from app.live.worker import Worker
from app.main import create_app
from tests.support import make_settings
from tests.test_live_api import body


class Database:
    def __init__(self):
        self.jobs, self.sessions, self.insights, self.calls = {}, {}, {}, []
        self.fail_finish = False
        self.fail_insight_set = False

    def handle(self, request):
        if request.url.path.endswith("/sql"):
            query = request.content.decode()
            if "FROM live_insight" in query:
                if "attempt_id = '" in query:
                    row = self.insights.get(query.split(" = '")[1].split("'")[0])
                    return httpx.Response(200, json=[{"rows": [deepcopy(row)] if row else []}])
                if "expires_at <=" in query:
                    limit = int(query.split("<=")[1].split()[0])
                    rows = [dict(attempt_id=k) for k, v in self.insights.items() if v["expires_at"] <= limit]
                    return httpx.Response(200, json=[{"rows": rows}])
                return httpx.Response(200, json=[{"rows": []}])
            if "expires_at <=" in query:
                return httpx.Response(200, json=[{"rows": []}])
            table = self.sessions if "FROM live_session" in query else self.jobs
            key = query.split(" = '")[1].split("'")[0]
            row = table.get(key)
            return httpx.Response(200, json=[{"rows": [deepcopy(row)] if row else []}])
        assert request.url.params.get("confirmed") == "true"
        name = request.url.path.rsplit("/", 1)[1]
        args = json.loads(request.content)
        self.calls.append((name, args))
        if name == "enqueue_live_job":
            identity, profile, sid, kind, payload, digest, revision, *_ = args
            previous = self.jobs.get(identity)
            if previous and previous["request_hash"] != digest:
                return httpx.Response(400, text="idempotency conflict")
            self.jobs.setdefault(identity, dict(
                id=identity, profile_id=profile, session_id=sid, kind=kind, request_json=payload,
                request_hash=digest, expected_revision=revision, status="queued", lease_token="", created_at=0,
            ))
        elif name == "claim_live_job":
            identity, worker, token, *_ = args
            self.jobs[identity].update(status="running", lease_token=token, worker_id=worker)
        elif name == "finish_live_job":
            if self.fail_finish:
                return httpx.Response(400, text="stale lease")
            assert len(args) == 9
            identity, token, result, snapshot, *_, delivered = args
            job = self.jobs[identity]
            assert token == job["lease_token"]
            if delivered:
                row = self.insights.get(delivered)
                if job["kind"] != "session.turn" or not row or row["status"] != "ready"                         or row["profile_id"] != job["profile_id"]:
                    return httpx.Response(400, text="insight conflict")
                row["status"] = "delivered"
            if snapshot:
                self.sessions[job["session_id"]] = dict(
                    state_json=snapshot, profile_id=job["profile_id"], revision=job["expected_revision"] + 1,
                )
            job.update(status="done", result_json=result, request_json="")
        elif name == "set_live_insight":
            if self.fail_insight_set:
                return httpx.Response(500, text="boom")
            attempt, profile, sound, status, say, source, ttl = args
            old = self.insights.get(attempt)
            if old and old["profile_id"] != profile:
                return httpx.Response(400, text="profile mismatch")
            if not (old and old["status"] == "delivered"):
                now = int(time.time())
                self.insights[attempt] = dict(
                    attempt_id=attempt, profile_id=profile, sound=sound, status=status, say=say, source=source,
                    created_at=old["created_at"] if old else now, expires_at=now + ttl,
                )
        elif name == "cleanup_live_state":
            assert len(args) == 3
            for key in args[2]:
                self.insights.pop(key, None)
        elif name == "fail_live_job":
            self.jobs[args[0]].update(status="failed", error_code="processing_failed")
        return httpx.Response(200)


class History:
    def __init__(self):
        self.writes = 0

    async def load(self, profile, limit):
        return LearnerContext()

    async def record(self, *args):
        self.writes += 1
        return True


def replica(tmp_path, db, **options):
    settings = make_settings(
        tmp_path, live_coordination="spacetime", live_identity_secret="test-secret-" * 4,
        live_cookie_secure=False, spacetime_database="test", spacetime_token="backend-token",
        **options,
    )
    app = create_app(settings)
    app.state.live_spacetime_transport = httpx.MockTransport(db.handle)
    return TestClient(app)


def worker_for(client, history=None):
    app = client.app
    db = get_runtime(app).spacetime(app.state.live_spacetime_transport)
    deps = LiveDeps(app.state.settings, history=history or History(), spacetime=db)
    return Worker(app.state.settings, Coordination(app.state.settings, db), deps)


def signed_profile(client):
    response = client.get("/v1/live/identity")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert "HttpOnly" in response.headers.get("set-cookie", "")
    return response.json()["profileId"]


@pytest.mark.asyncio
async def test_session_resumes_on_a_different_api_and_worker(tmp_path):
    db = Database()
    first, second = replica(tmp_path / "one", db), replica(tmp_path / "two", db)
    profile = signed_profile(first)
    second.cookies.set(COOKIE, first.cookies.get(COOKIE))
    key = str(uuid4())
    submitted = first.post("/v1/live/session/start", headers={"Idempotency-Key": key}, json={
        "profileId": profile, "displayName": "Maya", "sounds": ["u", "i"],
    })
    assert submitted.status_code == 202 and submitted.json()["jobId"] == key
    worker = worker_for(first)
    await worker.execute(await worker.claim(db.jobs[key]))
    initial = second.get(submitted.json()["statusUrl"])
    assert initial.status_code == 200
    assert initial.json()["revision"] == 1 and initial.json()["sound"] == "u"
    sid = initial.json()["sessionId"]
    turn = second.post("/v1/live/session/turn", json={
        "sessionId": sid, "profileId": profile, "expectedRevision": 1,
        "event": {"kind": "control", "control": "skip"},
    })
    assert turn.status_code == 202
    next_job = turn.json()["jobId"]
    replacement = worker_for(second)  # No shared Python memory or local session file.
    await replacement.execute(await replacement.claim(db.jobs[next_job]))
    result = first.get(turn.json()["statusUrl"])
    assert result.status_code == 200
    assert result.json()["revision"] == 2 and result.json()["sound"] == "i"
    assert result.json()["action"] == "next_sound"
    assert not hasattr(first.app.state, "live_sessions")
    assert not hasattr(second.app.state, "live_sessions")


def test_signed_identity_is_stable_and_ownership_is_not_a_display_name(tmp_path):
    db = Database()
    alice, bob = replica(tmp_path / "a", db), replica(tmp_path / "b", db)
    profile = signed_profile(alice)
    assert alice.get("/v1/live/identity").json()["profileId"] == profile
    assert signed_profile(bob) != profile
    response = bob.post("/v1/live/session/start", json={"profileId": profile, "displayName": "Maya"})
    assert response.status_code == 403
    assert not db.jobs
    response = alice.post("/v1/live/session/start", json={"profileId": profile, "displayName": "Maya"})
    assert bob.get(response.json()["statusUrl"]).status_code == 404


def test_missing_or_tampered_cookie_is_rejected(tmp_path):
    db = Database()
    client = replica(tmp_path, db)
    profile = "p_" + "a" * 32
    payload = {"profileId": profile, "displayName": "Maya"}
    assert client.post("/v1/live/session/start", json=payload).status_code == 401
    client.cookies.set(COOKIE, profile + ".9999999999." + "a" * 64)
    assert client.post("/v1/live/session/start", json=payload).status_code == 401
    assert not db.calls


def test_shared_mode_rejects_legacy_storage_and_requires_revision_and_inline_features(tmp_path):
    client = replica(tmp_path, Database())
    profile = signed_profile(client)
    assert client.post("/v1/coach", json={}).status_code == 404
    assert client.post("/v1/live/session/turn", json={
        "profileId": profile, "sessionId": str(uuid4()), "event": {"kind": "control", "control": "ready"},
    }).status_code == 422
    assert client.post("/v1/live/coach", json=body(profile=profile, source="spacetimedb")).status_code == 422


@pytest.mark.asyncio
async def test_attempt_writes_are_staged_until_fenced_completion(tmp_path):
    db = Database()
    client = replica(tmp_path, db)
    profile = signed_profile(client)
    submitted = client.post("/v1/live/coach", json=body(profile=profile))
    assert submitted.status_code == 202
    history = History()
    worker = worker_for(client, history)
    job = await worker.claim(db.jobs[submitted.json()["jobId"]])
    staged = await worker.compute(job)
    assert history.writes == 0 and db.jobs[job["id"]]["status"] == "running"
    assert json.loads(staged[4])["profileId"] == profile
    assert json.loads(staged[5])["attemptId"] == job["id"]
    await worker.coordination.client.call("finish_live_job", staged)
    result = client.get(submitted.json()["statusUrl"])
    assert result.status_code == 200 and result.json()["persisted"] is True


@pytest.mark.asyncio
async def test_stale_worker_does_not_write_history_or_report_success(tmp_path):
    db = Database()
    db.fail_finish = True
    client = replica(tmp_path, db)
    profile = signed_profile(client)
    submitted = client.post("/v1/live/coach", json=body(profile=profile))
    history = History()
    worker = worker_for(client, history)
    job = await worker.claim(db.jobs[submitted.json()["jobId"]])
    await worker.execute(job)
    assert history.writes == 0
    assert db.jobs[job["id"]]["status"] == "running"
    assert client.get(submitted.json()["statusUrl"]).status_code == 202


def test_shared_configuration_requires_database_and_shared_signing_secret(tmp_path):
    with pytest.raises(ValueError, match="SPACETIME_DATABASE"):
        make_settings(tmp_path, live_coordination="spacetime")
    with pytest.raises(ValueError, match="LIVE_IDENTITY_SECRET"):
        make_settings(tmp_path, live_coordination="spacetime", spacetime_database="db", spacetime_token="token")


@pytest.mark.parametrize("error,status", [("queue full", 429), ("revision conflict", 409), ("database down", 503)])
def test_queue_errors_are_exposed_without_provider_body_or_credentials(tmp_path, error, status):
    client = replica(tmp_path, Database())
    profile = signed_profile(client)
    client.app.state.live_spacetime_transport = httpx.MockTransport(
        lambda _: httpx.Response(400, text=f"{error}; internal-sensitive-details")
    )
    response = client.post("/v1/live/session/start", json={"profileId": profile, "displayName": "Maya"})
    assert response.status_code == status
    assert "sensitive" not in response.text and "backend-token" not in response.text


def test_readiness_checks_the_shared_schema_but_liveness_does_not(tmp_path):
    client = replica(tmp_path, Database())
    client.app.state.live_spacetime_transport = httpx.MockTransport(lambda _: httpx.Response(404))
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 503
    client.app.state.live_spacetime_transport = httpx.MockTransport(lambda _: httpx.Response(200, json=[{"rows": []}]))
    assert client.get("/health/ready").json()["coordination"] == "spacetime"
