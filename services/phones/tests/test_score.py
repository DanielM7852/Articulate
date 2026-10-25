import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient

from phones.app import create_app
from test_protocol import wav_bytes

TOK = ["<pad>", "t", "ɹ", "æ", "k", "kʰ"]


class ScoreRec:
    model_id = "stub/model"
    engine_name = "torch-cpu"
    device = "cpu"
    frame_ms = 20.0
    blank_id = 0
    id2tok = dict(enumerate(TOK))

    def logits(self, wave):
        rows = []
        for tok in [0, 1, 1, 0, 0, 2, 2, 0, 0, 3, 3, 0, 0, 5, 5, 0, 0, 0]:
            r = np.zeros(len(TOK), dtype=np.float32)
            r[tok] = 8
            rows.append(r)
        return np.array(rows)

    def phones(self, wave, offset_ms=0.0):
        return []


@pytest.fixture()
def client():
    with TestClient(create_app(ScoreRec())) as c:
        yield c


def body(targets, key="audioBase64"):
    return {key: base64.b64encode(wav_bytes()).decode(), "targets": targets}


def test_score_ok(client):
    r = client.post("/v1/phones/score", json=body(["t", "r", "æ", "k"]))
    assert r.status_code == 200
    j = r.json()
    assert [t["p"] for t in j["targets"]] == ["t", "ɹ", "æ", "k"]
    t0 = j["targets"][0]
    assert set(t0) == {"p", "startMs", "endMs", "peakMs", "post", "gop", "best", "bestPost"}
    assert t0["post"] > 0.9 and j["targets"][3]["post"] > 0.9  # kʰ folded into k
    starts = [t["startMs"] for t in j["targets"]]
    assert starts == sorted(starts)
    assert [p["p"] for p in j["phones"]] == ["t", "ɹ", "æ", "kʰ"]
    assert {"alignLogProb", "inferMs", "model", "engine"} <= set(j)


def test_score_alt_key(client):
    assert client.post("/v1/phones/score", json=body(["t"], key="audio")).status_code == 200


@pytest.mark.parametrize("targets", [[], ["zz"], ["t"] * 13, "t"])
def test_score_400(client, targets):
    r = client.post("/v1/phones/score", json=body(targets))
    assert r.status_code == 400 and r.json()["detail"]


def test_score_bad_audio(client):
    r = client.post("/v1/phones/score", json={"audioBase64": "AAAA", "targets": ["t"]})
    assert r.status_code == 400


def test_cors_preflight(client):
    r = client.options("/v1/phones/score", headers={"Origin": "http://127.0.0.1:5176",
                                                    "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "http://127.0.0.1:5176"
