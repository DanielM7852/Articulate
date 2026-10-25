"""Praat measurements of one word attempt's WAV, per board zone, as evidence for the word coach.

Pitch, formant and settings follow backend/app/audio/pitch_table.py on branch origin/feature/teacher-dashboard
(to_pitch_ac 10 ms floor 75 ceiling 500; to_formant_burg 5 formants, 5500 Hz at >= 11025 Hz, window 0.025,
pre-emphasis from 50; F1 150-1300, F2 above F1 + 150 and at most 4000). Its cue logic is deliberately not used:
comparing against another speaker's reference is biased by vocal-tract size, and these numbers never say where
the tongue is. They only help the coach choose which zone's body instruction to give.

The clip starts roughly 250 ms before the board's attempt start and the alignment is approximate, so zone
windows are placed from the voice onset detected in the clip, not from a fixed offset.
"""

import io
import logging
import math
import wave
from typing import Any

import numpy as np

from app.audio.extract import f0_summary
from app.live.schemas import WordZoneResult

logger = logging.getLogger(__name__)

STEP_S = 0.01
MIN_WINDOW_MS = 30
CLEAR_VOICED_MS = 120
INTENSITY_BELOW_MAX_DB = 25
MIN_PEAK = 0.003  # below about -50 dBFS the clip counts as silence
LOW_BAND_HZ = 500


def _read_pcm16(wav: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(wav), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        if handle.getsampwidth() != 2:
            raise ValueError("pcm16")
        raw = handle.readframes(handle.getnframes())
    samples = np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        samples = samples[: samples.size // channels * channels].reshape(-1, channels).mean(axis=1)
    return samples, rate


def _median(values: list[float]) -> float | None:
    return float(np.median(values)) if values else None


def _hz(value: float | None) -> int | None:
    return None if value is None or not math.isfinite(value) else int(round(value))


def _frac(value: float | None) -> float | None:
    return None if value is None or not math.isfinite(value) else round(float(value), 2)


def _formants_at(formant: Any, t: float) -> tuple[float | None, float | None, float | None]:
    def get(n: int) -> float | None:
        v = formant.get_value_at_time(n, t)
        return float(v) if v is not None and math.isfinite(v) and v > 0 else None

    f1, f2, f3 = get(1), get(2), get(3)
    if f1 is not None and not 150 <= f1 <= 1300:
        f1 = None
    if f2 is not None and not ((f1 or 0) + 150 < f2 <= 4000):
        f2 = None
    if f3 is not None and not (f2 is not None and f2 < f3 <= 5000):
        f3 = None
    return f1, f2, f3


def wav_seconds(wav: bytes) -> float | None:
    """Clip length from the WAV header, or None when it cannot be read. Never raises."""
    try:
        with wave.open(io.BytesIO(wav), "rb") as handle:
            rate = handle.getframerate()
            return round(handle.getnframes() / rate, 2) if rate else None
    except Exception:  # noqa: BLE001
        return None


def measure_word(
    wav: bytes, zones: list[WordZoneResult], pitch_out: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Acoustics block for the word coach, or None on any failure or a non-PCM16 WAV. Never raises.

    When `pitch_out` is given and the Praat pitch pass ran, it is filled with f0_summary() of that pass
    (f0Mean, f0Min, f0Max, voicedPct) plus median f1Hz/f2Hz over the vowel and tuner zones when they were
    measured. It is for telemetry only and never part of the returned block.
    """
    try:
        return _measure(wav, zones, pitch_out)
    except Exception as exc:  # noqa: BLE001 - evidence is optional
        logger.debug("word acoustics skipped: %s", type(exc).__name__)
        return None


def _measure(wav: bytes, zones: list[WordZoneResult], pitch_out: dict[str, Any] | None = None) -> dict[str, Any] | None:
    import parselmouth

    samples, rate = _read_pcm16(wav)
    if samples.size == 0 or rate < 4000:
        return None
    clip_ms = int(round(samples.size / rate * 1000))
    out: dict[str, Any] = {
        "source": "praat",
        "speech": {"clear": False, "voicedMs": 0, "onsetMs": None, "clipMs": clip_ms},
        "zones": {},
    }
    if samples.size < int(rate * 0.1) or float(np.max(np.abs(samples))) < MIN_PEAK:
        return out

    sound = parselmouth.Sound(samples, sampling_frequency=rate)
    pitch = sound.to_pitch_ac(time_step=STEP_S, pitch_floor=75, pitch_ceiling=500)
    p_times = np.asarray(pitch.xs())
    p_freq = np.asarray(pitch.selected_array["frequency"])
    voiced = p_freq > 0
    voiced_ms = int(round(int(voiced.sum()) * STEP_S * 1000))
    if pitch_out is not None:
        pitch_out.update(f0_summary(p_freq))

    intensity = sound.to_intensity(minimum_pitch=200, time_step=STEP_S)
    i_times = np.asarray(intensity.xs())
    i_values = np.asarray(intensity.values[0])
    candidates: list[float] = []
    if voiced.any():
        candidates.append(float(p_times[voiced][0]))
    finite = np.isfinite(i_values)
    if finite.any():
        loud = np.flatnonzero(finite & (i_values >= np.max(i_values[finite]) - INTENSITY_BELOW_MAX_DB))
        if loud.size:
            candidates.append(float(i_times[loud[0]]))
    onset_s = min(candidates) if candidates else None
    onset_ms = None if onset_s is None else int(round(onset_s * 1000))
    out["speech"] = {
        "clear": onset_ms is not None and voiced_ms >= CLEAR_VOICED_MS,
        "voicedMs": voiced_ms,
        "onsetMs": onset_ms,
        "clipMs": clip_ms,
    }
    if onset_ms is None or not zones:
        return out

    formant = sound.to_formant_burg(
        time_step=STEP_S,
        max_number_of_formants=5,
        maximum_formant=5500 if rate >= 11025 else 5000,
        window_length=0.025,
        pre_emphasis_from=50,
    )

    windows: dict[str, tuple[float, float]] = {}
    for z in zones:
        if z.startMs is None or z.endMs is None or z.kind == "stop":
            continue
        start = onset_ms + z.startMs
        end = min(onset_ms + z.endMs, float(clip_ms))
        if start < 0 or start >= clip_ms or end - start < MIN_WINDOW_MS:
            continue
        windows[z.zoneId] = (start / 1000.0, end / 1000.0)

    def frames(a: float, b: float) -> tuple[np.ndarray, int]:
        """Voiced frame times in the window and the total frame count."""
        sel = (p_times >= a) & (p_times <= b)
        return p_times[sel & voiced], int(sel.sum())

    def formant_lists(a: float, b: float) -> tuple[list[float], list[float], list[float], int]:
        times, _ = frames(a, b)
        f1s: list[float] = []
        f2s: list[float] = []
        f3s: list[float] = []
        for t in times:
            f1, f2, f3 = _formants_at(formant, float(t))
            if f1 is not None:
                f1s.append(f1)
            if f2 is not None:
                f2s.append(f2)
            if f3 is not None:
                f3s.append(f3)
        return f1s, f2s, f3s, int(times.size)

    zone_out: dict[str, dict[str, Any]] = {}
    vowel_f3: list[float] = []
    all_f1: list[float] = []
    all_f2: list[float] = []
    for z in zones:
        w = windows.get(z.zoneId)
        if w is None or z.kind not in ("vowel", "tuner"):
            continue
        f1s, f2s, f3s, count = formant_lists(*w)
        all_f1.extend(f1s)
        all_f2.extend(f2s)
        if z.kind == "vowel":
            vowel_f3.extend(f3s)
        zone_out[z.zoneId] = {
            "f1Hz": _hz(_median(f1s)),
            "f2Hz": _hz(_median(f2s)),
            "f3Hz": _hz(_median(f3s)),
            "voicedMs": int(round(count * STEP_S * 1000)),
        }
    vowel_med = _median(vowel_f3)
    if pitch_out is not None:
        pitch_out["f1Hz"] = _hz(_median(all_f1))
        pitch_out["f2Hz"] = _hz(_median(all_f2))

    for z in zones:
        w = windows.get(z.zoneId)
        if w is None:
            continue
        if z.kind == "liquid":
            f3s = formant_lists(*w)[2]
            f3_min = min(f3s) if f3s else None
            drop = f3_min / vowel_med if f3_min is not None and vowel_med else None
            zone_out[z.zoneId] = {"f3Hz": _hz(_median(f3s)), "f3MinHz": _hz(f3_min), "f3Drop": _frac(drop)}
        elif z.kind in ("fricative", "nasal"):
            chunk = samples[int(w[0] * rate) : int(w[1] * rate)]
            if chunk.size < 16:
                continue
            voiced_times, total = frames(*w)
            vf = voiced_times.size / total if total else None
            power = np.abs(np.fft.rfft(chunk * np.hanning(chunk.size))) ** 2
            freqs = np.fft.rfftfreq(chunk.size, 1.0 / rate)
            energy = float(power.sum())
            if z.kind == "fricative":
                cog = float((freqs * power).sum() / energy) if energy > 0 else None
                zone_out[z.zoneId] = {"cogHz": _hz(cog), "voicedFraction": _frac(vf)}
            else:
                low = float(power[freqs < LOW_BAND_HZ].sum() / energy) if energy > 0 else None
                zone_out[z.zoneId] = {"voicedFraction": _frac(vf), "lowBandRatio": _frac(low)}
    out["zones"] = zone_out
    return out
