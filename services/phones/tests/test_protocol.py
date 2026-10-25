import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from phones.app import create_app
from phones.ctc import Phone, frame_posteriors


class StubRec:
    model_id = "stub/model"
    engine_name = "torch-cpu"
    device = "cpu"
    frame_ms = 20.0
    id2tok = {0: "<pad>", 1: "<s>", 2: "</s>", 3: "<unk>", 4: "a", 5: "b", 6: "c", 7: "d", 8: "e", 9: "f", 10: "g"}
    blank_id = 0

    def logits(self, wave):
        return np.zeros((10, 4), dtype=np.float32)

    def analyze(self, wave, offset_ms=0.0):
        rng = np.random.default_rng(len(wave))
        lg = rng.normal(0, 3, (len(wave) // 320, len(self.id2tok))).astype(np.float32)
        return self.phones(wave, offset_ms), frame_posteriors(lg, self.id2tok, self.blank_id, self.frame_ms, offset_ms)

    def phones(self, wave, offset_ms=0.0):
        n = int(len(wave) / 320)
        return [Phone("a", offset_ms + i * 100.0, offset_ms + i * 100.0 + 80, 0.8) for i in range(n // 5)]


@pytest.fixture()
def client():
    with TestClient(create_app(StubRec())) as c:
        yield c


def wav_bytes(seconds=1.0, sr=16000):
    t = np.arange(int(sr * seconds)) / sr
    buf = io.BytesIO()
    sf.write(buf, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr, format="WAV")
    return buf.getvalue()


def test_health(client):
    j = client.get("/health").json()
    assert j == {"ok": True, "model": "stub/model", "engine": "torch-cpu", "device": "cpu"}


def test_clip_wav_and_json(client):
    r = client.post("/v1/phones", content=wav_bytes(), headers={"content-type": "audio/wav"})
    assert r.status_code == 200
    j = r.json()
    assert j["model"] == "stub/model" and j["engine"] == "torch-cpu" and j["phones"] and "inferMs" in j
    assert set(j["phones"][0]) == {"p", "startMs", "endMs", "conf"}
    import base64

    r2 = client.post("/v1/phones", json={"audio": base64.b64encode(wav_bytes()).decode()})
    assert r2.status_code == 200
    assert client.post("/v1/phones", content=b"garbage").status_code == 400


def test_ws_protocol(client):
    with client.websocket_connect("/ws/phones", headers={"origin": "http://127.0.0.1:5176"}) as ws:
        ready = ws.receive_json()
        assert ready == {"type": "ready", "model": "stub/model", "engine": "torch-cpu", "frameMs": 20.0, "sampleRate": 16000}
        t = np.arange(2560) / 16000
        chunk = (np.sin(2 * np.pi * 220 * t) * 8000).astype("<i2").tobytes()  # 160 ms
        msgs = []
        for _ in range(14):
            ws.send_bytes(chunk)
        # messages arrive after the first >= 500 ms; drain what's available by sending reset marker
        ws.send_text('{"type":"reset"}')
        ws.send_bytes(chunk * 4)  # 640 ms after reset -> exactly one window with stream clock restarted
        while True:
            m = ws.receive_json()
            msgs.append(m)
            if m["windowEndMs"] == 640.0 and m["seq"] == 1 and len(msgs) > 1:
                break
        assert all(m["type"] == "phones" for m in msgs)
        seen = [(p["startMs"], p["endMs"]) for m in msgs[:-1] for p in m["committed"]]
        assert len(seen) == len(set(seen))  # no duplicate committed phones in the pre-reset stream
        last = msgs[-1]
        assert set(last) == {"type", "seq", "windowEndMs", "committed", "provisional", "inferMs", "frames"}


def test_ws_origin_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/phones", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()


def test_ws_frames(client):
    special = {"<pad>", "<s>", "</s>", "<unk>"}
    with client.websocket_connect("/ws/phones", headers={"origin": "http://127.0.0.1:5176"}) as ws:
        ws.receive_json()
        t = np.arange(2560) / 16000
        chunk = (np.sin(2 * np.pi * 220 * t) * 8000).astype("<i2").tobytes()
        for _ in range(10):
            ws.send_bytes(chunk)
        msgs = [ws.receive_json() for _ in range(3)]
    ts = []
    prev_end = float("-inf")
    for m in msgs:
        assert m["type"] == "phones" and isinstance(m["frames"], list) and m["frames"]
        for f in m["frames"]:
            assert prev_end < f["t"] <= m["windowEndMs"]
            assert 0.0 <= f["mass"] <= 1.0
            assert len(f["top"]) <= 5
            probs = [p for _, p in f["top"]]
            assert probs == sorted(probs, reverse=True) and all(p >= 0.01 for p in probs)
            assert not ({s for s, _ in f["top"]} & special)
            assert len({s for s, _ in f["top"]}) == len(f["top"])
            ts.append(f["t"])
        prev_end = m["windowEndMs"]
    assert ts == sorted(ts) and len(ts) == len(set(ts))
