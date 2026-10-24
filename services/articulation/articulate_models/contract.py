"""Finite, self-describing time series. Preserve native frame counts; never stretch timelines."""

import numpy as np

SCHEMA_VERSION = "articulate.articulation/1"
MODEL_NAMES = ("sparc", "arti6", "silero_vad")


def series(
    values,
    channels: list[str],
    units: str,
    hop_samples: int,
    offset_samples: float,
    sample_count: int,
    *,
    interpretation: str,
) -> dict:
    array = np.asarray(values, dtype=np.float64)
    if array.ndim == 1:
        array = array[:, None]
    if array.ndim != 2 or array.shape[1] != len(channels) or not len(array):
        raise ValueError("Model returned an unexpected time-series shape")
    if not np.isfinite(array).all():
        raise ValueError("Model returned nonfinite feature values")
    positions = offset_samples + np.arange(len(array), dtype=np.float64) * hop_samples
    valid = (positions >= 0) & (positions < sample_count)
    summaries = {}
    for index, channel in enumerate(channels):
        data = array[valid, index]
        summaries[channel] = (
            None
            if not len(data)
            else {
                "count": len(data),
                "mean": float(data.mean()),
                "std": float(data.std()),
                "min": float(data.min()),
                "max": float(data.max()),
                "median": float(np.median(data)),
                "p10": float(np.quantile(data, 0.1)),
                "p90": float(np.quantile(data, 0.9)),
            }
        )
    return {
        "channels": channels,
        "units": units,
        "interpretation": interpretation,
        "sampleRate": 16000,
        "hopSamples": hop_samples,
        "offsetSamples": offset_samples,
        "timestampsMs": (positions / 16).tolist(),
        "values": array.tolist(),
        "withinAudio": valid.tolist(),
        "summary": summaries,
    }


def unavailable(name: str, code: str, message: str, *, status="unavailable", provenance=None) -> dict:
    return {
        "model": name,
        "status": status,
        "error": {"code": code, "message": message},
        "provenance": provenance or {},
        "series": {},
        "segments": [],
        "timingsMs": {},
    }
