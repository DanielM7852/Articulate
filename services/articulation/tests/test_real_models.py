"""Explicit real checkpoint smoke test; unit tests never download or substitute model outputs."""

import json
import os
from pathlib import Path

import numpy as np
import pytest

from articulate_models.runner import Collector


@pytest.mark.models
@pytest.mark.skipif(
    not os.environ.get("ARTICULATION_SMOKE_WAV"), reason="Set ARTICULATION_SMOKE_WAV to a local speech WAV"
)
def test_all_pretrained_models_on_real_speech(tmp_path, monkeypatch):
    import socket

    def no_network(*_args, **_kwargs):
        raise AssertionError("Model inference must not open a network connection")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    collector = Collector()
    result = collector.analyze(Path(os.environ["ARTICULATION_SMOKE_WAV"]).read_bytes())
    assert result["status"] == "ok", {key: model["error"] for key, model in result["models"].items()}
    import torch

    assert torch.get_num_threads() == max(1, min(16, int(os.environ.get("ARTICULATION_THREADS", "4"))))
    sparc, arti6, vad = (result["models"][key] for key in ("sparc", "arti6", "silero_vad"))
    assert len(sparc["series"]["ema"]["channels"]) == 12
    assert len(arti6["series"]["articulators"]["channels"]) == 6
    assert arti6["provenance"]["checkpointValidation"]["loraTensorCount"] == 44
    assert "larynx" in arti6["series"]["articulators"]["channels"]
    assert len(vad["segments"]) >= 1
    for model in result["models"].values():
        assert model["provenance"]["artifacts"]
        for sequence in model["series"].values():
            assert len(sequence["timestampsMs"]) == len(sequence["values"])
            assert len(sequence["values"]) > 10 and np.isfinite(sequence["values"]).all()
    (tmp_path / "speech-model-observations.json").write_text(
        json.dumps(result, allow_nan=False), encoding="utf-8"
    )
    # Stateful VAD must not carry speech over into a silent second attempt.
    import io
    import soundfile as sf

    file = io.BytesIO()
    sf.write(file, np.zeros(16000), 16000, format="WAV")
    quiet = collector.analyze(file.getvalue())
    assert quiet["models"]["silero_vad"]["segments"] == []
    assert quiet["models"]["sparc"]["status"] == "skipped"
    assert quiet["models"]["arti6"]["status"] == "skipped"
