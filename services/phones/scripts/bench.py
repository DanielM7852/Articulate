"""Latency bench: torch FP16 (CUDA) vs TensorRT FP16 for 0.5/1/2/4 s windows (median / p95 over 50 runs after warmup)."""
from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np  # noqa: E402

from phones.config import Settings  # noqa: E402
from phones.engine import TorchBackend, TrtBackend  # noqa: E402

s = Settings()
backends = {"torch-fp16": TorchBackend(s.model_dir, "cuda", True)}
if s.plan_path.exists():
    backends["tensorrt-fp16"] = TrtBackend(s.plan_path)
rng = np.random.default_rng(0)
print(f"model={s.model_id}")
print(f"{'backend':14s} {'window':>7s} {'median ms':>10s} {'p95 ms':>8s}")
for name, b in backends.items():
    for sec in (0.5, 1, 2, 4):
        x = (rng.standard_normal(int(16000 * sec)) * 0.1).astype(np.float32)
        for _ in range(10):
            b(x)
        ts = []
        for _ in range(50):
            t0 = time.perf_counter()
            b(x)
            ts.append((time.perf_counter() - t0) * 1000)
        ts.sort()
        print(f"{name:14s} {sec:6.1f}s {statistics.median(ts):10.2f} {ts[int(0.95 * len(ts)) - 1]:8.2f}")
