"""Live coaching endpoints with a fake Claude client and mocked SpacetimeDB HTTP. No network."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.live.schemas import CoachDecision, NotesDraft
from app.main import create_app
from tests.support import make_settings

AID = "0b8b8c1e-5d3a-4c1e-9b7a-2f5d6a1c9e01"
AID2 = "1c9c9d2f-6e4b-4d2f-8c8b-3a6e7b2d0f12"


def frame_audio(f1, f2, n=20):
    return [{"t": i * 20, "f1": f1, "f2": f2, "conf": 0.9, "rms": 0.1, "valid": True, "reason": None, "extra": 1} for i in range(n)]


def frame_lips(n=10, **kw):
    return [{"t": i * 33, "ok": True, "flags": [], **kw} for i in range(n)]


def body(sound="u", aid=AID, audio=None, video=None, source="inline", frames=True, profile="kid-1"):
    b = {
        "attemptId": aid,
        "profileId": profile,
        "sound": sound,
        "metricsSource": source,
        "clientSummary": {
            "durationSec": 3.0,
            "usableVoicedSec": 2.1,
            "timeInTargetSec": None,
            "longestHoldSec": None,
            "quality": "usable",
            "qualityReason": None,
        },
    }
    if frames:
        b["frames"] = {
            "audio": audio if audio is not None else frame_audio(800, 2200),
            "video": video if video is not None else frame_lips(rounding=0.1, lipWidth=0.9),
        }
    return b


class FakeClient:
    def __init__(self, parsed=None, stop_reason="end_turn", exc=None):
        self.calls = []
        self.parsed, self.stop_reason, self.exc = parsed, stop_reason, exc
        outer = self

        class Messages:
            def parse(self, **kw):
                outer.calls.append(kw)
                if outer.exc:
                    raise outer.exc
                return type("R", (), {"parsed_output": outer.parsed, "stop_reason": outer.stop_reason})()

        self.messages = Messages()


def decision(**kw):
    d = dict(
        observation="Your oo sat away from the target area.",
        caption="Watch the demo, then try once more.",
        cueId="round-lips",
        nextAction="retry",
        evidenceFields=["audio.verdict", "video.verdict"],
    )
    d.update(kw)
    return CoachDecision(**d)


def make(tmp_path, client=None, transport=None, **settings):
    app = create_app(make_settings(tmp_path, **settings))
    if client is not None:
        app.state.live_client = client
    if transport is not None:
        app.state.live_spacetime_transport = transport
    return TestClient(app)


def test_agent_decision_is_used_and_grounded(tmp_path):
    fake = FakeClient(decision())
    c = make(tmp_path, fake, anthropic_api_key="k")
    r = c.post("/v1/live/coach", json=body())
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "agent" and j["metricsSource"] == "inline"
    assert j["cueId"] == "round-lips" and j["showSideView"] is True and j["nextAction"] == "retry"
    assert j["audio"]["verdict"] == "off" and j["video"]["verdict"] == "mismatch"
    assert j["evidence"] == [{"field": "audio.verdict", "value": "off"}, {"field": "video.verdict", "value": "mismatch"}]
    assert j["persisted"] is None and j["model"] == "claude-sonnet-5-5"
    call = fake.calls[0]
    assert call["model"] == "claude-sonnet-5-5" and call["output_config"] == {"effort": "medium"}
    assert call["output_format"] is CoachDecision
    assert "temperature" not in call and "thinking" not in call


def test_local_history_feeds_next_prompt(tmp_path):
    fake = FakeClient(decision())
    c = make(tmp_path, fake, anthropic_api_key="k")
    c.post("/v1/live/coach", json=body())
    c.post("/v1/live/coach", json=body(aid=AID2))
    prompt = json.loads(fake.calls[1]["messages"][0]["content"])
    assert [a["attemptId"] for a in prompt["recentAttempts"]] == [AID]
    assert prompt["recentAttempts"][0]["audioVerdict"] == "off"


@pytest.mark.parametrize(
    "bad",
    [
        dict(cueId="spread-lips"),  # wrong cue for u
        dict(caption="You held it for 9 seconds."),  # digit not in evidence
        dict(caption="Your tongue was too far forward."),  # tongue claim
        dict(caption="Okay. " * 60),  # too long
        dict(caption="One. Two. Three. Four."),  # too many sentences
        dict(caption="That was wrong, try again."),  # shaming
        dict(evidenceFields=["audio.nonsense"]),
    ],
)
def test_invalid_model_output_falls_back(tmp_path, bad):
    c = make(tmp_path, FakeClient(decision(**bad)), anthropic_api_key="k")
    j = c.post("/v1/live/coach", json=body()).json()
    assert j["source"] == "fallback"
    assert j["cueId"] in ("round-lips", None)


def test_lips_claim_without_video_falls_back(tmp_path):
    c = make(tmp_path, FakeClient(decision(caption="Round your lips more.")), anthropic_api_key="k")
    j = c.post("/v1/live/coach", json=body(video=[])).json()
    assert j["video"] is None and j["source"] == "fallback"
    assert "lip" not in (j["observation"] + j["caption"]).lower()


def test_refusal_exception_and_missing_key_fall_back(tmp_path):
    j = make(tmp_path, FakeClient(decision(), stop_reason="refusal"), anthropic_api_key="k").post("/v1/live/coach", json=body()).json()
    assert j["source"] == "fallback"
    j = make(tmp_path, FakeClient(exc=RuntimeError("boom")), anthropic_api_key="k").post("/v1/live/coach", json=body()).json()
    assert j["source"] == "fallback"
    j = make(tmp_path).post("/v1/live/coach", json=body()).json()
    assert j["source"] == "fallback"


def test_fallback_for_insufficient_and_on_target(tmp_path):
    c = make(tmp_path)
    j = c.post("/v1/live/coach", json=body(audio=frame_audio(420, 1050, n=3))).json()
    assert j["audio"]["verdict"] == "insufficient" and j["cueId"] is None
    assert j["nextAction"] == "retry" and j["showSideView"] is False
    j = c.post("/v1/live/coach", json=body(audio=frame_audio(420, 1050), aid=AID2)).json()
    assert j["audio"]["verdict"] == "on_target" and j["nextAction"] == "next_sound" and j["cueId"] is None


def test_insufficient_with_cue_from_model_is_rejected(tmp_path):
    c = make(tmp_path, FakeClient(decision()), anthropic_api_key="k")
    j = c.post("/v1/live/coach", json=body(audio=frame_audio(420, 1050, n=2))).json()
    assert j["source"] == "fallback" and j["cueId"] is None


def test_no_frames_reports_none(tmp_path):
    j = make(tmp_path).post("/v1/live/coach", json=body(frames=False)).json()
    assert j["metricsSource"] == "none" and j["audio"]["verdict"] == "insufficient"


def test_validation_422(tmp_path):
    c = make(tmp_path)
    assert c.post("/v1/live/coach", json=body(aid="x' OR '1'='1")).status_code == 422
    assert c.post("/v1/live/coach", json=body(aid=AID + "'; DROP TABLE metric_batch;--")).status_code == 422
    assert c.post("/v1/live/coach", json=body(profile="a b'")).status_code == 422
    assert c.post("/v1/live/coach", json={**body(), "sound": "e"}).status_code == 422
    assert c.post("/v1/live/notes", json={"profileId": "x'y"}).status_code == 422
    assert c.post("/v1/live/coach", json=body(audio=frame_audio(420, 1050, n=1501))).status_code == 422


# ---- SpacetimeDB path ----


def sql_result(columns, rows):
    return [{"schema": {"elements": [{"name": {"some": c}} for c in columns]}, "rows": rows}]


class FakeSpacetime:
    def __init__(self, status="ended", fail_call=False):
        self.sql, self.calls, self.status, self.fail_call = [], [], status, fail_call

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer secret-token"
        path = request.url.path
        assert path.startswith("/v1/database/mydb/")
        if path.endswith("/sql"):
            q = request.content.decode()
            self.sql.append(q)
            if "FROM metric_batch" in q:
                a = json.dumps(frame_audio(800, 2200, n=10))
                v = json.dumps(frame_lips(rounding=0.5))
                rows = [[3, AID, "audio", 1, 10, a, 0], [1, AID, "audio", 0, 10, a, 0], [2, AID, "video", 0, 10, v, 0]]
                cols = ["id", "attempt_id", "kind", "seq", "frame_count", "frames", "received_at"]
                return httpx.Response(200, json=sql_result(cols, rows))
            if "FROM learner_attempt WHERE attempt_id" in q:
                return httpx.Response(200, json=sql_result(["attempt_id", "status"], [[AID, self.status]]))
            if "FROM learner_attempt WHERE profile_id" in q:
                s = json.dumps(
                    {"attemptId": AID2, "sound": "u", "audio": {"verdict": "off", "f1Offset": 0.5}, "cueId": "round-lips", "nextAction": "retry"}
                )
                cols = ["attempt_id", "sound", "status", "started_at", "summary"]
                row = [AID2, "u", "coached", {"__timestamp_micros_since_unix_epoch__": 5}, s]
                return httpx.Response(200, json=sql_result(cols, [row]))
            if "FROM learner_note" in q:
                return httpx.Response(200, json=sql_result(["profile_id", "notes"], [["kid-1", json.dumps({"summary": "old"})]]))
            return httpx.Response(200, json=[])
        self.calls.append((path.rsplit("/", 1)[1], json.loads(request.content)))
        return httpx.Response(500 if self.fail_call else 200, text="")


SPACE = dict(spacetime_database="mydb", spacetime_token="secret-token", spacetime_uri="https://stdb.test")


def test_spacetime_path_reads_frames_and_records_turn(tmp_path):
    st = FakeSpacetime()
    fake = FakeClient(decision())
    c = make(tmp_path, fake, httpx.MockTransport(st), anthropic_api_key="k", **SPACE)
    r = c.post("/v1/live/coach", json=body(source="spacetimedb", frames=False))
    j = r.json()
    assert r.status_code == 200 and j["metricsSource"] == "spacetimedb" and j["persisted"] is None
    assert j["audio"]["frames"] == 20 and j["video"]["verdict"] == "matches"
    assert any(f"attempt_id = '{AID}'" in q for q in st.sql)
    name, args = st.calls[0]
    assert name == "record_coach_turn" and args[0] == AID and len(args) == 3
    summary, dec = json.loads(args[1]), json.loads(args[2])
    assert summary["audio"]["verdict"] == "off" and summary["clientSummary"]["usableVoicedSec"] == 2.1
    assert dec["cueId"] == "round-lips" and "audio" not in dec and dec["source"] == "agent"
    prompt = json.loads(fake.calls[0]["messages"][0]["content"])
    assert prompt["recentAttempts"][0]["attemptId"] == AID2 and prompt["learnerNotes"] == {"summary": "old"}
    assert "secret-token" not in r.text


def test_spacetime_failure_falls_back_to_body_frames_and_persist_false(tmp_path):
    def boom(request):
        raise httpx.ConnectError("down")

    c = make(tmp_path, None, httpx.MockTransport(boom), **SPACE)
    j = c.post("/v1/live/coach", json=body(source="spacetimedb")).json()
    assert j["metricsSource"] == "inline" and j["persisted"] is None and j["source"] == "fallback"
    st = FakeSpacetime(fail_call=True)
    c = make(tmp_path, None, httpx.MockTransport(st), **SPACE)
    j = c.post("/v1/live/coach", json=body(source="spacetimedb", frames=False)).json()
    assert j["metricsSource"] == "spacetimedb" and j["persisted"] is None


# ---- notes ----


def seed(c, n=3):
    for i in range(n):
        c.post("/v1/live/coach", json=body(aid=f"2d0d0e30-7f5c-4e30-9d9c-4b7f8c3e1a{i:02d}"))


def test_notes_fallback_counts_and_persists(tmp_path):
    c = make(tmp_path)
    seed(c)
    j = c.post("/v1/live/notes", json={"profileId": "kid-1"}).json()
    assert j["source"] == "fallback" and j["attemptsConsidered"] == 3 and j["persisted"] is True
    assert j["struggles"][0]["sound"] == "u" and j["struggles"][0]["count"] == 3
    empty = c.post("/v1/live/notes", json={"profileId": "nobody"}).json()
    assert empty["attemptsConsidered"] == 0 and empty["struggles"] == []


def test_notes_agent_path_and_validation(tmp_path):
    draft = NotesDraft(
        summary="Oo is the hardest sound right now.",
        struggles=[{"sound": "u", "pattern": "often lands too far front", "count": 99, "lastAttemptId": None}],
        habits=["usually needs another try"],
    )
    fake = FakeClient(draft)
    c = make(tmp_path, fake, anthropic_api_key="k")
    seed(c)
    fake.calls.clear()
    j = c.post("/v1/live/notes", json={"profileId": "kid-1"}).json()
    assert j["source"] == "agent" and j["struggles"][0]["count"] == 3  # counts come from code
    assert fake.calls[0]["output_config"] == {"effort": "high"} and fake.calls[0]["output_format"] is NotesDraft
    bad = NotesDraft(summary="They failed 3 times.", struggles=[], habits=[])
    c2 = make(tmp_path, FakeClient(bad), anthropic_api_key="k")
    assert c2.post("/v1/live/notes", json={"profileId": "kid-1"}).json()["source"] == "fallback"
    c3 = make(tmp_path, FakeClient(draft, stop_reason="refusal"), anthropic_api_key="k")
    assert c3.post("/v1/live/notes", json={"profileId": "kid-1"}).json()["source"] == "fallback"


def test_notes_spacetime_calls_set_learner_note(tmp_path):
    st = FakeSpacetime()
    c = make(tmp_path, None, httpx.MockTransport(st), **SPACE)
    j = c.post("/v1/live/notes", json={"profileId": "kid-1"}).json()
    assert j["persisted"] is True and j["attemptsConsidered"] == 1
    name, args = st.calls[-1]
    assert name == "set_learner_note" and args[0] == "kid-1" and json.loads(args[1])["profileId"] == "kid-1"
