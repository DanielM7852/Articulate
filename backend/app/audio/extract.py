"""File-based F0 extraction and usable-frame selection.

librosa.pyin (pYIN) is the development extractor. It estimates fundamental
frequency and a voicing probability. Those values are not pronunciation scores.

Praat's current preference for intonation is filtered autocorrelation. pYIN is a
different estimator and can still lock onto the wrong octave. Suspected octave
frames are removed from comparison rather than silently rewritten.

Invalid frames keep their timestamps and are published with null F0 so callers
cannot treat them as measurements.
"""

import time
from dataclasses import dataclass

import numpy as np

from app import telemetry
from app.config import Settings
from app.schemas import PitchContour, PitchFrame


@dataclass(frozen=True)
class CaptureFacts:
    rms: float
    clipping_fraction: float
    downmixed_to_mono: bool
    suspected_octave_error: bool
    implausible_pitch_jump: bool
    f0_out_of_range: bool
    excessive_silence: bool


def frame_settings(sample_rate: int) -> tuple[int, int]:
    """Return frame length and hop for the file's own sample rate."""

    if sample_rate >= 32_000:
        return 2048, 512
    return 1024, 256


def rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples))))


def clipping_fraction(samples: np.ndarray, level: float) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.mean(np.abs(samples) >= level))


def frames_from_f0_track(
    times_s: np.ndarray,
    f0_hz: np.ndarray,
    voiced: np.ndarray,
    voicing_probability: np.ndarray,
    settings: Settings,
) -> tuple[list[PitchFrame], float | None]:
    """Select usable frames and normalize them to their own median F0."""

    times = np.asarray(times_s, dtype=np.float64)
    f0 = np.asarray(f0_hz, dtype=np.float64)
    voiced_flag = np.asarray(voiced, dtype=bool)
    probability = np.asarray(voicing_probability, dtype=np.float64)
    finite = np.isfinite(f0) & (f0 > 0)
    candidate = voiced_flag & finite & np.isfinite(probability) & (
        probability >= settings.voicing_probability_min
    )
    usable = candidate.copy()
    reasons: list[str | None] = [None] * len(f0)

    for index in np.flatnonzero(candidate):
        if f0[index] < settings.f0_min_hz or f0[index] > settings.f0_max_hz:
            usable[index] = False
            reasons[index] = "f0_out_of_range"

    reliable = np.flatnonzero(usable)
    if reliable.size >= 3:
        body = float(np.median(f0[reliable]))
        semitones = 12.0 * np.log2(f0[reliable] / body)
        for index, delta in zip(reliable, semitones, strict=True):
            nearest_octave = 12.0 * round(float(delta) / 12.0)
            if abs(nearest_octave) >= 12.0 and abs(float(delta) - nearest_octave) <= settings.octave_tolerance_st:
                usable[index] = False
                reasons[index] = "suspected_octave_error"
        accepted = np.flatnonzero(usable)
        for earlier, later in zip(accepted[:-1], accepted[1:], strict=False):
            gap_s = float(times[later] - times[earlier])
            if gap_s > settings.jump_max_gap_s:
                continue
            jump = abs(12.0 * np.log2(f0[later] / f0[earlier]))
            if jump > settings.jump_threshold_st:
                usable[later] = False
                reasons[later] = "implausible_pitch_jump"

    accepted = np.flatnonzero(usable)
    median_f0 = float(np.median(f0[accepted])) if accepted.size else None
    frames: list[PitchFrame] = []
    for index in range(len(f0)):
        probability_value = float(probability[index]) if np.isfinite(probability[index]) else None
        relative = None
        published_f0 = None
        if usable[index] and median_f0:
            relative = round(float(12.0 * np.log2(f0[index] / median_f0)), 5)
            published_f0 = round(float(f0[index]), 5)
        frames.append(
            PitchFrame(
                time_s=round(float(times[index]), 5),
                f0_hz=published_f0,
                voiced=bool(voiced_flag[index]),
                voicing_probability=None if probability_value is None else round(probability_value, 5),
                relative_pitch_st=relative,
                usable=bool(usable[index]),
                rejected_reason=reasons[index],
            )
        )
    return frames, None if median_f0 is None else round(median_f0, 5)


def _emit_pitch_result(f0: np.ndarray, elapsed_s: float) -> None:
    try:
        voiced = f0[np.isfinite(f0)]
        payload = {
            "f0Mean": round(float(voiced.mean()), 1) if voiced.size else None,
            "f0Min": round(float(voiced.min()), 1) if voiced.size else None,
            "f0Max": round(float(voiced.max()), 1) if voiced.size else None,
            "voicedPct": round(100.0 * voiced.size / f0.size, 1) if f0.size else 0.0,
            "latencyMs": round(elapsed_s * 1000),
        }
        telemetry.emit("pitch", "backend", "pitch.result", "pitch extracted", payload)
    except Exception:  # noqa: BLE001
        pass


def extract_pitch(samples: np.ndarray, sample_rate: int, settings: Settings) -> PitchContour:
    """Estimate F0 with librosa.pyin and drop frames that fail the usable-frame checks."""

    import librosa

    frame_length, hop_length = frame_settings(sample_rate)
    seconds = round(len(samples) / float(sample_rate), 2) if sample_rate else None
    telemetry.emit("backend", "pitch", "pitch.extract", "extract pitch", {"seconds": seconds})
    started = time.perf_counter()
    f0, voiced_flag, voiced_probability = librosa.pyin(
        np.asarray(samples, dtype=np.float64),
        fmin=settings.f0_min_hz,
        fmax=min(settings.f0_max_hz, (sample_rate / 2.0) - 1.0),
        sr=sample_rate,
        frame_length=frame_length,
        hop_length=hop_length,
        fill_na=np.nan,
        center=True,
    )
    _emit_pitch_result(np.asarray(f0, dtype=np.float64), time.perf_counter() - started)
    times = librosa.times_like(np.asarray(f0), sr=sample_rate, hop_length=hop_length)
    frames, median_f0 = frames_from_f0_track(
        times,
        np.asarray(f0),
        np.asarray(voiced_flag, dtype=bool),
        np.asarray(voiced_probability, dtype=np.float64),
        settings,
    )
    return PitchContour(
        sample_rate_hz=sample_rate,
        hop_length=hop_length,
        frame_length=frame_length,
        analysis_version=settings.analysis_version,
        median_reliable_f0_hz=median_f0,
        frames=frames,
    )


def capture_facts(
    samples: np.ndarray,
    contour: PitchContour,
    settings: Settings,
    *,
    downmixed_to_mono: bool,
) -> CaptureFacts:
    level = clipping_fraction(samples, settings.clipping_sample_level)
    energy = rms(samples)
    reasons = {frame.rejected_reason for frame in contour.frames}
    return CaptureFacts(
        rms=energy,
        clipping_fraction=level,
        downmixed_to_mono=downmixed_to_mono,
        suspected_octave_error="suspected_octave_error" in reasons,
        implausible_pitch_jump="implausible_pitch_jump" in reasons,
        f0_out_of_range="f0_out_of_range" in reasons,
        excessive_silence=energy < settings.silence_rms_limit or not any(frame.usable for frame in contour.frames),
    )
