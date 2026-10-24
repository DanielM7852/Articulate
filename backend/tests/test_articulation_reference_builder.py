import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

_PATH = Path(__file__).resolve().parents[1] / "scripts" / "build_articulation_reference.py"
_spec = importlib.util.spec_from_file_location("build_articulation_reference", _PATH)
bar = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bar)


def make_bundle(tby_edge=-5.0, tby_mid=1.0, segments=None, vad_status="ok"):
    """2 s clip, 20 ms frames; tongue height is tby_edge outside 600-1400 ms and tby_mid inside."""
    stamps = [i * 20.0 for i in range(100)]
    rows = []
    for t in stamps:
        tby = tby_mid if 600 <= t <= 1400 else tby_edge
        rows.append([-0.5, tby, -1.0, 0.0, 1.0, 0.0, -1.0])
    if segments is None:
        segments = [
            {"startSample": 3200, "endSample": 6400, "startMs": 200, "endMs": 400},
            {"startSample": 3200, "endSample": 28800, "startMs": 200, "endMs": 1800},
        ]
    return {
        "schemaVersion": "articulate.articulation/1",
        "audio": {"durationMs": 2000, "clippedFraction": 0},
        "models": {
            "sparc": {"status": "ok", "series": {"ema": {
                "channels": ["TBX", "TBY", "LIY", "ULX", "ULY", "LLX", "LLY"],
                "values": rows, "timestampsMs": stamps, "withinAudio": [True] * 100,
            }}},
            "silero_vad": {"status": vad_status, "segments": segments},
        },
    }


def test_trim_to_nucleus_uses_central_half_of_longest_segment():
    bundle = make_bundle()
    out = bar.trim_to_nucleus(bundle)
    seg = out["models"]["silero_vad"]["segments"]
    assert seg == [{"startMs": 600.0, "endMs": 1400.0, "startSample": 9600, "endSample": 22400}]
    assert len(bundle["models"]["silero_vad"]["segments"]) == 2  # input untouched


@pytest.mark.parametrize("kw", [{"segments": []}, {"vad_status": "failed"}])
def test_trim_without_speech_returns_none(kw):
    assert bar.trim_to_nucleus(make_bundle(**kw)) is None
    assert bar.clip_record("v", "i", "heed", make_bundle(**kw)) is None


def test_clip_record_excludes_consonant_frames():
    rec = bar.clip_record("v1", "i", "heed", make_bundle())
    assert rec["tongueHeight"] == 1.0  # edges at -5.0 were trimmed away
    assert rec["quality"] == "ok" and rec["voice"] == "v1" and rec["word"] == "heed"


def med(h, f):
    return {"tongueHeight": h, "tongueFront": f}


def test_voice_passes_and_reasons():
    good = {"i": med(0.7, 0.8), "u": med(0.2, 0.4), "a": med(-2.0, -0.4)}
    assert bar.voice_passes(good) == (True, None)
    assert bar.voice_passes({"i": good["i"], "u": good["u"]}) == (False, "missing_a")
    assert bar.voice_passes({**good, "i": med(-1.5, 0.8)})[0] is False
    assert bar.voice_passes({**good, "u": med(-1.9, 0.4)}) == (False, "height_u_not_above_a")
    assert bar.voice_passes({**good, "i": med(0.7, -0.3)}) == (False, "front_i_not_ahead_of_a")
    assert bar.voice_passes({**good, "u": med(0.2, 0.85)}) == (False, "front_i_not_ahead_of_u")


def fake_clips(voice, h, f):
    out = []
    for s in bar.SOUNDS:
        for w in range(3):
            out.append({"voice": voice, "sound": s, "word": str(w), "frames": 30, "quality": "ok",
                        "tongueHeight": h[s] + w * 0.01, "tongueFront": f[s], "jawOpen": 1.0,
                        "lipForward": 0.5, "lipAperture": 0.2})
    return out


H = {"i": 0.7, "u": 0.2, "a": -2.0}
F = {"i": 0.8, "u": 0.4, "a": -0.4}


def test_voice_medians():
    m = bar.voice_medians(fake_clips("v", H, F))
    assert m["i"]["tongueHeight"] == pytest.approx(0.71)
    assert set(m) == {"i", "u", "a"}


def test_build_reference_excludes_failing_voice_and_aggregates():
    voices = [{"id": f"v{k}", "name": f"V{k}", "isAva": k == 0} for k in range(5)]
    clips = []
    for k in range(4):
        clips += fake_clips(f"v{k}", H, F)
    clips += fake_clips("v4", {"i": -1.5, "u": 0.2, "a": -2.0}, F)  # i not above a
    ref, problems = bar.build_reference(voices, clips, model="m", version="x", generated_at="T")
    assert problems == []
    assert list(ref)[:3] == ["v", "source", "model"]
    bad = ref["voices"][4]
    assert bad["included"] is False and bad["reason"] == "height_i_not_above_a"
    assert ref["voices"][0]["isAva"] is True and ref["voices"][0]["clips"] == 9
    assert ref["sounds"]["i"]["n"] == 4
    assert ref["sounds"]["i"]["tongueHeight"]["median"] == 0.71
    assert len(ref["sounds"]["a"]["tongueFront"]["values"]) == 4
    json.dumps(ref)


def test_build_reference_refuses_with_too_few_voices():
    voices = [{"id": f"v{k}", "name": "x"} for k in range(3)]
    clips = fake_clips("v0", H, F) + fake_clips("v1", H, F)
    ref, problems = bar.build_reference(voices, clips, model="m", version="x")
    assert problems
    assert ref["voices"][2]["reason"] == "no_usable_clips"


def test_parse_voices_response_list_and_data():
    item = {"id": "a", "name": "A", "language": "en", "gender": "feminine"}
    assert bar.parse_voices_response([item, {"name": "no id"}])[0][0]["id"] == "a"
    voices, nxt = bar.parse_voices_response({"data": [item], "next_page": "tok", "has_more": True})
    assert voices[0]["gender"] == "feminine" and nxt == "tok"
    assert bar.parse_voices_response({"oops": 1}) == ([], None)


def test_select_voices_english_only_mixed_gender_capped():
    cands = [
        {"id": "f1", "name": "", "language": "en", "gender": "feminine", "description": ""},
        {"id": "f2", "name": "", "language": "en", "gender": "feminine", "description": ""},
        {"id": "m1", "name": "", "language": "en", "gender": "masculine", "description": ""},
        {"id": "fr", "name": "", "language": "fr", "gender": "masculine", "description": ""},
        {"id": "ava", "name": "", "language": "en", "gender": "feminine", "description": ""},
    ]
    got = [v["id"] for v in bar.select_voices(cands, 3, {"ava"})]
    assert got == ["f1", "m1", "f2"]


def test_fetch_voices_follows_pages_with_injected_client():
    import httpx

    def handler(request):
        if "starting_after" in request.url.params:
            return httpx.Response(200, json={"data": [{"id": "b", "language": "en"}]})
        return httpx.Response(200, json={"data": [{"id": "a", "language": "en"}], "next_page": "t"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert [v["id"] for v in bar.fetch_voices("k", "v", c)] == ["a", "b"]


def test_dry_run_needs_no_network_or_key(capsys, tmp_path):
    out = tmp_path / "ref.json"
    rc = bar.main(["--dry-run", "--out", str(out), "--voices", "x1,x2"])
    text = capsys.readouterr().out
    assert rc == 0 and "x1" in text and "Words" in text
    assert not out.exists()
