"""Inference backends: TensorRT FP16 -> torch FP16 (CUDA) -> torch CPU, chosen automatically."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

from .config import Settings
from .ctc import Phone, greedy_decode, normalize

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
        self.name = "torch-fp16" if fp16 else "torch-cpu"

    def __call__(self, wave: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.inference_mode():
            x = torch.from_numpy(wave)[None].to(self.device, self.dtype)
            out = self.model(x).logits[0].float()
            if self.device == "cuda":
                torch.cuda.synchronize()
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

    def logits(self, wave: np.ndarray) -> np.ndarray:
        return self.backend(normalize(wave))

    def phones(self, wave: np.ndarray, offset_ms: float = 0.0) -> list[Phone]:
        return greedy_decode(self.logits(wave), self.id2tok, self.blank_id, self.frame_ms, offset_ms)


def load_vocab(model_dir: Path) -> tuple[dict[int, str], int]:
    vocab = json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    return {int(v): k for k, v in vocab.items()}, int(cfg.get("pad_token_id", 0))


def make_backend(settings: Settings):
    """Pick a backend honouring settings.backend ('auto' tries tensorrt, torch-fp16, torch-cpu)."""
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
    if want == "tensorrt" or want == "torch-fp16":
        raise RuntimeError("requested backend unavailable: " + "; ".join(errors))
    return TorchBackend(settings.model_dir, "cpu", False)


def load_recognizer(settings: Settings | None = None) -> Recognizer:
    settings = settings or Settings()
    id2tok, blank = load_vocab(settings.model_dir)
    backend = make_backend(settings)
    log.info("loaded %s on %s (%s)", settings.model_id, backend.device, backend.name)
    return Recognizer(settings.model_id, backend, id2tok, blank)
