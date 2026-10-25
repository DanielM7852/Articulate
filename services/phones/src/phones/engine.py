"""Inference backends: TensorRT FP16 -> torch FP16 (CUDA) -> torch MPS (Apple GPU, fp32) -> torch CPU, chosen automatically."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import numpy as np

from .config import Settings
from .ctc import Phone, frame_posteriors, greedy_decode, normalize

log = logging.getLogger("phones.engine")

SAMPLES_PER_FRAME = 320  # wav2vec2 conv stack stride -> 20 ms at 16 kHz


class TorchBackend:
    def __init__(self, model_dir: Path, device: str, fp16: bool):
        import torch
        from transformers import Wav2Vec2ForCTC

        self.torch = torch
        self.device = device
        self.dtype = torch.float16 if fp16 else torch.float32
        self.model = Wav2Vec2ForCTC.from_pretrained(model_dir).to(device=device, dtype=self.dtype).eval()
        if device == "cuda":
            self.name = "torch-fp16" if fp16 else "torch-cuda-fp32"
        elif device == "mps":
            self.name = "torch-mps"
        else:
            self.name = "torch-cpu"
        if device == "mps":  # compile kernels now so the first real request is not slow
            self(np.zeros(32000, np.float32))

    def __call__(self, wave: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.inference_mode():
            x = torch.from_numpy(wave)[None].to(self.device, self.dtype)
            out = self.model(x).logits[0].float()
            if self.device == "cuda":
                torch.cuda.synchronize()
            elif self.device == "mps":
                torch.mps.synchronize()
            return out.cpu().numpy()


class TrtBackend:
    name = "tensorrt-fp16"
    device = "cuda"

    def __init__(self, plan_path: Path):
        import tensorrt as trt
        import torch

        self.torch, self.trt = torch, trt
        self.logger = trt.Logger(trt.Logger.WARNING)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(plan_path.read_bytes())
        if self.engine is None:
            raise RuntimeError(f"failed to deserialize {plan_path}")
        self.ctx = self.engine.create_execution_context()
        self.in_name, self.out_name = None, None
        for i in range(self.engine.num_io_tensors):
            n = self.engine.get_tensor_name(i)
            if self.engine.get_tensor_mode(n) == trt.TensorIOMode.INPUT:
                self.in_name = n
            else:
                self.out_name = n
        self.out_dtype = {trt.DataType.FLOAT: torch.float32, trt.DataType.HALF: torch.float16}[
            self.engine.get_tensor_dtype(self.out_name)
        ]
        self.stream = torch.cuda.Stream()

    def __call__(self, wave: np.ndarray) -> np.ndarray:
        torch = self.torch
        x = torch.from_numpy(wave)[None].to("cuda", torch.float32).contiguous()
        self.ctx.set_input_shape(self.in_name, tuple(x.shape))
        shape = tuple(self.ctx.get_tensor_shape(self.out_name))
        y = torch.empty(shape, dtype=self.out_dtype, device="cuda")
        self.ctx.set_tensor_address(self.in_name, x.data_ptr())
        self.ctx.set_tensor_address(self.out_name, y.data_ptr())
        with torch.cuda.stream(self.stream):
            self.stream.wait_stream(torch.cuda.current_stream())
            if not self.ctx.execute_async_v3(self.stream.cuda_stream):
                raise RuntimeError("TensorRT execute_async_v3 failed")
        self.stream.synchronize()
        return y[0].float().cpu().numpy()


class Recognizer:
    """Wraps a backend with the model vocab. Backend: callable(normalized float32 wave) -> logits [T, V]."""

    def __init__(self, model_id: str, backend, id2tok: dict[int, str], blank_id: int, frame_ms: float = 20.0):
        self.model_id = model_id
        self.backend = backend
        self.id2tok = id2tok
        self.blank_id = blank_id
        self.frame_ms = frame_ms

    @property
    def engine_name(self) -> str:
        return self.backend.name

    @property
    def device(self) -> str:
        return self.backend.device

    # TensorRT profile covers 8000..64000 samples. Longer clips run in overlapping 4 s chunks (stride 3 s, cut at
    # the middle of each 1 s overlap; both multiples of the 320-sample frame hop so frames line up); shorter ones
    # are zero-padded and the extra frames dropped.
    MIN_SAMPLES, CHUNK, STRIDE = 8000, 64000, 48000

    def logits(self, wave: np.ndarray) -> np.ndarray:
        x = normalize(wave)
        n = len(x)
        if n < self.MIN_SAMPLES:
            y = self.backend(np.concatenate([x, np.zeros(self.MIN_SAMPLES - n, np.float32)]))
            return y[: max(1, (n - 400) // SAMPLES_PER_FRAME + 1)]
        if n <= self.CHUNK:
            return self.backend(x)
        half = (self.CHUNK - self.STRIDE) // SAMPLES_PER_FRAME // 2  # frames dropped at each chunk seam
        parts, start = [], 0
        while True:
            end = min(start + self.CHUNK, n)
            if end - start < self.MIN_SAMPLES:  # tiny tail: it is already covered by the previous chunk
                break
            y = self.backend(x[start:end])
            last = end >= n
            lo = 0 if start == 0 else half
            hi = len(y) if last else len(y) - half
            parts.append(y[lo:hi])
            if last:
                break
            start += self.STRIDE
        return np.concatenate(parts, axis=0)

    def phones(self, wave: np.ndarray, offset_ms: float = 0.0) -> list[Phone]:
        return greedy_decode(self.logits(wave), self.id2tok, self.blank_id, self.frame_ms, offset_ms)


    def analyze(self, wave: np.ndarray, offset_ms: float = 0.0) -> tuple[list[Phone], list[dict]]:
        """One inference -> (greedy phones, per-frame posteriors), both in stream time."""
        lg = self.logits(wave)
        return (greedy_decode(lg, self.id2tok, self.blank_id, self.frame_ms, offset_ms),
                frame_posteriors(lg, self.id2tok, self.blank_id, self.frame_ms, offset_ms))


def load_vocab(model_dir: Path) -> tuple[dict[int, str], int]:
    vocab = json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    return {int(v): k for k, v in vocab.items()}, int(cfg.get("pad_token_id", 0))


def make_backend(settings: Settings):
    """Pick a backend honouring settings.backend ('auto' tries tensorrt, torch-fp16, torch-mps, torch-cpu)."""
    want = settings.backend
    errors: list[str] = []
    if want in ("auto", "tensorrt") and settings.plan_path.exists():
        try:
            return TrtBackend(settings.plan_path)
        except Exception as e:  # noqa: BLE001
            errors.append(f"tensorrt: {e}")
            log.warning("TensorRT unavailable: %s", e)
    if want in ("auto", "tensorrt", "torch-fp16"):
        try:
            import torch

            if torch.cuda.is_available():
                return TorchBackend(settings.model_dir, "cuda", True)
        except Exception as e:  # noqa: BLE001
            errors.append(f"torch-fp16: {e}")
            log.warning("torch CUDA unavailable: %s", e)
    if want in ("auto", "torch-mps"):
        try:
            import torch

            if torch.backends.mps.is_available():
                # fp16 on MPS can diverge for wav2vec2, so fp32 unless PHONES_MPS_FP16=1.
                return TorchBackend(settings.model_dir, "mps", os.environ.get("PHONES_MPS_FP16") == "1")
            errors.append("torch-mps: MPS not available")
        except Exception as e:  # noqa: BLE001
            errors.append(f"torch-mps: {e}")
            log.warning("torch MPS unavailable: %s", e)
    if want in ("tensorrt", "torch-fp16", "torch-mps"):
        raise RuntimeError("requested backend unavailable: " + "; ".join(errors))
    return TorchBackend(settings.model_dir, "cpu", False)


def load_recognizer(settings: Settings | None = None) -> Recognizer:
    settings = settings or Settings()
    id2tok, blank = load_vocab(settings.model_dir)
    backend = make_backend(settings)
    log.info("loaded %s on %s (%s)", settings.model_id, backend.device, backend.name)
    return Recognizer(settings.model_id, backend, id2tok, blank)
