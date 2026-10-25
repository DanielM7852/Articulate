"""Build a TensorRT FP16 engine from the exported ONNX (profile min 8000 / opt 32000 / max 64000 samples).

Usage: build_engine.py [--fp32-layers REGEX]   keep layers whose name matches REGEX in FP32 (e.g. 'layer_norm|LayerNorm|Softmax')
Then verifies TRT vs PyTorch fp32 argmax agreement on synthetic + any WAV fixtures found in the repo."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np  # noqa: E402
import tensorrt as trt  # noqa: E402

from phones.config import Settings  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--fp32-layers", default=None)
ap.add_argument("--no-verify", action="store_true")
args = ap.parse_args()
s = Settings()

logger = trt.Logger(trt.Logger.WARNING)
builder = trt.Builder(logger)
net = builder.create_network(0)
parser = trt.OnnxParser(net, logger)
if not parser.parse(s.onnx_path.read_bytes(), str(s.onnx_path)):
    for i in range(parser.num_errors):
        print(parser.get_error(i))
    sys.exit(1)

cfg = builder.create_builder_config()
cfg.set_flag(trt.BuilderFlag.FP16)
cfg.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 4 << 30)
prof = builder.create_optimization_profile()
prof.set_shape(net.get_input(0).name, (1, 8000), (1, 32000), (1, 64000))
cfg.add_optimization_profile(prof)

if args.fp32_layers:
    cfg.set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
    rx = re.compile(args.fp32_layers, re.I)
    n = 0
    for i in range(net.num_layers):
        L = net.get_layer(i)
        if rx.search(L.name) or L.type in (trt.LayerType.NORMALIZATION, trt.LayerType.SOFTMAX):
            L.precision = trt.float32
            for j in range(L.num_outputs):
                L.set_output_type(j, trt.float32)
            n += 1
    print("pinned", n, "layers to FP32")

print("building engine (several minutes)...")
plan = builder.build_serialized_network(net, cfg)
if plan is None:
    sys.exit("engine build failed")
s.engines_dir.mkdir(parents=True, exist_ok=True)
s.plan_path.write_bytes(bytes(plan))
print("wrote", s.plan_path, s.plan_path.stat().st_size // 2**20, "MB")

if args.no_verify:
    sys.exit(0)

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from transformers import Wav2Vec2ForCTC  # noqa: E402

from phones.ctc import normalize  # noqa: E402
from phones.engine import TrtBackend  # noqa: E402

trtb = TrtBackend(s.plan_path)
ref_model = Wav2Vec2ForCTC.from_pretrained(s.model_dir).float().cuda().eval()


def clips():
    rng = np.random.default_rng(0)
    t = np.arange(32000) / 16000
    yield "noise-2s", (rng.standard_normal(32000) * 0.1).astype(np.float32)
    yield "chirp-2s", (0.3 * np.sin(2 * np.pi * (200 + 600 * t) * t)).astype(np.float32)
    repo = Path(__file__).resolve().parents[3]
    for p in sorted(repo.glob("**/*.wav"))[:12]:
        if "node_modules" in p.parts or ".venv" in p.parts:
            continue
        x, sr = sf.read(p, dtype="float32", always_2d=True)
        x = x.mean(1)
        if sr != 16000:
            from math import gcd
            from scipy.signal import resample_poly

            g = gcd(sr, 16000)
            x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
        yield p.name, x[:64000]


tot_eq = tot_n = 0
worst = 0.0
for name, x in clips():
    if len(x) < 8000:
        continue
    xn = normalize(x)
    with torch.inference_mode():
        ref = ref_model(torch.from_numpy(xn)[None].cuda()).logits[0].float().cpu().numpy()
    out = trtb(xn)
    d = float(np.abs(ref - out).max())
    eq = int((ref.argmax(-1) == out.argmax(-1)).sum())
    tot_eq += eq
    tot_n += len(ref)
    worst = max(worst, d)
    print(f"{name:28s} frames={len(ref):4d} agree={100 * eq / len(ref):6.2f}% maxabs={d:.3f}")
print(f"OVERALL argmax agreement {100 * tot_eq / tot_n:.2f}%  worst maxabs {worst:.3f}")
