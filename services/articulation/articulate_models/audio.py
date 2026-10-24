"""Bounded WAV decoding and loss-aware input metadata. No input normalization here."""

import hashlib
import io
import math
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SAMPLE_RATE = 16000
MAX_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 30


class AudioError(ValueError):
    pass


@dataclass
class AudioInput:
    samples: np.ndarray
    metadata: dict
    quality_flags: list[str]


def decode_wav(data: bytes) -> AudioInput:
    if not data or len(data) > MAX_BYTES:
        raise AudioError("WAV must contain between 1 byte and 8 MiB")
    try:
        with sf.SoundFile(io.BytesIO(data)) as file:
            if file.format not in {"WAV", "WAVEX"}:
                raise AudioError("Input must be a WAV file")
            if not 8000 <= file.samplerate <= 96000 or file.channels not in (1, 2):
                raise AudioError("Use 8–96 kHz mono or stereo WAV")
            if not 0 < file.frames <= file.samplerate * MAX_SECONDS:
                raise AudioError("WAV duration must be greater than zero and at most 30 seconds")
            original_sr, channels, subtype = file.samplerate, file.channels, file.subtype
            original = file.read(dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError) as exc:
        raise AudioError("Cannot decode WAV") from exc
    if not np.isfinite(original).all() or np.max(np.abs(original)) > 1.00001:
        raise AudioError("WAV samples must be finite and within [-1, 1]")
    # Capture clipping before mixing/resampling; cancellation must not hide a clipped channel.
    clipped = float(np.mean(np.abs(original) >= 0.999))
    mono = original.mean(axis=1, dtype=np.float64)
    if original_sr != SAMPLE_RATE:
        divisor = math.gcd(original_sr, SAMPLE_RATE)
        mono = resample_poly(mono, SAMPLE_RATE // divisor, original_sr // divisor)
    samples = np.ascontiguousarray(mono, dtype=np.float32)
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    flags = []
    if rms < 1e-4:
        flags.append("insufficient_signal")
    if float(samples.std()) < 1e-6:
        flags.append("constant_signal")
    if len(samples) < SAMPLE_RATE / 2:
        flags.append("short_audio")
    if clipped > 0.01:
        flags.append("clipping")
    if abs(float(samples.mean())) > 0.05:
        flags.append("dc_offset")
    if channels == 2 and float(np.max(np.abs(original))) > 0.01 and rms < 1e-4:
        flags.append("stereo_cancellation")
    return AudioInput(
        samples,
        {
            "sha256": hashlib.sha256(data).hexdigest(),
            "originalSampleRate": original_sr,
            "originalChannels": channels,
            "originalSubtype": subtype,
            "originalSampleCount": len(original),
            "sampleRate": SAMPLE_RATE,
            "sampleCount": len(samples),
            "durationMs": len(samples) / 16,
            "originalDurationMs": len(original) / original_sr * 1000,
            "preprocessing": "channel_mean_then_polyphase_resample; model-specific normalization recorded separately",
            "rms": rms,
            "peakAbsolute": float(np.max(np.abs(samples))),
            "clippedFraction": clipped,
        },
        flags,
    )
