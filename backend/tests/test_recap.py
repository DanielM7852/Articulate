"""Post-session recap: fake Claude (by output_format), fake history and mailer. No network."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.live import llm, recap
from app.live.history import LearnerContext
from app.main import create_app
from tests.support import make_settings

A1, A2, OLD = "att-1", "att-2", "old-1"


class FakeHistory:
    def __init__(self, ctx):
        self.ctx = ctx

    async def load(self, profile_id, limit):
        return self.ctx


def word_turn(aid, verdict="close", ck="miss"):
    return {"kind": "word", "attemptId": aid, "word": "track", "verdict": verdict, "quality": "usable",
            "zones": [{"id": "z1", "phoneme": "k", "kind": "stop", "verdict": ck, "advisory": False, "inScope": True}],
            "caption": "SECRET-CAPTION", "clientSummary": "SECRET-CLIENT"}


def vowel_turn(aid, verdict="on_target"):
    return {"attemptId": aid, "sound": "i", "audioVerdict": verdict, "videoVerdict": "matches",
            "inTargetFraction": 0.8, "caption": "SECRET-CAPTION"}


def context():
    return LearnerContext(
        attempts=[vowel_turn(OLD, "off")],
        word_attempts=[word_turn(A2, "on_target", "hit"), word_turn(A1), word_turn("old-2")],
        notes={"summary": "Ee needs extra tries.", "struggles": [{"sound": "i", "pattern": "lands off target", "count": 2}]},
    )


class FakeClaude:
    def __init__(self, draft=None, fail=False):
        self.calls = []
        self.draft, self.fail = draft, fail
        outer = self

        class Messages:
            def parse(self, **kw):
                outer.calls.append(kw)
                if outer.fail:
                    raise RuntimeError("boom")
                return SimpleNamespace(parsed_output=outer.draft, stop_reason="end_turn")

        self.messages = Messages()


def habit(**kw):
    d = dict(title="Mirror minute", when="After breakfast", how="Say track slowly.", minutes=5)
    d.update(kw)
    return recap.HabitDraft(**d)


def exercise(**kw):
    d = dict(title="Back of tongue", targets="ck", steps=["Say k", "Say ck"], reps="3 x 5")
    d.update(kw)
    return recap.ExerciseDraft(**d)


def draft(**kw):
    d = dict(headline="Nice work on track", summary="You got the tr. The ck is still tricky.", wins=["Clear tr"],
             focusAreas=[recap.FocusDraft(part="the ck in track", whatHappened="It was missed twice.", trend="same")],
             habits=[habit()], exercises=[exercise()])
    d.update(kw)
    return recap.RecapDraft(**d)


def make(tmp_path, claude=None, mailer=True, **settings):
    app = create_app(make_settings(tmp_path, **settings))
    app.state.live_client = claude or FakeClaude(draft())
    app.state.live_history = FakeHistory(context())
    app.state.recap_sent = []
    if mailer:
        async def send(to, subject, html, text):
            app.state.recap_sent.append((to, subject, html, text))
            return "id-1"

        app.state.recap_mailer = send
    recap.HISTORY_RETRY_DELAY_S = 0
    return app, TestClient(app)


def start(c, ids=(A1, A2), **kw):
    return c.post("/v1/live/recap", json={"profileId": "kid-1", "attemptIds": list(ids), "word": "track", **kw})


def wait(c, rid, want=("ready", "failed", "empty"), profile="kid-1"):
    for _ in range(200):
        j = c.get(f"/v1/live/recap/{rid}", params={"profileId": profile}).json()
        if j["status"] in want:
            return j
        time.sleep(0.01)
    raise AssertionError(j)


def test_happy_path_one_call(tmp_path):
    claude = FakeClaude(draft())
    app, c = make(tmp_path, claude)
    with c:
        r = start(c)
        assert r.status_code == 200 and r.json()["status"] in ("pending", "ready")
        j = wait(c, r.json()["recapId"])
    assert j["status"] == "ready" and j["error"] is None
    rc = j["recap"]
    assert rc["sessionAttempts"] == 2 and set(rc) == {"headline", "summary", "wins", "focusAreas", "habits", "exercises", "sessionAttempts"}
    assert rc["habits"] == [{"title": "Mirror minute", "when": "After breakfast", "how": "Say track slowly.",
                             "minutes": 5}]
    assert rc["exercises"][0]["steps"] == ["Say k", "Say ck"] and set(rc["exercises"][0]) == {"title", "targets", "steps", "reps"}
    assert rc["focusAreas"][0]["trend"] == "same" and j["emailStatus"] == "none"
    assert len(claude.calls) == 1
    call = claude.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["output_config"] == {"effort": "high"}
    assert call["max_tokens"] == 16000 and call["output_format"] is recap.RecapDraft
    assert "source" not in call["system"].lower() and "mirror" in call["system"]


def test_links_stripped_and_clamped(tmp_path):
    d = draft(habits=[habit(title="Hi [x](http://evil.test)", how="See https://evil.test ok", minutes=99)] * 5,
              exercises=[exercise(steps=["a"] * 9)] * 6)
    app, c = make(tmp_path, FakeClaude(d))
    with c:
        j = wait(c, start(c).json()["recapId"])
    rc = j["recap"]
    assert rc["habits"][0]["title"] == "Hi x" and "evil" not in rc["habits"][0]["how"]
    assert rc["habits"][0]["minutes"] == 15 and len(rc["habits"]) == 3
    assert len(rc["exercises"]) == 4 and len(rc["exercises"][0]["steps"]) == 5


def test_session_past_split_and_whitelist(tmp_path):
    claude = FakeClaude(draft())
    app, c = make(tmp_path, claude)
    with c:
        wait(c, start(c, ids=(A1,)).json()["recapId"])
    prompt = claude.calls[0]["messages"][0]["content"]
    data = json.loads(prompt)
    assert len(data["session"]) == 1 and data["session"][0]["word"] == "track"
    assert data["session"][0]["parts"][0]["verdict"] == "miss"
    totals = data["pastTotals"]
    assert totals["words"]["track"] == {"tries": 2, "clearTries": 2, "onTarget": 1}  # A2 and old-2 are past
    assert totals["parts"]["the k (stop)"] == {"tries": 2, "onTarget": 1}
    assert totals["parts"]["the ee sound"] == {"tries": 1, "onTarget": 0}
    assert data["pastNotes"]["summary"] == "Ee needs extra tries."
    assert "SECRET" not in prompt


def test_no_session_turns_is_empty(tmp_path):
    claude = FakeClaude(draft())
    app, c = make(tmp_path, claude)
    with c:
        j = wait(c, start(c, ids=("nope",)).json()["recapId"])
    assert j["status"] == "empty" and j["recap"] is None and claude.calls == []


def test_call_fails(tmp_path):
    claude = FakeClaude(fail=True)
    app, c = make(tmp_path, claude)
    with c:
        j = wait(c, start(c).json()["recapId"])
    assert j["status"] == "failed" and j["error"] == "summary_unavailable" and j["recap"] is None
    assert len(claude.calls) == 1


def test_idempotent_post_and_failed_can_restart(tmp_path):
    app, c = make(tmp_path)
    with c:
        first = start(c, ids=(A1, A2)).json()["recapId"]
        assert start(c, ids=(A2, A1)).json()["recapId"] == first
        wait(c, first)
        assert start(c, ids=(A1,)).json()["recapId"] != first
    app, c = make(tmp_path, FakeClaude(fail=True))
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        assert start(c).json()["recapId"] != rid


def test_get_403_other_profile_and_404_unknown(tmp_path):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        assert c.get(f"/v1/live/recap/{rid}", params={"profileId": "kid-2"}).status_code == 403
        assert c.get("/v1/live/recap/unknown", params={"profileId": "kid-1"}).status_code == 404
        wait(c, rid)


def test_get_404_after_ttl(tmp_path):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        recap.get_service(app).clock = lambda: time.monotonic() + recap.RECAP_TTL_S + 5
        assert c.get(f"/v1/live/recap/{rid}", params={"profileId": "kid-1"}).status_code == 404


def test_store_evicts_oldest(tmp_path, monkeypatch):
    monkeypatch.setattr(recap, "RECAP_MAX", 2)
    app, c = make(tmp_path)
    with c:
        ids = []
        for i in range(3):
            ids.append(start(c, ids=(f"x{i}",)).json()["recapId"])
            wait(c, ids[-1])
        assert c.get(f"/v1/live/recap/{ids[0]}", params={"profileId": "kid-1"}).status_code == 404
        assert c.get(f"/v1/live/recap/{ids[2]}", params={"profileId": "kid-1"}).status_code == 200


def test_email_queued_then_sent_on_completion(tmp_path):
    app, c = make(tmp_path)
    orig = app.state.live_client.messages.parse

    def slow(**kw):
        time.sleep(0.3)
        return orig(**kw)

    app.state.live_client.messages.parse = slow
    with c:
        j = start(c, email="kid@example.com").json()
        assert j["status"] == "pending" and j["emailStatus"] == "queued" and j["emailTo"] == "kid@example.com"
        assert app.state.recap_sent == []
        wait(c, j["recapId"])
        for _ in range(200):
            j = c.get(f"/v1/live/recap/{j['recapId']}", params={"profileId": "kid-1"}).json()
            if j["emailStatus"] == "sent":
                break
            time.sleep(0.01)
    assert j["emailStatus"] == "sent"
    to, subject, html, text = app.state.recap_sent[0]
    assert to == "kid@example.com" and subject == "Your practice recap: Nice work on track"
    assert "Mirror minute" in text and "Sources" not in text and "<a " not in html


def test_email_when_ready_sends_immediately(tmp_path):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
    assert r.status_code == 200 and r.json()["emailStatus"] == "sent" and r.json()["emailTo"] == "a@b.org"
    assert len(app.state.recap_sent) == 1


def test_email_queued_when_pending(tmp_path):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
        assert r.json()["emailStatus"] in ("queued", "sent")
        wait(c, rid)
        for _ in range(200):
            if app.state.recap_sent:
                break
            time.sleep(0.01)
    assert len(app.state.recap_sent) == 1


def test_email_failure_reported(tmp_path):
    app, c = make(tmp_path)

    async def boom(*a):
        raise RuntimeError("smtp")

    app.state.recap_mailer = boom
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
    assert r.json()["emailStatus"] == "failed"


def test_resend_not_configured(tmp_path):
    app, c = make(tmp_path, mailer=False)
    with c:
        rid = start(c).json()["recapId"]
        wait(c, rid)
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": "a@b.org"})
    assert r.status_code == 200 and r.json()["emailStatus"] == "not_configured"


@pytest.mark.parametrize("bad", ["nope", "a@b", "a b@c.org", "a@b.org\r\nBcc: x@y.org", "<x>@b.org", ""])
def test_invalid_email_422(tmp_path, bad):
    app, c = make(tmp_path)
    with c:
        rid = start(c).json()["recapId"]
        r = c.post(f"/v1/live/recap/{rid}/email", json={"profileId": "kid-1", "email": bad})
        assert r.status_code == 422
        if bad:
            assert start(c, ids=("z",), email=bad).status_code == 422
        wait(c, rid)


def test_request_validation(tmp_path):
    app, c = make(tmp_path)
    with c:
        assert c.post("/v1/live/recap", json={"profileId": "kid-1", "attemptIds": []}).status_code == 422
        assert c.post("/v1/live/recap", json={"profileId": "kid-1", "attemptIds": ["x" * 65]}).status_code == 422
        assert c.post("/v1/live/recap", json={"profileId": "kid-1", "attemptIds": ["a"] * 201}).status_code == 422
        assert c.post("/v1/live/recap", json={"profileId": "bad id!", "attemptIds": ["a"]}).status_code == 422


def test_email_html_escapes_model_text():
    rc = recap.build_recap(
        draft(headline="<script>alert(1)</script>", summary="<img src=x onerror=1>",
              habits=[habit(title="<script>h</script>", when="<b>")],
              exercises=[exercise(title="<i>e</i>", steps=["<script>s</script>"])]), 1)
    subject, html, text = recap.render_email(rc)
    assert "<script>" not in html and "&lt;script&gt;" in html and "<i>" not in html
    assert "onerror=1>" not in html
    assert subject.startswith("Your practice recap: ")


def test_ask_claude_uses_anthropic_path_even_for_openai_provider(tmp_path):
    settings = make_settings(tmp_path, live_coach_provider="openai")
    fake = FakeClaude(draft())
    out = asyncio.run(llm.ask_claude(settings, fake, "sys", "user", recap.RecapDraft, "high", 5, 100,
                                     model="claude-opus-5-5"))
    assert out.headline == "Nice work on track"
    kw = fake.calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["output_config"] == {"effort": "high"}


def test_overall_timeout_fails(tmp_path):
    class Slow(FakeClaude):
        def __init__(self):
            super().__init__(draft())
            outer = self

            class Messages:
                def parse(self, **kw):
                    time.sleep(0.5)
                    return SimpleNamespace(parsed_output=outer.draft, stop_reason="end_turn")

            self.messages = Messages()

    app, c = make(tmp_path, Slow(), live_recap_timeout_s=0.1)
    with c:
        j = wait(c, start(c).json()["recapId"])
    assert j["status"] == "failed" and j["error"] == "timeout" and j["recap"] is None


def test_empty_recap_not_reused(tmp_path):
    app, c = make(tmp_path)
    with c:
        first = start(c, ids=("nope",)).json()["recapId"]
        assert wait(c, first)["status"] == "empty"
        second = start(c, ids=("nope",)).json()["recapId"]
        assert second != first
        wait(c, second)


def test_email_changed_during_send_resends_to_new_address(tmp_path):
    app, c = make(tmp_path)
    sent = []
    gate = {}

    async def send(to, subject, html, text):
        sent.append(to)
        if len(sent) == 1:
            gate["svc"]._set_email(gate["entry"], "new@b.org")  # the address changes mid-send
            await asyncio.sleep(0.01)
        return "id"

    async def go():
        svc = recap.RecapService(app)
        app.state.recap_mailer = send
        entry = recap._Entry(recap_id="r", profile_id="p", key=("p", frozenset()), created=0.0, status="ready",
                             recap=recap.build_recap(draft(), 1))
        gate.update(svc=svc, entry=entry)
        svc._set_email(entry, "old@b.org")
        await svc.deliver(entry)
        return entry

    entry = asyncio.run(go())
    assert sent == ["old@b.org", "new@b.org"] and entry.email_status == "sent" and entry.email == "new@b.org"


def test_old_address_failure_does_not_fail_new_address(tmp_path):
    app, c = make(tmp_path)
    sent = []
    gate = {}

    async def send(to, subject, html, text):
        sent.append(to)
        if len(sent) == 1:
            gate["svc"]._set_email(gate["entry"], "new@b.org")
            raise RuntimeError("smtp")
        return "id"

    async def go():
        svc = recap.RecapService(app)
        app.state.recap_mailer = send
        entry = recap._Entry(recap_id="r", profile_id="p", key=("p", frozenset()), created=0.0, status="ready",
                             recap=recap.build_recap(draft(), 1))
        gate.update(svc=svc, entry=entry)
        svc._set_email(entry, "old@b.org")
        await svc.deliver(entry)
        return entry

    entry = asyncio.run(go())
    assert sent == ["old@b.org", "new@b.org"] and entry.email_status == "sent"


def test_one_cached_anthropic_client_and_aclose(tmp_path, monkeypatch):
    built = []

    class Closeable(FakeClaude):
        closed = False

        def close(self):
            self.closed = True

    shared = Closeable(draft())

    def build(settings, timeout_s):
        built.append(timeout_s)
        return shared

    monkeypatch.setattr(llm, "build_client", build)
    app, c = make(tmp_path)
    del app.state.live_client
    with c:
        wait(c, start(c).json()["recapId"])
        assert built == [recap.CALL_TIMEOUT_S] and len(shared.calls) == 1
        closed_http = []

        class Http:
            async def aclose(self):
                closed_http.append(True)

        app.state.recap_http = Http()
    # leaving the TestClient context runs shutdown, which closes the service
    assert shared.closed and closed_http == [True]


def test_aclose_cancels_inflight_tasks(tmp_path):
    app, c = make(tmp_path)

    async def go():
        svc = recap.RecapService(app)

        async def forever():
            await asyncio.sleep(60)

        svc._spawn(forever())
        task = next(iter(svc._tasks))
        await svc.aclose()
        return task.cancelled()

    assert asyncio.run(go())


def test_pending_recap_limit_429_but_reuse_allowed(tmp_path):
    app, c = make(tmp_path)

    orig = app.state.live_client.messages.parse

    def slow(**kw):
        time.sleep(0.3)
        return orig(**kw)

    app.state.live_client.messages.parse = slow
    with c:
        first = start(c, ids=(A1,)).json()["recapId"]
        r = start(c, ids=("other",))
        assert r.status_code == 429 and r.json()["detail"] == "recap_limit"
        assert start(c, ids=(A1,)).json()["recapId"] == first  # reuse is not a new pipeline
        wait(c, first)
        assert start(c, ids=("other",)).status_code == 200


def test_hourly_limit_429(tmp_path):
    app, c = make(tmp_path)
    with c:
        for i in range(10):
            wait(c, start(c, ids=(f"h{i}",)).json()["recapId"])
        assert start(c, ids=("h-extra",)).status_code == 429
        svc = recap.get_service(app)
        base = svc.clock()
        svc.clock = lambda: base + 3601
        r = start(c, ids=("h-extra",))
        assert r.status_code == 200
        wait(c, r.json()["recapId"])


def test_purge_never_evicts_pending(tmp_path, monkeypatch):
    monkeypatch.setattr(recap, "RECAP_MAX", 2)
    app, c = make(tmp_path)
    svc = recap.RecapService(app)
    mk = lambda i, st: recap._Entry(recap_id=f"r{i}", profile_id="p", key=("p", frozenset([str(i)])), created=time.monotonic(),
                                    status=st)
    svc._entries = {"r0": mk(0, "pending"), "r1": mk(1, "ready")}
    svc._purge()
    assert list(svc._entries) == ["r0"]
    svc._entries = {"r0": mk(0, "pending"), "r1": mk(1, "pending"), "r2": mk(2, "pending")}
    svc._purge()
    assert len(svc._entries) == 3


def test_multi_word_session_passes_words_not_word(tmp_path):
    ctx = LearnerContext(attempts=[], word_attempts=[word_turn(A1), {**word_turn(A2), "word": "sheep"}], notes=None)
    claude = FakeClaude(draft())
    app, c = make(tmp_path, claude)
    app.state.live_history = FakeHistory(ctx)
    with c:
        wait(c, start(c).json()["recapId"])
    data = json.loads(claude.calls[0]["messages"][0]["content"])
    assert data["word"] is None and data["words"] == ["sheep", "track"]
    assert claude.calls[0]["system"] == recap.RECAP_SYSTEM and len(claude.calls) == 1


def test_single_word_session_has_no_words_key(tmp_path):
    claude = FakeClaude(draft())
    app, c = make(tmp_path, claude)
    with c:
        wait(c, start(c, word="other").json()["recapId"])
    data = json.loads(claude.calls[0]["messages"][0]["content"])
    assert data["word"] == "track" and "words" not in data
