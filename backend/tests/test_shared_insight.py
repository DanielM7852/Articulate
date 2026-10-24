"""Articulation insight state across independent API replicas and workers (HTTP SpacetimeDB fake)."""

import json
import time
from uuid import uuid4

import httpx
import pytest

from app.integrations.articulation import ArticulationClient
from app.live.identity import COOKIE
from app.live.shared_insight import InsightSnapshot, SharedInsights
from tests.test_coordination import Database, replica, signed_profile, worker_for
from tests.test_insight_route import AID, FIXTURE, WAV, FakeHistory, attempts

URL = "/v1/live/articulation"
H = {"Content-Type": "audio/wav"}
READY_LINE = "Compared with your best ee tries, your tongue sat a little below."


def api(tmp_path, db, history, **options):
    c = replica(tmp_path, db, articulation_url="http://127.0.0.1:8010", **options)
    c.app.state.live_history = history
    c.app.state.live_articulation = ArticulationClient(
        c.app.state.settings, httpx.MockTransport(lambda r: httpx.Response(200, json=json.loads(FIXTURE.read_text())))
    )
    return c


def upload(c, profile, attempt=AID):
    return c.post(f"{URL}?attemptId={attempt}&profileId={profile}&sound=i", content=WAV, headers=H)


def status(c, profile, attempt=AID):
    return c.get(f"{URL}/{attempt}?profileId={profile}")


def test_upload_writes_pending_then_lane_writes_ready_visible_on_other_replica(tmp_path):
    db = Database()
    first = api(tmp_path / "a", db, FakeHistory(attempts()))
    second = replica(tmp_path / "b", db)
    profile = signed_profile(first)
    second.cookies.set(COOKIE, first.cookies.get(COOKIE))
    assert upload(first, profile).status_code == 202
    writes = [a for n, a in db.calls if n == "set_live_insight"]
    assert [w[3] for w in writes] == ["pending", "ready"]
    assert writes[0][:3] == [AID, profile, "i"] and writes[0][4:] == ["", "", 900]
    assert writes[1][5] == "fallback" and "tongue" in writes[1][4]
    assert status(second, profile).json() == {"status": "ready", "sound": "i"}
    assert "tongue" not in status(second, profile).text


def test_lane_without_claim_writes_none(tmp_path):
    db = Database()
    c = api(tmp_path, db, FakeHistory(attempts(with_anchor=False)))
    profile = signed_profile(c)
    assert upload(c, profile).status_code == 202
    assert db.insights[AID]["status"] == "none" and db.insights[AID]["say"] == ""


def test_collector_failure_writes_none(tmp_path):
    db = Database()
    c = api(tmp_path, db, FakeHistory(attempts()))
    c.app.state.live_articulation = ArticulationClient(
        c.app.state.settings, httpx.MockTransport(lambda r: httpx.Response(500))
    )
    profile = signed_profile(c)
    upload(c, profile)
    assert db.insights[AID]["status"] == "none"


def test_cookie_is_required_and_must_match_profile(tmp_path):
    db = Database()
    c = api(tmp_path, db, FakeHistory(attempts()))
    other = "p_" + "b" * 32
    assert upload(c, other).status_code == 401
    assert status(c, other).status_code == 401
    profile = signed_profile(c)
    assert upload(c, other).status_code == 403
    assert status(c, other).status_code == 403
    assert not db.insights and profile != other


def test_pending_write_failure_is_unavailable_and_releases_reservation(tmp_path):
    db = Database()
    c = api(tmp_path, db, FakeHistory(attempts()), articulation_max_queue=0)
    profile = signed_profile(c)
    db.fail_insight_set = True
    failed = upload(c, profile)
    assert failed.status_code == 200 and failed.json() == {"accepted": False, "reason": "unavailable"}
    db.fail_insight_set = False
    assert upload(c, profile).status_code == 202  # not "busy"
    assert db.insights[AID]["status"] == "ready"


def test_status_reads_shared_store_with_stale_pending_other_profile_and_outage(tmp_path):
    db = Database()
    c = api(tmp_path, db, FakeHistory([]))
    profile = signed_profile(c)
    assert status(c, profile).json() == {"status": "unknown", "sound": None}
    now = int(time.time())
    row = dict(attempt_id=AID, profile_id=profile, sound="i", status="pending", say="", source="",
               created_at=now, expires_at=now + 600)
    db.insights[AID] = row
    assert status(c, profile).json() == {"status": "pending", "sound": "i"}
    row["created_at"] = now - (30 + 45 + 30 + 5)
    assert status(c, profile).json() == {"status": "none", "sound": "i"}
    row["profile_id"] = "p_" + "c" * 32
    assert status(c, profile).json() == {"status": "unknown", "sound": None}
    row.update(profile_id=profile, expires_at=now - 1)
    assert status(c, profile).json()["status"] == "unknown"
    c.app.state.live_spacetime_transport = httpx.MockTransport(lambda _: httpx.Response(500))
    assert status(c, profile).status_code == 503


def test_readiness_probes_the_insight_table(tmp_path):
    seen = []

    def handler(request):
        seen.append(request.content.decode())
        return httpx.Response(200, json=[{"rows": []}])

    c = replica(tmp_path, Database())
    c.app.state.live_spacetime_transport = httpx.MockTransport(handler)
    assert c.get("/health/ready").status_code == 200
    assert any("live_insight" in q for q in seen)


async def start_session(c, db, worker, profile):
    key = str(uuid4())
    c.post("/v1/live/session/start", headers={"Idempotency-Key": key},
           json={"profileId": profile, "displayName": "Maya", "sounds": ["i", "u"]})
    await worker.execute(await worker.claim(db.jobs[key]))
    return c.get(f"/v1/live/jobs/{key}").json()["sessionId"]


async def turn(c, db, worker, profile, sid, revision, event):
    r = c.post("/v1/live/session/turn", json={
        "sessionId": sid, "profileId": profile, "expectedRevision": revision, "event": event})
    assert r.status_code == 202
    await worker.execute(await worker.claim(db.jobs[r.json()["jobId"]]))
    finish = [a for n, a in db.calls if n == "finish_live_job"][-1]
    assert len(finish) == 9
    return c.get(r.json()["statusUrl"]).json(), finish[8]


@pytest.mark.asyncio
async def test_worker_delivers_ready_line_once_and_passes_attempt_id(tmp_path):
    db = Database()
    c = replica(tmp_path, db)
    profile = signed_profile(c)
    worker = worker_for(c)
    sid = await start_session(c, db, worker, profile)
    now = int(time.time())
    db.insights[AID] = dict(attempt_id=AID, profile_id=profile, sound="i", status="ready", say=READY_LINE,
                            source="agent", created_at=now, expires_at=now + 600)
    event = {"kind": "analysis_ready", "attemptId": AID, "currentSound": "i"}
    first, delivered = await turn(c, db, worker, profile, sid, 1, event)
    assert first["say"] == READY_LINE and first["source"] == "agent" and delivered == AID
    assert db.insights[AID]["status"] == "delivered"
    second, delivered = await turn(c, db, worker, profile, sid, 2, event)
    assert second["source"] == "scripted" and "tongue" not in second["say"] and delivered == ""


@pytest.mark.asyncio
async def test_other_jobs_pass_empty_delivered_id(tmp_path):
    db = Database()
    c = replica(tmp_path, db)
    profile = signed_profile(c)
    worker = worker_for(c)
    sid = await start_session(c, db, worker, profile)
    assert [a[8] for n, a in db.calls if n == "finish_live_job"] == [""]
    _, delivered = await turn(c, db, worker, profile, sid, 1, {"kind": "control", "control": "skip"})
    assert delivered == ""
    notes = c.post("/v1/live/notes", json={"profileId": profile})
    await worker.execute(await worker.claim(db.jobs[notes.json()["jobId"]]))
    assert [a[8] for n, a in db.calls if n == "finish_live_job"][-1] == ""


@pytest.mark.asyncio
async def test_foreign_insight_is_never_delivered(tmp_path):
    db = Database()
    c = replica(tmp_path, db)
    profile = signed_profile(c)
    worker = worker_for(c)
    sid = await start_session(c, db, worker, profile)
    now = int(time.time())
    db.insights[AID] = dict(attempt_id=AID, profile_id="p_" + "d" * 32, sound="i", status="ready",
                            say=READY_LINE, source="agent", created_at=now, expires_at=now + 600)
    out, delivered = await turn(c, db, worker, profile, sid, 1,
                                {"kind": "analysis_ready", "attemptId": AID, "currentSound": "i"})
    assert out["source"] == "scripted" and delivered == "" and db.insights[AID]["status"] == "ready"


@pytest.mark.asyncio
async def test_cleanup_passes_expired_insight_ids_as_third_array(tmp_path):
    db = Database()
    c = replica(tmp_path, db)
    now = int(time.time())
    db.insights["old"] = dict(attempt_id="old", expires_at=now - 5)
    db.insights["new"] = dict(attempt_id="new", expires_at=now + 500)
    coordination = worker_for(c).coordination
    await coordination.cleanup()
    assert [a for n, a in db.calls if n == "cleanup_live_state"] == [[[], [], ["old"]]]
    assert list(db.insights) == ["new"]
    await coordination.cleanup()
    assert len([n for n, _ in db.calls if n == "cleanup_live_state"]) == 1  # nothing expired: no reducer call


@pytest.mark.asyncio
async def test_shared_insights_unit_semantics(tmp_path):
    db = Database()
    c = replica(tmp_path, db)
    store = SharedInsights(c.app.state.settings, worker_for(c).coordination.client)
    await store.set(AID, "p1", "i", "ready", "line", "agent")
    entry = await store.get(AID, "p1")
    assert entry["say"] == "line" and entry["source"] == "agent" and entry["status"] == "ready"
    assert await store.get(AID, "p2") is None
    snap = InsightSnapshot(entry)
    assert snap.delivered == "" and snap.get_insight(AID, "p2") is None
    snap.mark_insight_delivered(AID)
    assert snap.delivered == AID and snap.get_insight(AID, "p1")["status"] == "delivered"
