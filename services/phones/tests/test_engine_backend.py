"""Backend selection and TorchBackend naming/sync, with a tiny fake model (no weights needed)."""
import dataclasses
import types

import numpy as np
import pytest

torch = pytest.importorskip("torch")
import transformers  # noqa: E402

from phones import engine  # noqa: E402
from phones.config import Settings  # noqa: E402


class FakeCTC(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.w = torch.nn.Parameter(torch.zeros(1))

    def forward(self, x):
        frames = max(1, x.shape[1] // 320)
        return types.SimpleNamespace(logits=torch.zeros(1, frames, 5, dtype=x.dtype, device=x.device) + self.w)


@pytest.fixture
def fake_model(monkeypatch):
    seen = {}

    def from_pretrained(path):
        m = FakeCTC()
        seen["model"] = m
        return m

    monkeypatch.setattr(transformers.Wav2Vec2ForCTC, "from_pretrained", staticmethod(from_pretrained))
    return seen


def settings(tmp_path, backend):
    return dataclasses.replace(Settings(), backend=backend, models_dir=tmp_path, engines_dir=tmp_path)


def set_hw(monkeypatch, mps, cuda=False):
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: mps)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: cuda)


class Recorder:
    def __init__(self, *a):
        self.args = a
        self.name = "rec"


@pytest.fixture
def rec(monkeypatch):
    monkeypatch.setattr(engine, "TorchBackend", lambda *a: Recorder(*a))


def test_auto_prefers_mps_over_cpu(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=True)
    monkeypatch.delenv("PHONES_MPS_FP16", raising=False)
    b = engine.make_backend(settings(tmp_path, "auto"))
    assert b.args[1:] == ("mps", False)


def test_auto_falls_back_to_cpu(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=False)
    assert engine.make_backend(settings(tmp_path, "auto")).args[1:] == ("cpu", False)


def test_auto_prefers_cuda_over_mps(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=True, cuda=True)
    assert engine.make_backend(settings(tmp_path, "auto")).args[1:] == ("cuda", True)


def test_explicit_mps_unavailable_raises(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=False)
    with pytest.raises(RuntimeError, match="torch-mps"):
        engine.make_backend(settings(tmp_path, "torch-mps"))


def test_explicit_mps_fp16_opt_in(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=True)
    monkeypatch.setenv("PHONES_MPS_FP16", "1")
    assert engine.make_backend(settings(tmp_path, "torch-mps")).args[1:] == ("mps", True)


def test_explicit_cpu_skips_mps(monkeypatch, tmp_path, rec):
    set_hw(monkeypatch, mps=True)
    assert engine.make_backend(settings(tmp_path, "torch-cpu")).args[1:] == ("cpu", False)


def test_cpu_backend_name_and_dtype(tmp_path, fake_model):
    b = engine.TorchBackend(tmp_path, "cpu", False)
    assert b.name == "torch-cpu" and b.dtype == torch.float32
    assert b(np.zeros(8000, np.float32)).shape == (25, 5)


def test_mps_backend_naming_warmup_and_sync(monkeypatch, tmp_path, fake_model):
    calls = []
    monkeypatch.setattr(torch.mps, "synchronize", lambda: calls.append(1))
    # run on cpu tensors: the fake model/tensors only need to honour the device string
    real_to = torch.Tensor.to

    def cpu_to(self, *args, **kw):  # redirect "mps" to cpu, keep any dtype argument
        args = [a for a in args if not (isinstance(a, (str, torch.device)))]
        kw.pop("device", None)
        return real_to(self, "cpu", *args, **kw)

    monkeypatch.setattr(torch.Tensor, "to", cpu_to)
    b = engine.TorchBackend(tmp_path, "mps", False)
    assert b.name == "torch-mps" and b.dtype == torch.float32
    assert len(calls) == 1  # warm-up ran and synchronised
    b(np.zeros(8000, np.float32))
    assert len(calls) == 2
    assert engine.TorchBackend(tmp_path, "mps", True).dtype == torch.float16
