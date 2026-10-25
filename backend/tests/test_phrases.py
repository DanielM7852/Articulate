"""Real-life phrases: about-me storage, phrase generation (fake Claude) and the gentle Azure check (fake Azure)."""

import asyncio
import base64
import json
import struct
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.audio import azure_pronunciation
from app.audio.azure_pronunciation import AzureAssessment
from app.live import phrases, recap
from app.live.history import LocalHistory
from app.main import create_app
from tests.support import make_settings

PID = "kid-1"


def wav_b64() -> str:
    header = b"RIFF" + struct.pack("<I", 36) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
    return base64.b64encode(header + b"data" + struct.pack("<I", 0)).decode()


def pd(text="Please pass the rice", targets=("the ck in track",), tip="Watch your lips in a mirror."):
    return phrases.PhraseDraft(text=text, targets=list(targets), tip=tip)


def good_draft():
    return phrases.PhrasesDraft(phrases=[
        pd("Could I have a black coffee, please?"), pd("I'm taking the back road"),
        pd("Pack the truck with sticks"), pd("My cat sat on the track"), pd("Thank you for the ride, Mum"),
    ])


class FakeClaude:
    def __init__(self, draft=None, fail=False):
        self.calls, self.draft, self.fail = [], draft, fail
        outer = self

        class Messages:
            def parse(self, **kw):
                outer.calls.append(kw)
                if outer.fail:
                    raise RuntimeError("boom")
                return SimpleNamespace(parsed_output=outer.draft, stop_reason="end_turn")

        self.messages = Messages()


def make(tmp_path, claude=None, **settings):
    app = create_app(make_settings(tmp_path, **settings))
    app.state.live_client = claude or FakeClaude(good_draft())
    return app, TestClient(app)


def add_recap(app, profile=PID, status="ready", parts=("the ck in track", "the tr in track")):
    entry = recap._Entry(recap_id="r1", profile_id=profile, key=(profile, frozenset({"a"})), created=app_clock(app),
                         status=status)
    entry.recap = recap.Recap(headline="h", summary="s", focusAreas=[
        recap.FocusArea(part=p, whatHappened="x", trend="same") for p in parts])
    recap.get_service(app)._entries["r1"] = entry


def app_clock(app):
    return recap.get_service(app).clock()


def user_payload(claude):
    return claude.calls[-1]["messages"][0]["content"]


# ---- about ----

def test_about_get_put_clear_and_control_chars(tmp_path):
    _, c = make(tmp_path)
    assert c.get("/v1/live/about", params={"profileId": PID}).json() == {"aboutMe": None}
    r = c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "I  work\x00 in a\nbakery\x07."})
    assert r.json() == {"aboutMe": "I work in a bakery."}
    assert c.get("/v1/live/about", params={"profileId": PID}).json() == {"aboutMe": "I work in a bakery."}
    assert c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "x" * 501}).status_code == 422
    assert c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "  "}).json() == {"aboutMe": None}
    assert c.get("/v1/live/about", params={"profileId": PID}).json() == {"aboutMe": None}


def test_about_is_separate_from_notes_local(tmp_path):
    app, c = make(tmp_path)
    c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "I drive a bus."})
    history = LocalHistory(app.state.settings)
    assert asyncio.run(history.save_notes(PID, {"summary": "ok", "struggles": []}))
    assert asyncio.run(history.record(PID, "a1", {"attemptId": "a1", "sound": "i"}, {}))
    ctx = asyncio.run(history.load(PID, 5))
    assert ctx.notes == {"summary": "ok", "struggles": []} and not hasattr(ctx, "about")
    assert asyncio.run(history.get_about(PID)) == "I drive a bus."
    stored = json.loads(history._path(PID).read_text())
    assert stored["about"] == "I drive a bus." and "aboutMe" not in json.dumps(stored["notes"])
    # setting the about text leaves the notes alone
    asyncio.run(history.set_about(PID, "New text."))
    assert json.loads(history._path(PID).read_text())["notes"] == {"summary": "ok", "struggles": []}
    asyncio.run(history.set_about(PID, None))
    assert asyncio.run(history.get_about(PID)) is None


def test_update_notes_never_touches_about(tmp_path):
    from app.live.notes import update_notes
    from app.live.orchestrator import LiveDeps

    app, c = make(tmp_path)
    c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "I drive a bus."})
    history = LocalHistory(app.state.settings)
    asyncio.run(history.record(PID, "a1", {"attemptId": "a1", "sound": "i", "audio": {"verdict": "off"}}, {}))
    deps = LiveDeps(settings=app.state.settings, anthropic_client=None, openai_client=None, transport=None,
                    history=history, spacetime=None)
    notes = asyncio.run(update_notes(deps, PID))
    assert notes.persisted and "aboutMe" not in notes.model_dump_json()
    assert asyncio.run(history.get_about(PID)) == "I drive a bus."


def test_legacy_about_in_notes_is_read_once_and_hidden_from_coach(tmp_path):
    history = LocalHistory(make_settings(tmp_path))
    asyncio.run(history.save_notes(PID, {"summary": "s", "aboutMe": "Old text."}))
    assert asyncio.run(history.get_about(PID)) == "Old text."
    assert asyncio.run(history.load(PID, 1)).notes == {"summary": "s"}
    asyncio.run(history.set_about(PID, "Fresh."))
    assert asyncio.run(history.get_about(PID)) == "Fresh."
    assert "aboutMe" not in history._path(PID).read_text()


def spacetime_history(tmp_path, rows=None):
    import httpx

    from app.integrations.spacetime import SpacetimeClient
    from app.live.history import SpacetimeHistory

    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/sql"):
            calls.append(("sql", request.content.decode()))
            return httpx.Response(200, json=[{"schema": {"elements": []}, "rows": rows or []}])
        calls.append((request.url.path.rsplit("/", 1)[-1], request.content.decode()))
        return httpx.Response(200, json=[])

    s = make_settings(tmp_path, spacetime_database="db", spacetime_token="t", spacetime_uri="https://stdb.test")
    return SpacetimeHistory(SpacetimeClient(s, httpx.MockTransport(handler), None)), calls


def test_spacetime_about_uses_derived_key_and_never_touches_notes_row(tmp_path):
    from app.live.history import about_key

    key = about_key(PID)
    assert key != PID and key.startswith("about:") and len(key) <= 64
    assert about_key(PID) == key and about_key("x" * 64) != about_key("x" * 63)
    h, calls = spacetime_history(tmp_path)
    assert asyncio.run(h.set_about(PID, "I drive a bus."))
    assert calls[0][0] == "set_learner_note"
    assert json.loads(calls[0][1]) == [key, json.dumps({"text": "I drive a bus."}, separators=(",", ":"))]
    assert asyncio.run(h.get_about(PID)) is None
    kind, query = calls[1]
    assert kind == "sql" and f"'{key}'" in query and f"'{PID}'" not in query and "learner_attempt" not in query
    assert asyncio.run(h.save_notes(PID, {"summary": "s"}))
    assert calls[2][0] == "set_learner_note" and json.loads(calls[2][1])[0] == PID
    assert len(calls) == 3  # save_notes made no read: no read-modify-write


def test_spacetime_get_about_reads_text_and_clear_stores_empty(tmp_path):
    h, calls = spacetime_history(tmp_path, rows=[{"notes": json.dumps({"text": "Hi there."})}])
    assert asyncio.run(h.get_about(PID)) == "Hi there."
    h2, calls2 = spacetime_history(tmp_path, rows=[{"notes": json.dumps({"text": ""})}])
    assert asyncio.run(h2.get_about(PID)) is None
    assert asyncio.run(h2.set_about(PID, None))
    assert json.loads(json.loads(calls2[-1][1])[1]) == {"text": ""}


# ---- phrases ----

def test_phrases_happy_path_with_recap_parts_and_about(tmp_path):
    claude = FakeClaude(good_draft())
    app, c = make(tmp_path, claude)
    add_recap(app)
    r = c.post("/v1/live/phrases", json={"profileId": PID, "recapId": "r1", "aboutMe": "I work in a bakery."})
    assert r.status_code == 200
    out = r.json()["phrases"]
    assert len(out) == 5 and all(p["id"] and p["tip"] and p["text"] for p in out)
    assert out[0]["targets"] == ["the ck in track"]
    assert len(claude.calls) == 1
    call = claude.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["max_tokens"] == 8000
    msg = user_payload(claude)
    assert "I work in a bakery." in msg and "the ck in track" in msg and "the tr in track" in msg
    assert c.get("/v1/live/about", params={"profileId": PID}).json() == {"aboutMe": "I work in a bakery."}


def test_generate_saves_about_once_and_skips_history_load_with_recap(tmp_path):
    claude = FakeClaude(good_draft())
    app, c = make(tmp_path, claude)
    add_recap(app)
    history = LocalHistory(app.state.settings)
    app.state.live_history = history
    saves, loads = [], []
    real_set, real_load = history.set_about, history.load

    async def set_about(pid, text):
        saves.append(text)
        return await real_set(pid, text)

    async def load(pid, limit):
        loads.append(pid)
        return await real_load(pid, limit)

    history.set_about, history.load = set_about, load
    r = c.post("/v1/live/phrases", json={"profileId": PID, "recapId": "r1", "aboutMe": "I bake."})
    assert r.status_code == 200 and saves == ["I bake."] and loads == []
    c.post("/v1/live/phrases", json={"profileId": PID, "recapId": "r1", "aboutMe": ""})
    assert saves == ["I bake.", None]
    assert asyncio.run(history.get_about(PID)) is None


def test_phrases_use_stored_about_and_notes_struggles(tmp_path):
    claude = FakeClaude(good_draft())
    app, c = make(tmp_path, claude)
    c.put("/v1/live/about", json={"profileId": PID, "aboutMe": "I love gardening."})
    asyncio.run(LocalHistory(app.state.settings).save_notes(PID, {"summary": "s", "struggles": [
        {"sound": "i", "pattern": "p", "count": 2}]}))
    assert c.post("/v1/live/phrases", json={"profileId": PID, "recapId": None, "aboutMe": None}).status_code == 200
    msg = user_payload(claude)
    assert "I love gardening." in msg and "the ee sound" in msg


def test_phrases_generic_without_context(tmp_path):
    claude = FakeClaude(good_draft())
    _, c = make(tmp_path, claude)
    assert c.post("/v1/live/phrases", json={"profileId": PID, "recapId": None, "aboutMe": None}).status_code == 200
    assert '"learnerDescription": null' in user_payload(claude)
    assert '"targetParts": []' in user_payload(claude)


def test_other_profiles_recap_is_ignored(tmp_path):
    claude = FakeClaude(good_draft())
    app, c = make(tmp_path, claude)
    add_recap(app, profile="someone-else")
    assert c.post("/v1/live/phrases", json={"profileId": PID, "recapId": "r1", "aboutMe": None}).status_code == 200
    assert "the ck in track" not in user_payload(claude)


def test_pending_recap_is_ignored(tmp_path):
    claude = FakeClaude(good_draft())
    app, c = make(tmp_path, claude)
    add_recap(app, status="pending")
    c.post("/v1/live/phrases", json={"profileId": PID, "recapId": "r1", "aboutMe": None})
    assert "the ck in track" not in user_payload(claude)


def test_invalid_phrases_dropped_and_too_few_is_502(tmp_path):
    bad = [pd("Call 911 now please"), pd("Hello"), pd("This phrase has way too many words for the rule here"),
           pd("Fine words here", tip="Listen to the click."), pd("Smile <b>now</b> please"),
           pd("Good morning, my friend"), pd("Good morning, my friend"), pd("Pass me the sticky tape")]
    app, c = make(tmp_path, FakeClaude(phrases.PhrasesDraft(phrases=[*bad, pd("Keep the back door shut")])))
    r = c.post("/v1/live/phrases", json={"profileId": PID, "recapId": None, "aboutMe": None})
    assert r.status_code == 200
    assert [p["text"] for p in r.json()["phrases"]] == [
        "Good morning, my friend", "Pass me the sticky tape", "Keep the back door shut"]
    app, c = make(tmp_path / "b", FakeClaude(phrases.PhrasesDraft(phrases=[*bad[:5], pd("Good morning, my friend")])))
    r = c.post("/v1/live/phrases", json={"profileId": PID, "recapId": None, "aboutMe": None})
    assert r.status_code == 502 and r.json()["detail"] == "phrases_unavailable"


def test_claude_failure_is_502(tmp_path):
    _, c = make(tmp_path, FakeClaude(fail=True))
    r = c.post("/v1/live/phrases", json={"profileId": PID, "recapId": None, "aboutMe": None})
    assert r.status_code == 502 and r.json()["detail"] == "phrases_unavailable"


def test_phrase_limit(tmp_path):
    _, c = make(tmp_path)
    body = {"profileId": PID, "recapId": None, "aboutMe": None}
    for _ in range(10):
        assert c.post("/v1/live/phrases", json=body).status_code == 200
    r = c.post("/v1/live/phrases", json=body)
    assert r.status_code == 429 and r.json()["detail"] == "phrase_limit"
    assert c.post("/v1/live/phrases", json={**body, "profileId": "kid-2"}).status_code == 200


# ---- assess ----

def fake_azure(monkeypatch, words, *, none=False):
    seen = []

    async def fake(wav, text, settings, http=None):
        seen.append(text)
        return None if none else AzureAssessment(words=[{"word": w, "errorType": e, "accuracy": a} for w, e, a in words])

    monkeypatch.setattr(azure_pronunciation, "assess", fake)
    return seen


def check(c, text="Please pass the rice", profile=PID):
    return c.post("/v1/live/phrases/assess", json={"profileId": profile, "text": text, "audioWav": wav_b64()})


def azure_app(tmp_path):
    return make(tmp_path, azure_speech_key="k", azure_speech_region="westus2")


def test_assess_all_clear(monkeypatch, tmp_path):
    seen = fake_azure(monkeypatch, [("please", "None", 90), ("pass", "None", 75.0)])
    _, c = azure_app(tmp_path)
    r = check(c, "Please pass")
    assert r.json() == {"scoringAvailable": True, "scored": True, "overall": "clear", "words": [
        {"word": "please", "result": "clear"}, {"word": "pass", "result": "clear"}]}
    assert seen == ["Please pass"]


def test_assess_omission_low_and_mixed(monkeypatch, tmp_path):
    fake_azure(monkeypatch, [("please", "None", 90), ("pass", "Mispronunciation", 40), ("the", "Omission", None),
                             ("rice", "None", 80)])
    _, c = azure_app(tmp_path)
    r = check(c).json()
    assert [w["result"] for w in r["words"]] == ["clear", "try_again", "missed", "clear"]
    assert r["overall"] == "almost" and r["scored"] is True
    assert "accuracy" not in json.dumps(r)


def test_assess_try_again_and_unclear(monkeypatch, tmp_path):
    fake_azure(monkeypatch, [("please", "None", 50), ("pass", "None", 60), ("rice", "None", 90)])
    _, c = azure_app(tmp_path)
    assert check(c).json()["overall"] == "try_again"
    fake_azure(monkeypatch, [("please", "Omission", None), ("pass", "Omission", None)])
    assert check(c).json()["overall"] == "unclear"
    fake_azure(monkeypatch, [], none=True)
    assert check(c).json() == {"scoringAvailable": True, "scored": False, "overall": "unclear", "words": []}
    fake_azure(monkeypatch, [])
    assert check(c).json() == {"scoringAvailable": True, "scored": False, "overall": "unclear", "words": []}


def test_assess_not_configured(monkeypatch, tmp_path):
    seen = fake_azure(monkeypatch, [("please", "None", 90)])
    _, c = make(tmp_path)
    assert check(c).json() == {"scoringAvailable": False, "scored": False, "overall": "unclear", "words": []}
    assert seen == []


@pytest.mark.parametrize("text", ["Hello", "Call 911 now please", "x" * 81, "Visit <b>us</b> today", ""])
def test_assess_invalid_text_422(tmp_path, text):
    _, c = azure_app(tmp_path)
    assert check(c, text).status_code == 422


def test_assess_bad_audio_422(tmp_path):
    _, c = azure_app(tmp_path)
    r = c.post("/v1/live/phrases/assess", json={"profileId": PID, "text": "Please pass", "audioWav": "AAAA"})
    assert r.status_code == 422


def test_assess_limit(monkeypatch, tmp_path):
    fake_azure(monkeypatch, [("please", "None", 90)])
    _, c = azure_app(tmp_path)
    for _ in range(60):
        assert check(c, "Please pass").status_code == 200
    r = check(c, "Please pass")
    assert r.status_code == 429
    assert check(c, "Please pass", profile="kid-2").status_code == 200
