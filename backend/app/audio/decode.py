"""Decode uploaded audio without trusting the declared sample rate."""

import io
import wave

import numpy as np

from app.config import Settings
from app.errors import AudioRejected

_WAV_WIDTHS = {1: "uint8", 2: "<i2", 4: "<i4"}


def decode_audio(data: bytes, filename: str, settings: Settings) -> tuple[np.ndarray, int, bool]:
    """Return mono float64 samples, the file's sample rate, and whether channels were mixed."""

    if not data:
        raise AudioRejected("empty_audio", "The upload was empty.")
    if len(data) > settings.max_upload_bytes:
        raise AudioRejected(
            "upload_too_large",
            f"Uploads are limited to {settings.max_upload_bytes} bytes.",
        )
    samples, sample_rate = _decode_any(data, filename)
    downmixed = False
    array = np.asarray(samples, dtype=np.float64)
    if array.ndim == 2:
        if array.shape[1] > 1:
            array = array.mean(axis=1)
            downmixed = True
        else:
            array = array[:, 0]
    elif array.ndim != 1:
        raise AudioRejected("undecodable_audio", "The audio array shape is not supported.")
    if array.size == 0 or sample_rate <= 0:
        raise AudioRejected("undecodable_audio", "The audio file had no samples.")
    duration_s = array.size / float(sample_rate)
    if duration_s < settings.min_duration_s or duration_s > settings.max_duration_s:
        raise AudioRejected(
            "duration_out_of_range",
            "The recording duration is outside the short-phrase limit.",
        )
    if sample_rate < settings.min_sample_rate_hz or sample_rate > settings.max_sample_rate_hz:
        raise AudioRejected(
            "sample_rate_out_of_range",
            "The file sample rate is outside the supported range.",
        )
    return np.ascontiguousarray(array), int(sample_rate), downmixed


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    clipped = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _decode_any(data: bytes, filename: str) -> tuple[np.ndarray, int]:
    lowered = filename.lower()
    errors: list[str] = []
    if lowered.endswith(".wav") or data[:4] == b"RIFF":
        try:
            return _decode_wav(data)
        except AudioRejected:
            raise
        except Exception as exc:  # noqa: BLE001 - fall through to soundfile
            errors.append(f"wave:{type(exc).__name__}")
    try:
        return _decode_soundfile(data)
    except AudioRejected:
        raise
    except Exception as exc:  # noqa: BLE001 - reported as one client-facing code
        errors.append(f"soundfile:{type(exc).__name__}")
    raise AudioRejected("undecodable_audio", "The upload could not be decoded as audio.")


def _decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            sample_rate = handle.getframerate()
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            frames = handle.readframes(handle.getnframes())
    except wave.Error as exc:
        raise AudioRejected("undecodable_audio", "The WAV file could not be read.") from exc
    dtype = _WAV_WIDTHS.get(width)
    if dtype is None or channels < 1:
        raise AudioRejected("unsupported_wav", "Only 8-bit, 16-bit, and 32-bit PCM WAV files are supported.")
    raw = np.frombuffer(frames, dtype=dtype)
    if raw.size % channels != 0:
        raise AudioRejected("undecodable_audio", "The WAV frame count does not match its channels.")
    shaped = raw.reshape(-1, channels).astype(np.float64)
    if width == 1:
        shaped = (shaped - 128.0) / 128.0
    elif width == 2:
        shaped = shaped / 32768.0
    else:
        shaped = shaped / 2147483648.0
    return shaped, sample_rate


def _decode_soundfile(data: bytes) -> tuple[np.ndarray, int]:
    try:
        import soundfile as sf
    except ImportError as exc:
        raise AudioRejected(
            "undecodable_audio",
            "This format needs the soundfile decoder, which is not installed.",
        ) from exc
    try:
        samples, sample_rate = sf.read(io.BytesIO(data), always_2d=True, dtype="float64")
    except Exception as exc:  # noqa: BLE001 - decoder failures are client input
        raise AudioRejected("undecodable_audio", "The upload could not be decoded as audio.") from exc
    return samples, int(sample_rate)
