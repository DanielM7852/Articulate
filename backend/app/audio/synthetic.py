"""Deterministic harmonic phrases for development fixtures.

These are not human recordings. A harmonic stack makes file-based pYIN recoverable
in tests; it does not represent a speaker's voice quality.
"""

import numpy as np

from app.schemas import AudioRecipe


def f0_track(recipe: AudioRecipe) -> tuple[np.ndarray, int]:
    """Return a per-sample F0 track in Hz and the sample rate."""

    sr = recipe.sample_rate_hz
    count = int(sr * recipe.duration_s)
    if count < 8:
        raise ValueError("Recipe duration is too short to synthesize.")
    position = np.linspace(0.0, 1.0, count, endpoint=False)
    if recipe.pattern == "steady":
        return np.full(count, recipe.start_f0_hz, dtype=np.float64), sr
    start = recipe.start_f0_hz
    end = recipe.end_f0_hz
    glide_at = recipe.glide_start_fraction
    f0 = np.full(count, start, dtype=np.float64)
    glide = position >= glide_at
    span = max(1e-6, 1.0 - glide_at)
    unit = (position[glide] - glide_at) / span
    shaped = 0.5 * (1.0 - np.cos(np.pi * unit))
    f0[glide] = start + (end - start) * shaped
    return f0, sr


def render_harmonics(
    f0_hz: np.ndarray,
    sample_rate: int,
    *,
    amplitude: float = 0.2,
) -> np.ndarray:
    """Render a static-harmonic signal whose instantaneous F0 follows ``f0_hz``."""

    phase = np.cumsum(f0_hz) / sample_rate
    signal = np.zeros(f0_hz.shape[0], dtype=np.float64)
    for harmonic, weight in ((1, 0.62), (2, 0.24), (3, 0.1), (4, 0.04)):
        signal += weight * np.sin(2.0 * np.pi * harmonic * phase)
    fade = min(int(0.03 * sample_rate), max(1, signal.shape[0] // 8))
    window = np.ones(signal.shape[0], dtype=np.float64)
    ramp = np.linspace(0.0, 1.0, fade)
    window[:fade] = ramp
    window[-fade:] = ramp[::-1]
    return (amplitude * signal * window).astype(np.float64)


def render_recipe(recipe: AudioRecipe, *, f0_scale: float = 1.0, amplitude: float = 0.2) -> tuple[np.ndarray, int]:
    f0, sr = f0_track(recipe)
    return render_harmonics(f0 * f0_scale, sr, amplitude=amplitude), sr


def scaled_recipe(recipe: AudioRecipe, *, duration_s: float | None = None, f0_scale: float = 1.0) -> AudioRecipe:
    data = recipe.model_dump()
    if duration_s is not None:
        data["duration_s"] = duration_s
    updated = AudioRecipe.model_validate(data)
    if f0_scale != 1.0:
        updated = updated.model_copy(
            update={
                "start_f0_hz": updated.start_f0_hz * f0_scale,
                "end_f0_hz": updated.end_f0_hz * f0_scale,
            }
        )
    return updated
