import math
from uuid import UUID

import numpy as np
import parselmouth

from .schemas import TARGETS, AttemptSummary, FeatureFrame


class AcousticAdapter:
    """Called in an executor, never on the event WebSocket loop. Raw features stay unsmoothed."""

    def __init__(self, rate: int, ceiling: float):
        self.rate = rate
        self.ceiling = ceiling
        self.buffer = np.empty(0)
        self.previous = None

    def analyze(self, pcm: bytes, offset: int) -> FeatureFrame:
        samples = np.frombuffer(pcm, dtype="<i2").astype(float) / 32768
        self.buffer = np.concatenate((self.buffer, samples))[-int(self.rate * 0.12) :]
        flags = []
        if len(self.buffer) < self.rate * 0.06:
            flags.append("warming_up")
        if np.sqrt(np.mean(samples**2)) < 0.008:
            flags.append("silence")
        if np.mean(np.abs(samples) >= 0.99) > 0.01:
            flags.append("clipping")
        f1 = f2 = f0 = None
        if not flags:
            try:
                sound = parselmouth.Sound(self.buffer, sampling_frequency=self.rate)
                formants = sound.to_formant_burg(
                    time_step=0.01,
                    max_number_of_formants=5,
                    maximum_formant=self.ceiling,
                    window_length=0.025,
                    pre_emphasis_from=50,
                )
                t = sound.duration - 0.03
                a, b = (formants.get_value_at_time(i, t) for i in (1, 2))
                pitch = sound.to_pitch_ac(time_step=0.01, pitch_floor=75, pitch_ceiling=600)
                hz = pitch.get_value_at_time(t)
                if not math.isfinite(hz) or hz <= 0:
                    flags.append("unvoiced")
                elif not (math.isfinite(a) and math.isfinite(b) and 150 <= a <= 1300 and a + 150 < b <= 4000):
                    flags.append("implausible_formants")
                elif self.previous and (abs(a - self.previous[0]) > 450 or abs(b - self.previous[1]) > 900):
                    flags.append("abrupt_track_change")
                    self.previous = (a, b)  # permit recovery at the new position next frame
                else:
                    f1, f2, f0 = a, b, hz
                    self.previous = (a, b)
            except parselmouth.PraatError:
                flags.append("analysis_unavailable")
        return FeatureFrame(
            sample_offset=offset,
            timestamp_ms=offset / self.rate * 1000,
            duration_ms=len(samples) / self.rate * 1000,
            f1=f1,
            f2=f2,
            f0=f0,
            valid=not flags,
            quality_flags=flags,
            source="microphone",
        )


def summarize(
    attempt_id: UUID,
    target_id: str,
    frames: list[FeatureFrame],
    rate: int,
    end: int,
    source: str,
    assistance_level="guided",
):
    valid = [f for f in frames if f.valid]
    duration = sum(f.duration_ms for f in valid)
    total = end / rate * 1000
    flags = sorted({flag for f in frames for flag in f.quality_flags})
    usable = duration >= 300 and total > 0 and duration / total >= 0.3
    if not usable:
        flags.append("insufficient_usable_speech")
    a = float(np.mean([f.f1 for f in valid])) if valid else None
    b = float(np.mean([f.f2 for f in valid])) if valid else None
    target = TARGETS[target_id]
    distance = (
        math.hypot((a - target.f1) / target.radius_f1, (b - target.f2) / target.radius_f2) if a else None
    )
    fields = ["usable_duration_ms", "usable_fraction"]
    if usable:
        fields += ["f1_mean", "f2_mean", "target_distance"]
    return AttemptSummary(
        attempt_id=attempt_id,
        target_id=target_id,
        capture_start_sample=0,
        capture_end_sample=end,
        sample_rate=rate,
        usable_duration_ms=duration,
        usable_fraction=min(1, duration / total) if total else 0,
        f1_mean=a,
        f2_mean=b,
        target_distance=distance,
        quality_flags=flags,
        evidence_fields=fields,
        source=source,
        assistance_level=assistance_level,
    )


def synthetic_frame(target_id: str, index: int):
    """Deterministic synthetic features, never inferred from the diagnostic tone."""
    target = TARGETS[target_id]
    return FeatureFrame(
        sample_offset=index * 960,
        timestamp_ms=index * 40,
        duration_ms=40,
        f1=target.f1 + 65 * math.sin(index / 8),
        f2=target.f2 + 140 * math.cos(index / 9),
        valid=True,
        source="synthetic",
    )
