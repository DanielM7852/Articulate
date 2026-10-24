"""Deterministic pitch-shape comparison.

Each recording is normalized by its own median reliable F0:

    relative_pitch_st = 12 * log2(F0 / median_reliable_voiced_F0)

The semitone range is preserved. Contours are not stretched onto one shared range.

Ending direction uses the median of the last window minus the median of the
window before it. Windows are fractions of the usable phrase span, not single
frames. The direction threshold is an engineering setting.

Timing stays on the original clock. Constrained DTW is used only when the
phrase durations differ enough to justify it and a Sakoe-Chiba band can connect
the corners without becoming unconstrained. Otherwise comparison uses linear
time normalization, and the duration ratio is reported separately.
"""

import numpy as np

from app.config import Settings
from app.schemas import (
    AlignmentInfo,
    ComparisonMetrics,
    PitchContour,
    PitchFrame,
    ReferenceMetadata,
    Segment,
)


def usable_series(contour: PitchContour) -> tuple[np.ndarray, np.ndarray]:
    times = [frame.time_s for frame in contour.frames if frame.usable and frame.relative_pitch_st is not None]
    values = [frame.relative_pitch_st for frame in contour.frames if frame.usable and frame.relative_pitch_st is not None]
    return np.asarray(times, dtype=np.float64), np.asarray(values, dtype=np.float64)


def interior_coverage(frames: list[PitchFrame]) -> tuple[float | None, int]:
    indexes = [index for index, frame in enumerate(frames) if frame.usable]
    if not indexes:
        return 0.0, 0
    if len(indexes) == 1:
        return 1.0, 1
    span = indexes[-1] - indexes[0] + 1
    usable_in_span = sum(1 for index in range(indexes[0], indexes[-1] + 1) if frames[index].usable)
    return usable_in_span / span, len(indexes)


def _direction(change: float | None, threshold: float) -> str:
    if change is None:
        return "unknown"
    if change > threshold:
        return "rising"
    if change < -threshold:
        return "falling"
    return "steady"


def phrase_features(contour: PitchContour, settings: Settings) -> dict:
    times, values = usable_series(contour)
    coverage, count = interior_coverage(contour.frames)
    result = {
        "ending_change_st": None,
        "ending_direction": "unknown",
        "pitch_range_st": None,
        "movement_time_fraction": None,
        "duration_s": None,
        "coverage": None if coverage is None else round(float(coverage), 5),
        "usable_frames": count,
        "times": times,
        "values": values,
    }
    if count < 2:
        return result
    duration = float(times[-1] - times[0])
    result["duration_s"] = None if duration <= 0 else round(duration, 5)
    if count >= 5:
        result["pitch_range_st"] = round(float(np.percentile(values, 90) - np.percentile(values, 10)), 5)
    window = settings.ending_window_fraction * duration if duration else 0.0
    if duration <= 0 or window <= 0:
        return result
    end_time = float(times[-1])
    late = values[(times >= end_time - window)]
    early = values[(times >= end_time - (2.0 * window)) & (times < end_time - window)]
    if late.size < 2 or early.size < 2:
        return result
    change = float(np.median(late) - np.median(early))
    result["ending_change_st"] = round(change, 5)
    result["ending_direction"] = _direction(change, settings.ending_direction_st)
    if abs(change) > settings.ending_direction_st:
        body = values[times <= times[0] + (0.5 * duration)]
        body_median = float(np.median(body if body.size else values[: max(1, count // 2)]))
        target = body_median + (0.5 * (float(np.median(late)) - body_median))
        for time_s, value in zip(times, values, strict=True):
            fraction = (float(time_s) - float(times[0])) / duration
            if fraction < 0.5:
                continue
            crossed = value >= target if change > 0 else value <= target
            if crossed:
                result["movement_time_fraction"] = round(fraction, 5)
                break
    return result


def _linear_rmse(reference: np.ndarray, learner: np.ndarray, points: int = 48) -> float:
    grid = np.linspace(0.0, 1.0, points)
    reference_grid = np.interp(grid, np.linspace(0.0, 1.0, len(reference)), reference)
    learner_grid = np.interp(grid, np.linspace(0.0, 1.0, len(learner)), learner)
    return float(np.sqrt(np.mean(np.square(reference_grid - learner_grid))))


def _constrained_dtw(reference: np.ndarray, learner: np.ndarray, band_radius: float) -> tuple[float, int, float]:
    import librosa

    cost, path = librosa.sequence.dtw(
        reference.reshape(1, -1),
        learner.reshape(1, -1),
        metric="euclidean",
        global_constraints=True,
        band_rad=band_radius,
    )
    del cost
    if path is None or len(path) == 0:
        raise RuntimeError("empty_dtw_path")
    ordered = path[::-1] if path[0, 0] > path[-1, 0] else path
    paired_reference = reference[ordered[:, 0]]
    paired_learner = learner[ordered[:, 1]]
    rmse = float(np.sqrt(np.mean(np.square(paired_reference - paired_learner))))
    reference_fraction = ordered[:, 0] / max(len(reference) - 1, 1)
    learner_fraction = ordered[:, 1] / max(len(learner) - 1, 1)
    warp = float(np.mean(np.abs(reference_fraction - learner_fraction)))
    return rmse, int(len(ordered)), warp


def align_contours(
    reference: PitchContour,
    learner: PitchContour,
    settings: Settings,
) -> tuple[AlignmentInfo, float | None]:
    reference_times, reference_values = usable_series(reference)
    learner_times, learner_values = usable_series(learner)
    if (
        len(reference_values) < settings.min_usable_frames
        or len(learner_values) < settings.min_usable_frames
    ):
        return (
            AlignmentInfo(
                method="none",
                alignment_ok=False,
                note="Not enough usable frames to align.",
            ),
            None,
        )
    reference_duration = float(reference_times[-1] - reference_times[0])
    learner_duration = float(learner_times[-1] - learner_times[0])
    ratio = None if reference_duration <= 0 else learner_duration / reference_duration
    use_dtw = ratio is not None and (
        ratio >= settings.dtw_duration_ratio_trigger or ratio <= (1.0 / settings.dtw_duration_ratio_trigger)
    )
    if use_dtw:
        shortest = min(len(reference_values), len(learner_values))
        needed = abs(len(reference_values) - len(learner_values)) / max(shortest, 1)
        if needed <= settings.dtw_max_band_radius:
            band = max(settings.dtw_band_radius, needed)
            try:
                rmse, path_length, warp = _constrained_dtw(reference_values, learner_values, band)
            except Exception:  # noqa: BLE001 - estimator failure becomes an alignment flag
                return (
                    AlignmentInfo(
                        method="constrained_dtw",
                        alignment_ok=False,
                        duration_ratio=None if ratio is None else round(ratio, 5),
                        band_radius=round(band, 5),
                        note="Constrained DTW could not build a path inside the band.",
                    ),
                    None,
                )
            return (
                AlignmentInfo(
                    method="constrained_dtw",
                    alignment_ok=True,
                    duration_ratio=None if ratio is None else round(ratio, 5),
                    band_radius=round(band, 5),
                    path_length=path_length,
                    mean_abs_normalized_time_warp=round(warp, 5),
                    note="Band-limited DTW absorbed a duration difference. Ending metrics still use original time.",
                ),
                round(rmse, 5),
            )
        linear = _linear_rmse(reference_values, learner_values)
        return (
            AlignmentInfo(
                method="linear_time_normalization",
                alignment_ok=True,
                duration_ratio=None if ratio is None else round(ratio, 5),
                note="Duration difference exceeded the constrained-DTW band, so shape was compared on normalized time.",
            ),
            round(linear, 5),
        )
    linear = _linear_rmse(reference_values, learner_values)
    return (
        AlignmentInfo(
            method="linear_time_normalization",
            alignment_ok=True,
            duration_ratio=None if ratio is None else round(ratio, 5),
            mean_abs_normalized_time_warp=0.0,
            note="Speaking rates were close enough to compare shape against each recording's own time base.",
        ),
        round(linear, 5),
    )


def voicing_segments(contour: PitchContour, prefix: str) -> list[Segment]:
    segments: list[Segment] = []
    current_kind: str | None = None
    start_index = 0
    frames = contour.frames
    for index, frame in enumerate(frames + [None]):
        kind = None if frame is None else ("voiced" if frame.voiced else "silence")
        if kind == current_kind:
            continue
        if current_kind is not None and index > start_index:
            start = frames[start_index]
            end = frames[index - 1]
            segments.append(
                Segment(
                    segment_id=f"{prefix}-{current_kind}-{len(segments)}",
                    label=current_kind,
                    kind=current_kind,  # type: ignore[arg-type]
                    start_s=start.time_s,
                    end_s=end.time_s,
                )
            )
        current_kind = kind
        start_index = index
    return segments


def comparison_segments(
    metadata: ReferenceMetadata,
    reference: PitchContour,
) -> list[Segment]:
    times, _values = usable_series(reference)
    segments: list[Segment] = []
    if len(times) < 2:
        return segments
    span0 = float(times[0])
    span = float(times[-1] - times[0])
    for spec in metadata.segments:
        segments.append(
            Segment(
                segment_id=spec.segment_id,
                label=spec.label,
                kind="comparison",
                start_s=round(span0 + (spec.start_fraction * span), 5),
                end_s=round(span0 + (spec.end_fraction * span), 5),
            )
        )
    return segments


def compare_contours(
    reference: PitchContour,
    learner: PitchContour,
    settings: Settings,
) -> tuple[ComparisonMetrics, AlignmentInfo]:
    reference_features = phrase_features(reference, settings)
    learner_features = phrase_features(learner, settings)
    alignment, rmse = align_contours(reference, learner, settings)
    metrics = ComparisonMetrics(
        reference_ending_direction=reference_features["ending_direction"],
        learner_ending_direction=learner_features["ending_direction"],
        reference_ending_change_st=reference_features["ending_change_st"],
        learner_ending_change_st=learner_features["ending_change_st"],
        reference_pitch_range_st=reference_features["pitch_range_st"],
        learner_pitch_range_st=learner_features["pitch_range_st"],
        reference_movement_time_fraction=reference_features["movement_time_fraction"],
        learner_movement_time_fraction=learner_features["movement_time_fraction"],
        aligned_rmse_st=rmse,
        usable_frame_coverage_reference=reference_features["coverage"],
        usable_frame_coverage_learner=learner_features["coverage"],
        reference_usable_frames=reference_features["usable_frames"],
        learner_usable_frames=learner_features["usable_frames"],
        reference_duration_s=reference_features["duration_s"],
        learner_duration_s=learner_features["duration_s"],
    )
    return metrics, alignment
