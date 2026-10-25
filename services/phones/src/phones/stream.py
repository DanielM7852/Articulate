"""Per-connection streaming state: 16 kHz ring buffer, hop scheduling, windowed inference, commit logic."""
from __future__ import annotations

import time
from typing import Callable

import numpy as np

from .config import Settings
from .ctc import Phone, rms, split_commit


class StreamSession:
    def __init__(self, settings: Settings):
        self.s = settings
        self.sr = settings.sample_rate
        self.max_samples = int(self.sr * settings.window_ms / 1000)
        self.reset()

    def reset(self) -> None:
        self.buf = np.zeros(0, dtype=np.float32)
        self.total = 0  # samples received since connect/reset = stream clock
        self.next_infer_at = int(self.sr * self.s.min_window_ms / 1000)
        self.last_committed_end = -1.0
        self.last_phone = None
        self.seq = 0

    @property
    def stream_ms(self) -> float:
        return self.total * 1000.0 / self.sr

    def push_pcm16(self, data: bytes) -> None:
        n = len(data) // 2
        if n == 0:
            return
        x = np.frombuffer(data[: n * 2], dtype="<i2").astype(np.float32) / 32768.0
        self.total += n
        self.buf = np.concatenate([self.buf, x])[-self.max_samples :]

    def due(self) -> bool:
        return self.total >= self.next_infer_at

    def window(self) -> tuple[np.ndarray, float, float]:
        end_ms = self.stream_ms
        return self.buf, end_ms - len(self.buf) * 1000.0 / self.sr, end_ms

    def finish(self, phones: list[Phone], end_ms: float, infer_ms: float) -> dict:
        """Apply commit logic to a window's phones and build the 'phones' message."""
        committed, provisional, self.last_committed_end = split_commit(
            phones, end_ms, self.s.commit_lag_ms, self.last_committed_end, self.last_phone
        )
        if committed:
            self.last_phone = committed[-1]
        self.seq += 1
        return {
            "type": "phones",
            "seq": self.seq,
            "windowEndMs": round(end_ms, 1),
            "committed": [p.as_dict() for p in committed],
            "provisional": [p.as_dict() for p in provisional],
            "inferMs": round(infer_ms, 2),
        }

    def step(self, recognize: Callable[[np.ndarray, float], list[Phone]]) -> dict | None:
        """Synchronous variant: run one window if due. recognize(wave, window_start_ms) -> phones in stream time."""
        if not self.due():
            return None
        self.next_infer_at = self.total + int(self.sr * self.s.hop_ms / 1000)
        wave, start_ms, end_ms = self.window()
        if rms(wave) < self.s.silence_rms:
            return self.finish([], end_ms, 0.0)
        t0 = time.perf_counter()
        phones = recognize(wave, start_ms)
        return self.finish(phones, end_ms, (time.perf_counter() - t0) * 1000.0)
