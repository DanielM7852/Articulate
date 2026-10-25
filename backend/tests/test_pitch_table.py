"""Parselmouth tables and the cues they are allowed to support."""

import asyncio
import math
import struct
import wave
from io import BytesIO

from fastapi.testclient import TestClient

from app.audio.pitch_table import advise_word, choose_cue, compare_wav, cue_line, easier_phrase, extract_table, line_ok, phrase_cue, read_pcm16
from app.main import create_app
from tests.support import make_settings
from tests.test_articulation_route import AID, H, Q, URL, FakeHistory


def _summary(voiced_ms, f0=180, f1=500, f2=1800, frames=20):
    return {"voicedFrames": frames, "voicedMs": voiced_ms, "f0Hz": f0, "f1Hz": f1, "f2Hz": f2}


def _sine_wav(seconds=0.6, hz=180, rate=16000) -> bytes:
    count = int(rate * seconds)
    buf = BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        frames = b"".join(
            struct.pack("<h", int(16000 * math.sin(2 * math.pi * hz * i / rate))) for i in range(count)
        )
        handle.writeframes(frames)
    return buf.getvalue()


def test_short_take_asks_to_finish_the_word():
    cue = choose_cue(_summary(200), _summary(500))
    assert cue == "finish"
    assert "end of the word" in cue_line("heed", cue)


def test_lower_first_formant_opens_the_mouth():
    assert choose_cue(_summary(400, f1=300), _summary(400, f1=500)) == "mouth_more_open"


def test_lower_second_formant_moves_the_tongue_forward():
    assert choose_cue(_summary(400, f2=1200), _summary(400, f2=1800)) == "tongue_forward"


def test_pitch_alone_does_not_move_the_tongue():
    assert choose_cue(_summary(400, f0=120), _summary(400, f0=220)) is None


def test_mouth_line_cannot_add_the_tongue():
    assert line_ok("Compared with the reference heed, open your mouth a little more.", "mouth_more_open", "heed")
    assert not line_ok(
        "Compared with the reference heed, open your mouth and move your tongue forward.",
        "mouth_more_open",
        "heed",
    )


def test_same_measured_cue_steps_down_after_two_misses(tmp_path):
    line, source = asyncio.run(phrase_cue(make_settings(tmp_path), object(), "head", "finish", 2))
    assert source == "fallback"
    assert line == easier_phrase("head", "finish")
    assert "ending" in line


def test_one_repeat_keeps_the_measured_line(tmp_path):
    line, source = asyncio.run(phrase_cue(make_settings(tmp_path), None, "head", "finish", 1))
    assert source == "fallback"
    assert line == cue_line("head", "finish")


def test_sine_becomes_a_voiced_table(tmp_path):
    samples, rate = read_pcm16(_sine_wav())
    table = extract_table(samples, rate)
    assert table is not None and table["voicedFrames"] >= 8
    assert 150 <= table["f0Hz"] <= 220
    assert all(row["f0Hz"] is None or row["f0Hz"] > 0 for row in table["rows"])
    stored = compare_wav(make_settings(tmp_path), _sine_wav(), "i")
    assert stored["word"] == "heed" and stored["reference"] is None and stored["cue"] is None


def test_head_uses_the_named_reference_word(tmp_path):
    stored = compare_wav(make_settings(tmp_path), _sine_wav(), "i", "head")
    assert stored["word"] == "head"


def test_head_advice_waits_for_the_reference(tmp_path):
    result = asyncio.run(advise_word(make_settings(tmp_path), None, _sine_wav(), "head"))
    assert result["cue"] is None
    assert "will not guess" in result["advice"]
    assert result["features"]["pitchTable"]["word"] == "head"


def test_word_match_stores_the_head_table(tmp_path):
    app = create_app(make_settings(tmp_path, articulation_url=""))
    history = FakeHistory()
    app.state.live_history = history
    response = TestClient(app).post("/v1/word-match?profileId=learner-abc", content=_sine_wav(), headers=H)
    assert response.status_code == 200
    body = response.json()
    assert body["word"] == "head" and body["stored"] is True
    assert history.recorded[0][3]["pitchTable"]["word"] == "head"


def test_upload_stores_the_table_without_a_collector(tmp_path):
    app = create_app(make_settings(tmp_path, articulation_url=""))
    history = FakeHistory()
    app.state.live_history = history
    response = TestClient(app).post(URL + Q, content=_sine_wav(), headers=H)
    assert response.status_code == 202 and response.json() == {"accepted": True}
    assert history.recorded[0][1] == AID
    table = history.recorded[0][3]["pitchTable"]
    assert table["source"] == "parselmouth" and table["learner"]["rows"]
