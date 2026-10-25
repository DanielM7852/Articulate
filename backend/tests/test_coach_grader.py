import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient
from app.live import coach_grader as cg
from scripts import grade_coach

RAW = "learner-secret-profile"


def word_summary(aid, word, caption=None, verdict="miss", focus="z1"):
    s = {"attemptId": aid, "profileId": RAW, "sound": "i",
         "word": {"word": word, "verdict": verdict, "quality": "usable",
                  "zones": [{"zoneId": "z1", "phoneme": "t", "kind": "stop", "verdict": "miss", "advisory": False},
                            {"zoneId": "z2", "phoneme": "r", "kind": "liquid", "verdict": "miss", "advisory": True}]},
         "focusZoneId": focus}
    if caption is not None:
        s["caption"] = caption
    return s


def write_store(tmp_path, attempts, name="a.json"):
    d = tmp_path / "learners"
    d.mkdir(exist_ok=True)
    (d / name).write_text(json.dumps({"attempts": attempts}))
    return tmp_path


def make_store(tmp_path):
    return write_store(tmp_path, [
        {"summary": word_summary("a1", "track"), "decision": {"caption": "Press the t.", "source": "agent"}},
        {"summary": word_summary("a2", "track"), "decision": {"caption": ""}},
        {"summary": word_summary("a3", "Track"), "decision": {"caption": "Tap the t again.", "source": "fallback"}},
        {"summary": word_summary("a4", "sheep"), "decision": {"caption": "Say sheep.", "source": "agent"}},
        {"summary": word_summary("a5", "track"), "decision": {"caption": "Flick the t.", "source": "agent"}},
    ])


def test_local_loader_order_skip_hash_context(tmp_path):
    turns = cg.load_turns_local(make_store(tmp_path))
    assert [t.attemptId for t in turns] == ["a5", "a4", "a3", "a1"]
    assert all(t.learner == cg.hash_learner(RAW) and len(t.learner) == 8 for t in turns)
    by = {t.attemptId: t for t in turns}
    assert by["a5"].earlierCaptions == ["Press the t.", "Tap the t again."]
    assert by["a3"].earlierCaptions == ["Press the t."]
    assert by["a4"].earlierCaptions == [] and by["a1"].earlierCaptions == []
    assert by["a3"].source == "fallback"
    assert len(cg.load_turns_local(tmp_path, limit=2)) == 2


def test_context_capped_at_three_and_per_learner(tmp_path):
    items = [{"summary": word_summary(f"w{i}", "track"), "decision": {"caption": f"c{i}"}} for i in range(6)]
    write_store(tmp_path, items)
    other = word_summary("o1", "track")
    other["profileId"] = "someone-else"
    write_store(tmp_path, [{"summary": other, "decision": {"caption": "other"}}], "b.json")
    by = {t.attemptId: t for t in cg.load_turns_local(tmp_path)}
    assert by["w5"].earlierCaptions == ["c2", "c3", "c4"]
    assert by["o1"].earlierCaptions == []


def test_vowel_turns_grouped_by_sound(tmp_path):
    def v(aid, sound, cap):
        return {"summary": {"attemptId": aid, "profileId": RAW, "sound": sound, "audio": {"verdict": "off"}},
                "decision": {"caption": cap}}
    write_store(tmp_path, [v("v1", "i", "one"), v("v2", "u", "two"), v("v3", "i", "three")])
    by = {t.attemptId: t for t in cg.load_turns_local(tmp_path)}
    assert by["v3"].earlierCaptions == ["one"] and by["v3"].kind == "vowel"
    assert by["v2"].earlierCaptions == []


def sql_result(columns, rows):
    return [{"schema": {"elements": [{"name": {"some": c}} for c in columns]}, "rows": rows}]


def spacetime_client():
    attempts = [
        ["a1", RAW, "i", {"__timestamp_micros_since_unix_epoch__": 100}, json.dumps(word_summary("a1", "track"))],
        ["a2", RAW, "i", {"__timestamp_micros_since_unix_epoch__": 300}, json.dumps(word_summary("a2", "track"))],
        ["a3", RAW, "i", {"__timestamp_micros_since_unix_epoch__": 200}, json.dumps(word_summary("a3", "track"))],
    ]
    turns = [
        ["a1", RAW, 1, json.dumps({"caption": "first", "source": "agent"})],
        ["a2", RAW, 3, json.dumps({"caption": "third"})],
        ["a3", RAW, 2, json.dumps({"caption": ""})],
    ]

    def handle(request):
        q = request.content.decode()
        if "learner_attempt" in q:
            return httpx.Response(200, json=sql_result(["attempt_id", "profile_id", "sound", "started_at", "summary"], attempts))
        return httpx.Response(200, json=sql_result(["attempt_id", "profile_id", "created_at", "decision"], turns))

    settings = Settings(spacetime_database="db", spacetime_token="t")
    return SpacetimeClient(settings, httpx.MockTransport(handle))


async def test_spacetime_loader():
    turns = await cg.load_turns_spacetime(spacetime_client(), 10)
    assert [t.attemptId for t in turns] == ["a2", "a1"]
    assert turns[0].earlierCaptions == ["first"] and turns[1].source == "agent"
    assert turns[0].learner == cg.hash_learner(RAW)


def test_deterministic_checks():
    assert cg.deterministic_checks("") == ["empty"]
    assert cg.deterministic_checks("Nice try.") == []
    assert "too_long" in cg.deterministic_checks("a" * 161)
    assert "too_many_sentences" not in cg.deterministic_checks("Lovely oo! Your lips were rounded. Let's move on.")
    assert "too_many_sentences" in cg.deterministic_checks("One. Two. Three. Four.")
    assert "has_digits" in cg.deterministic_checks("Try 3 times")
    assert "shaming" in cg.deterministic_checks("That was wrong.")


def grade(tid, **kw):
    base = dict(turnId=tid, matchesScore="pass", rightPart="pass", plainWords="pass", kind="pass",
                freshWording="na", worstIssue="")
    base.update(kw)
    return cg.Grade(**base)


class FakeClient:
    def __init__(self, fn, delay=0.0):
        self.calls, self.active, self.peak, self.lock, self.fn, self.delay = [], 0, 0, threading.Lock(), fn, delay
        self.messages = SimpleNamespace(parse=self.parse)

    def parse(self, **kw):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.calls.append(kw)
        try:
            time.sleep(self.delay)
            return SimpleNamespace(stop_reason="end_turn", parsed_output=self.fn(kw))
        finally:
            with self.lock:
                self.active -= 1


def ids(kw):
    return [t["turnId"] for t in json.loads(kw["messages"][0]["content"])["turns"]]


def many_turns(n):
    return [cg.Turn(f"t{i}", "abcd1234", float(i), "word", "track", {"kind": "word", "word": "track", "zones": []}, f"cap {i}")
            for i in range(n)]


async def test_batching_concurrency_and_model():
    turns = many_turns(10)
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[grade(i) for i in ids(kw)]), delay=0.05)
    grades = await cg.grade_turns(turns, Settings(), client, batch_size=2)
    assert len(grades) == 10 and len(client.calls) == 5
    assert client.peak <= 3 and client.peak >= 2
    assert client.calls[0]["model"] == "claude-opus-5-5"
    assert client.calls[0]["output_config"] == {"effort": "high"}
    assert client.calls[0]["max_tokens"] == 16000


async def test_unknown_ids_dropped_and_missing_ungraded():
    turns = many_turns(3)
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[grade("t0"), grade("bogus")]))
    grades = await cg.grade_turns(turns, Settings(), client, batch_size=10)
    assert set(grades) == {"t0"}
    rows = cg.build_rows(turns, grades)
    assert [r.grade is None for r in rows] == [False, True, True]
    assert "- ungraded: 2" in cg.render_report(rows, {"source": "x", "model": "m", "effort": "high"})


async def test_failed_batch_continues():
    turns = many_turns(4)

    def fn(kw):
        if "t0" in ids(kw):
            raise RuntimeError("boom")
        return cg.GradeBatch(grades=[grade(i) for i in ids(kw)])

    grades = await cg.grade_turns(turns, Settings(), FakeClient(fn), batch_size=2)
    assert set(grades) == {"t2", "t3"}


async def test_payload_whitelist_and_report(tmp_path):
    turns = cg.load_turns_local(make_store(tmp_path))
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[
        grade(i, freshWording="fail" if i == "a5" else "na", matchesScore="fail" if i == "a3" else "pass",
              worstIssue="Praises a miss." if i == "a3" else "") for i in ids(kw)]))
    grades = await cg.grade_turns(turns, Settings(), client)
    assert RAW not in client.calls[0]["messages"][0]["content"]
    assert "profileId" not in client.calls[0]["messages"][0]["content"]
    rows = cg.build_rows(turns, grades)
    path = cg.write_report(rows, {"source": "local", "model": "m", "effort": "high"}, tmp_path / "out")
    text = path.read_text()
    assert "## Worst 10" in text and "Praises a miss." in text and "## Repeats" in text
    assert "Press the t." in text.split("## Repeats")[1]
    assert "By source" in text and "| word |" in text and "| overall |" in text
    assert RAW not in text and RAW not in (tmp_path / "out" / "grades.json").read_text()
    assert cg.hash_learner(RAW) in text


async def test_cli_dry_run_makes_no_model_calls(tmp_path, capsys):
    store = make_store(tmp_path)
    client = FakeClient(lambda kw: None)
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(store), "--batch", "2", "--dry-run"])
    assert await grade_coach.run(args, Settings(), client) == 0
    assert client.calls == []
    assert "turns=4 batches=2" in capsys.readouterr().out


async def test_cli_full_run_writes_report(tmp_path, capsys):
    store = make_store(tmp_path)
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[grade(i) for i in ids(kw)]))
    out = tmp_path / "rep"
    args = grade_coach.parse_args(["--source", "local", "--store-dir", str(store), "--out", str(out)])
    assert await grade_coach.run(args, Settings(), client) == 0
    assert (out / "report.md").exists() and (out / "grades.json").exists()
    assert str(out / "report.md") in capsys.readouterr().out


def _word_turn(tid, quality, verdict, source="agent"):
    compact = {"kind": "word", "word": "track", "quality": quality, "verdict": verdict, "zones": []}
    return cg.Turn(tid, "abcd1234", 1.0, "word", "track", compact, "Say track once more.", source, ["Say track once more."])


async def test_fresh_wording_na_when_try_unclear():
    turns = [_word_turn("u1", "unclear", "miss"), _word_turn("u2", "usable", "insufficient"),
             _word_turn("u3", "usable", "miss")]
    client = FakeClient(lambda kw: cg.GradeBatch(grades=[grade(i, freshWording="fail") for i in ids(kw)]))
    grades = await cg.grade_turns(turns, Settings(), client)
    assert [grades[i].freshWording for i in ("u1", "u2", "u3")] == ["na", "na", "fail"]
    rows = cg.build_rows(turns, {"u1": grade("u1", freshWording="fail")})
    assert rows[0].grade.freshWording == "na"
    assert "always na when the try was unclear" in cg.GRADER_SYSTEM


def test_report_repeats_show_source():
    turns = [_word_turn("r1", "usable", "miss", "agent"), _word_turn("r2", "usable", "miss", "fallback"),
             _word_turn("r3", "usable", "miss", "agent")]
    rows = cg.build_rows(turns, {t.attemptId: grade(t.attemptId, freshWording="fail") for t in turns})
    text = cg.render_report(rows, {"source": "x", "model": "m", "effort": "high"}).split("## Repeats")[1]
    assert "Repeats by source: agent 2, fallback 1" in text
    assert "| source: fallback" in text and text.count("| source: agent") == 2
