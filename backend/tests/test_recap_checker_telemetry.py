"""Kind-routed telemetry for the session recap (recap.*) and the offline coach checker (checker.*)."""

import json
import time

import pytest

from app import telemetry
from app.config import Settings
from app.live import coach_grader as cg
from scripts import grade_coach
from tests.test_coach_grader import FakeClient, grade, ids, make_store
from tests.test_recap import A1, A2, FakeClaude, draft, make, start, wait


@pytest.fixture
def events(monkeypatch):
    seen: list[tuple[str, str, str, dict]] = []

    def record(source, target, kind, label, payload=None):
        seen.append((source, target, kind, dict(payload or {})))

    monkeypatch.setattr(telemetry, "emit", record)
    return seen


def kinds(seen, prefix):
    return [e for e in seen if e[2].startswith(prefix)]


def until(seen, kind, timeout_s=3.0):
    """recap.ready / recap.error are emitted just after the status flips, so a poll can see the status first."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if any(e[2] == kind for e in seen):
            return
        time.sleep(0.01)
    raise AssertionError(f"{kind} not emitted: {[e[2] for e in seen]}")


# ---- recap


def test_recap_start_ready_email_and_claude_purpose(tmp_path, events):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        until(events, "recap.ready")
        assert start(c).json()["recapId"] == rid  # idempotent return: no second recap.start
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
        assert r.json()["emailStatus"] == "sent"
    got = kinds(events, "recap.")
    assert [(s, t, k) for s, t, k, _ in got] == [
        ("backend", "db", "recap.start"), ("backend", "db", "recap.ready"), ("backend", "db", "recap.email")]
    assert got[0][3] == {"attempts": 2, "word": "track"}
    assert set(got[1][3]) == {"ms"} and isinstance(got[1][3]["ms"], int)
    assert got[2][3]["ok"] is True and got[2][3]["provider"] == "resend" and isinstance(got[2][3]["ms"], int)
    claude = kinds(events, "claude.")
    assert [k for _, _, k, _ in claude] == ["claude.request", "claude.response"]
    assert all(p["purpose"] == "recap" for *_, p in claude)
    assert "a@b.org" not in json.dumps(events) and "kid-1" not in json.dumps(got)


def test_recap_failure_emits_error_with_type_name(tmp_path, events):
    app, c = make(tmp_path, FakeClaude(draft(), fail=True))
    with c:
        wait(c, start(c).json()["recapId"])
        until(events, "recap.error")
    err = kinds(events, "recap.error")[0][3]
    assert err["error"] == "RuntimeError" and isinstance(err["ms"], int)
    assert kinds(events, "recap.ready") == []
    assert [p["purpose"] for _, _, k, p in events if k == "claude.error"] == ["recap"]


def test_recap_limited_per_learner_and_per_hour(tmp_path, events):
    app, c = make(tmp_path)
    orig = app.state.live_client.messages.parse

    def slow(**kw):
        time.sleep(0.3)
        return orig(**kw)

    app.state.live_client.messages.parse = slow
    with c:
        first = start(c, ids=(A1,)).json()["recapId"]
        assert start(c, ids=("other",)).status_code == 429
        wait(c, first)
        app.state.live_client.messages.parse = orig
        for i in range(9):
            wait(c, start(c, ids=(f"h{i}",)).json()["recapId"])
        assert start(c, ids=("h-extra",)).status_code == 429
    assert [p for *_, p in kinds(events, "recap.limited")] == [{"reason": "per_learner"}, {"reason": "per_hour"}]


def test_recap_email_failure_and_not_configured(tmp_path, events):
    app, c = make(tmp_path)

    async def boom(*a):
        raise RuntimeError("smtp")

    app.state.recap_mailer = boom
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
    assert [p["ok"] for *_, p in kinds(events, "recap.email")] == [False]

    events.clear()
    app, c = make(tmp_path / "nc", mailer=False)
    with c:
        rid = start(c, ids=(A2,)).json()["recapId"]
        wait(c, rid)
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
    assert r.json()["emailStatus"] == "not_configured"
    assert [(k, p) for _, _, k, p in kinds(events, "recap.email")] == [
        ("recap.email_skipped", {"reason": "not_configured"})]
    assert "a@b.org" not in json.dumps(events)


# ---- checker


async def test_checker_dry_run_emits_run_only(tmp_path, events):
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(make_store(tmp_path)), "--batch", "2",
                                   "--dry-run"])
    assert await grade_coach.run(args, Settings(), FakeClient(lambda kw: None)) == 0
    assert [(s, t, k, p) for s, t, k, p in kinds(events, "checker.")] == [
        ("backend", "db", "checker.run",
         {"source": "local", "turns": 4, "batches": 2, "dryRun": True, "model": cg.DEFAULT_MODEL})]
    assert kinds(events, "claude.") == []


async def test_checker_full_run_emits_graded_and_report(tmp_path, events):
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[
        grade(i, kind="fail" if i == "a1" else "pass") for i in ids(kw)]))
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(make_store(tmp_path)),
                                   "--out", str(tmp_path / "rep")])
    assert await grade_coach.run(args, Settings(), client) == 0
    got = kinds(events, "checker.")
    assert [k for _, _, k, _ in got] == ["checker.run", "checker.graded", "checker.report"]
    assert got[0][3]["dryRun"] is False
    graded = got[1][3]
    assert graded["graded"] == 4 and graded["turns"] == 4 and isinstance(graded["ms"], int)
    assert got[2][3] == {"rows": 4, "passRate": 75}
    assert {p["purpose"] for _, _, k, p in events if k.startswith("claude.")} == {"grade"}


class Recorder:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    async def call(self, reducer, args):
        if self.fail:
            raise RuntimeError("down")
        self.calls.append(args)


@pytest.mark.parametrize("fail", [False, True])
async def test_checker_configures_drains_and_closes_telemetry(tmp_path, monkeypatch, capsys, fail):
    """Outside the app lifespan the script configures telemetry itself, drains before returning and closes it.
    A failing transport changes neither the exit code nor the output."""
    sink = Recorder(fail)
    original = telemetry.configure
    configured = []

    def fake_configure(settings=None, **kw):
        configured.append(settings)
        return original(client=sink)

    monkeypatch.setattr(telemetry, "configure", fake_configure)
    telemetry.reset()
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(make_store(tmp_path)), "--dry-run"])
    settings = Settings(_env_file=None, telemetry_enabled=True)
    assert await grade_coach.run(args, settings, FakeClient(lambda kw: None)) == 0
    assert "turns=4 batches=1" in capsys.readouterr().out
    assert configured == [settings]
    assert not telemetry.enabled()  # closed by the script
    if not fail:
        assert [a[2] for a in sink.calls] == ["checker.run"]


async def test_checker_leaves_disabled_telemetry_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(telemetry, "configure", lambda *a, **k: pytest.fail("configure called"))
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(make_store(tmp_path)), "--dry-run"])
    assert await grade_coach.run(args, Settings(_env_file=None, telemetry_enabled=False)) == 0
