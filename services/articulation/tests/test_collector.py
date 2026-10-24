import io
import json
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from articulate_models.adapters import load_arti6_checkpoints
from articulate_models.api import create_app
from articulate_models.assets import AssetsUnavailable
from articulate_models.assets import Assets
from articulate_models.audio import AudioError, decode_wav
from articulate_models.contract import series
from articulate_models.runner import Collector
from articulate_models.prepare import LOCK, sha256


def wav(samples=None, sr=16000, subtype="PCM_16"):
    samples = 0.2 * np.sin(np.arange(sr) * 2 * np.pi * 180 / sr) if samples is None else samples
    file = io.BytesIO()
    sf.write(file, samples, sr, format="WAV", subtype=subtype)
    return file.getvalue()


class FakeModel:
    provenance = {"testOnly": True}

    def __init__(self, *_):
        pass

    def infer(self, samples):
        return {
            "test": series(
                [[1], [2]], ["feature"], "test_units", 320, 39.5, len(samples), interpretation="test_only"
            )
        }, []


def test_decoder_resamples_and_records_original_capture():
    audio = decode_wav(wav(sr=48000))
    assert len(audio.samples) == 16000 and audio.metadata["originalSampleRate"] == 48000
    assert audio.metadata["durationMs"] == 1000 and len(audio.metadata["sha256"]) == 64
    assert audio.quality_flags == []


def test_zero_dc_short_clipping_and_stereo_cancellation_are_explicit():
    assert "insufficient_signal" in decode_wav(wav(np.zeros(16000))).quality_flags
    assert "constant_signal" in decode_wav(wav(np.ones(16000) * 0.2)).quality_flags
    assert "short_audio" in decode_wav(wav(np.zeros(100))).quality_flags
    assert "clipping" in decode_wav(wav(np.ones(16000))).quality_flags
    source = np.sin(np.arange(16000)) * 0.2
    assert (
        "stereo_cancellation"
        in decode_wav(wav(np.stack([source, -source], axis=1), subtype="FLOAT")).quality_flags
    )


def test_decoder_rejects_empty_nonwav_too_long_and_nonfinite():
    for data in (b"", b"not a WAV", wav(np.zeros(16000 * 31))):
        with pytest.raises(AudioError):
            decode_wav(data)
    with pytest.raises(AudioError):
        decode_wav(wav(np.full(16000, np.nan), subtype="FLOAT"))


def test_preserves_nominal_native_timing_and_outside_audio_rows():
    result = series([[1], [2], [3]], ["a"], "units", 320, -0.5, 500, interpretation="estimate")
    assert result["values"] == [[1], [2], [3]]
    assert result["withinAudio"] == [False, True, False]
    assert result["summary"]["a"]["count"] == 1
    assert result["timestampsMs"] == [-0.03125, 19.96875, 39.96875]
    with pytest.raises(ValueError, match="nonfinite"):
        series([np.nan], ["a"], "units", 320, 0, 1000, interpretation="estimate")


def test_collector_keeps_models_separate_and_maps_to_original_capture_clock():
    collector = Collector(factories={name: FakeModel for name in ("sparc", "arti6", "silero_vad")})
    result = collector.analyze(wav(), capture_start_monotonic_ms=1000, time_origin_unix_ms=100000)
    assert result["status"] == "ok" and len(result["models"]) == 3
    sequence = result["models"]["sparc"]["series"]["test"]
    assert sequence["captureTimestampsMonotonicMs"][0] == 1000 + 39.5 / 16
    assert collector.analyze(wav(), names=["sparc"])["models"]["sparc"]["status"] == "ok"
    json.dumps(result, allow_nan=False)


def test_missing_models_never_silently_return_surrogate_features():
    def missing(*_):
        raise AssetsUnavailable("prepare checkpoints")

    collector = Collector(factories={"sparc": FakeModel, "arti6": missing})
    result = collector.analyze(wav(), names=["sparc", "arti6"])
    assert result["status"] == "partial"
    assert result["models"]["arti6"]["status"] == "unavailable"
    assert result["models"]["arti6"]["series"] == {}


def test_inference_failure_does_not_hide_other_results_or_stick_the_lock():
    class Broken(FakeModel):
        def infer(self, _):
            raise ValueError("bad output")

    collector = Collector(factories={"sparc": Broken, "silero_vad": FakeModel})
    output = collector.analyze(wav(), names=["sparc", "silero_vad"])
    assert output["models"]["sparc"]["status"] == "error"
    assert output["models"]["silero_vad"]["status"] == "ok" and not collector.lock.locked()


def test_silence_skips_inversion_instead_of_normalizing_zero_or_inventing_anatomy():
    collector = Collector(factories={"silero_vad": FakeModel})
    result = collector.analyze(wav(np.zeros(16000)))
    assert result["models"]["sparc"]["status"] == "skipped"
    assert result["models"]["arti6"]["series"] == {}
    assert result["models"]["silero_vad"]["status"] == "ok"


def test_arti6_requires_the_real_lora_checkpoint_and_all_learned_weights():
    keys = {
        "backbone_model.encoder.lora_A": 0,
        "backbone_model.encoder.weight": 0,
        "out_layer.0.weight": 0,
        "weights": 0,
    }
    model = SimpleNamespace(
        state_dict=lambda: keys,
        load_state_dict=lambda state, strict: SimpleNamespace(
            missing_keys=["backbone_model.encoder.weight"], unexpected_keys=[]
        ),
    )
    filtered = {"out_layer.0.weight": 1, "weights": 2}
    lora = {"backbone_model.encoder.lora_A": 3}
    assert load_arti6_checkpoints(model, filtered, lora)["loraTensorCount"] == 1
    with pytest.raises(ValueError, match="LoRA"):
        load_arti6_checkpoints(model, filtered, filtered)
    with pytest.raises(ValueError, match="downstream"):
        load_arti6_checkpoints(model, {}, lora)


def test_api_handles_bad_audio_missing_clock_unknown_model_busy_and_provides_schema():
    collector = Collector(factories={"sparc": FakeModel})
    client = TestClient(create_app(collector))
    assert client.post("/v1/articulation/analyze?models=sparc", content=b"bad").status_code == 422
    assert client.post("/v1/articulation/analyze?models=other", content=wav()).status_code == 400
    assert (
        client.post(
            "/v1/articulation/analyze?models=sparc&capture_start_monotonic_ms=1", content=wav()
        ).status_code
        == 400
    )
    collector.lock.acquire()
    try:
        response = client.post("/v1/articulation/analyze?models=sparc", content=wav())
        assert response.status_code == 503 and response.headers["Retry-After"] == "2"
    finally:
        collector.lock.release()
    response = client.post(
        "/v1/articulation/analyze?models=sparc", content=wav(), headers={"Content-Type": "audio/wav"}
    )
    assert response.status_code == 200 and response.json()["models"]["sparc"]["status"] == "ok"
    assert client.get("/v1/articulation/models").json()["models"]["sparc"]["status"] == "loaded"


def test_validation_rejects_fabricated_clocks_and_attempt_ids():
    collector = Collector(factories={"sparc": FakeModel})
    with pytest.raises(ValueError):
        collector.analyze(
            wav(), names=["sparc"], capture_start_monotonic_ms=float("nan"), time_origin_unix_ms=10
        )
    with pytest.raises(ValueError):
        collector.analyze(wav(), attempt_id="not-an-id")


def test_asset_hashes_and_pinned_projection_are_enforced(tmp_path):
    path = tmp_path / "sparc" / "wavlm_large-9_cut-10_mngu_linear.pkl"
    path.parent.mkdir()
    path.write_bytes(b"not the official projection")
    key = "sparc/wavlm_large-9_cut-10_mngu_linear.pkl"
    manifest = {
        "models": {"sparc": LOCK["sparc"]},
        "artifacts": {key: {"path": key, "bytes": path.stat().st_size, "sha256": sha256(path)}},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(AssetsUnavailable, match="pinned official"):
        Assets(tmp_path).artifact(key)
    manifest["artifacts"][key]["sha256"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(AssetsUnavailable, match="checksum"):
        Assets(tmp_path).artifact(key)


def test_status_does_not_claim_prepared_if_the_checkpoint_files_are_missing(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({"models": {"sparc": LOCK["sparc"]}, "artifacts": {}}))
    assert Collector(tmp_path).status()["models"]["sparc"]["status"] == "unavailable"


def test_http_body_limit_is_enforced_before_decoding(monkeypatch):
    from articulate_models import api

    monkeypatch.setattr(api, "MAX_BYTES", 8)
    client = TestClient(create_app(Collector(factories={"sparc": FakeModel})))
    assert client.post("/v1/articulation/analyze?models=sparc", content=b"x" * 9).status_code == 413
