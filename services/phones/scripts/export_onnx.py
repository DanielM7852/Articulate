"""Export Wav2Vec2ForCTC -> ONNX (legacy tracer, opset 17, dynamic sample axis) and verify against PyTorch."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import Wav2Vec2ForCTC  # noqa: E402

from phones.config import Settings  # noqa: E402

s = Settings()
model = Wav2Vec2ForCTC.from_pretrained(s.model_dir, attn_implementation="eager").float().eval()
print("config: feat_extract_norm=%s vocab=%d pad=%s" % (model.config.feat_extract_norm, model.config.vocab_size, model.config.pad_token_id))


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        return self.m(x).logits


g = torch.Generator().manual_seed(0)
dummy = torch.randn(1, 32000, generator=g)
torch.onnx.export(
    Wrap(model).eval(), (dummy,), str(s.onnx_path),
    input_names=["input"], output_names=["logits"],
    dynamic_axes={"input": {1: "samples"}, "logits": {1: "frames"}},
    opset_version=17, dynamo=False, do_constant_folding=True,
)
print("wrote", s.onnx_path, s.onnx_path.stat().st_size // 2**20, "MB")

import onnxruntime as ort  # noqa: E402

sess = ort.InferenceSession(str(s.onnx_path), providers=["CPUExecutionProvider"])
for n in (16000, 32000, 50000):
    x = torch.randn(1, n, generator=g)
    with torch.inference_mode():
        ref = model(x).logits.numpy()
    out = sess.run(None, {"input": x.numpy()})[0]
    print(f"samples={n} frames={out.shape[1]} maxabs={np.abs(ref - out).max():.2e} "
          f"argmax_agree={(ref.argmax(-1) == out.argmax(-1)).mean() * 100:.2f}%")
