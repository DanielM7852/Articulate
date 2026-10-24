import math
from uuid import UUID

import numpy as np
import parselmouth

from .schemas import TARGETS, AttemptSummary, FeatureFrame, VisionMetrics, VisionSummary


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


def merge_vision(frame: FeatureFrame, vision: VisionMetrics | None) -> FeatureFrame:
    if vision is None or not vision.valid:
        return frame
    return frame.model_copy(
        update={
            "lip_opening": vision.lip_opening,
            "lip_width": vision.lip_width,
            "lip_aspect_ratio": vision.lip_aspect_ratio,
            "lip_protrusion_z": vision.lip_protrusion_z,
            "jaw_drop": vision.jaw_drop,
            "rounding_score": vision.rounding_score,
            "spread_score": vision.spread_score,
            "openness_score": vision.openness_score,
            "vision": vision,
        }
    )


def _mean(values: list[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(v)]
    return round(float(np.mean(clean)), 4) if clean else None


def _max(values: list[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(v)]
    return round(float(np.max(clean)), 4) if clean else None


def _min(values: list[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(v)]
    return round(float(np.min(clean)), 4) if clean else None


def summarize_vision(
    vision_frames: list[VisionMetrics],
    acoustic_frames: list[FeatureFrame] | None = None,
    keyframes_count: int = 0,
) -> VisionSummary | None:
    if not vision_frames and keyframes_count == 0:
        return None
    total = len(vision_frames)
    valid = [v for v in vision_frames if v.valid and v.lip_opening is not None]
    flags = sorted({flag for v in vision_frames for flag in v.quality_flags})
    if not valid:
        if "missing_face" not in flags:
            flags.append("no_usable_vision_frames")
        return VisionSummary(
            usable_frames=0,
            total_frames=total,
            usable_fraction=0.0,
            quality_flags=flags,
            keyframes_count=keyframes_count,
        )

    openings = [v.lip_opening for v in valid]
    stability = round(float(np.std([x for x in openings if x is not None])), 4) if len(valid) >= 2 else 0.0

    # Compute mean across all blendshape keys present in valid frames
    bs_keys = sorted({k for v in valid for k in v.blendshapes})
    bs_mean = {}
    for k in bs_keys:
        vals = [v.blendshapes[k] for v in valid if k in v.blendshapes and math.isfinite(v.blendshapes[k])]
        if vals:
            bs_mean[k] = round(float(np.mean(vals)), 4)

    pose_mean = {}
    for axis in ("pitch_deg", "yaw_deg", "roll_deg"):
        m = _mean([getattr(v, axis) for v in valid])
        if m is not None:
            pose_mean[axis] = m

    # Voiced-visual temporal alignment: fraction of valid acoustic frames with a valid vision frame within 80 ms
    alignment = None
    voiced = [a for a in (acoustic_frames or []) if a.valid]
    if voiced:
        matched = sum(1 for a in voiced if any(abs(v.timestamp_ms - a.timestamp_ms) <= 80 for v in valid))
        alignment = round(matched / len(voiced), 4)

    return VisionSummary(
        usable_frames=len(valid),
        total_frames=total,
        usable_fraction=round(min(1.0, len(valid) / max(1, total)), 4),
        quality_flags=flags,
        lip_opening_mean=_mean([v.lip_opening for v in valid]),
        lip_opening_max=_max([v.lip_opening for v in valid]),
        outer_lip_height_mean=_mean([v.outer_lip_height for v in valid]),
        vermilion_flare_mean=_mean([v.vermilion_flare for v in valid]),
        lip_width_mean=_mean([v.lip_width for v in valid]),
        lip_width_min=_min([v.lip_width for v in valid]),
        lip_aspect_ratio_mean=_mean([v.lip_aspect_ratio for v in valid]),
        lip_protrusion_z_mean=_mean([v.lip_protrusion_z for v in valid]),
        jaw_drop_mean=_mean([v.jaw_drop for v in valid]),
        mouth_symmetry_mean=_mean([v.mouth_symmetry for v in valid]),
        inner_mouth_area_mean=_mean([v.inner_mouth_area for v in valid]),
        rounding_score_mean=_mean([v.rounding_score for v in valid]),
        rounding_score_max=_max([v.rounding_score for v in valid]),
        spread_score_mean=_mean([v.spread_score for v in valid]),
        spread_score_max=_max([v.spread_score for v in valid]),
        openness_score_mean=_mean([v.openness_score for v in valid]),
        openness_score_max=_max([v.openness_score for v in valid]),
        posture_stability_std=stability,
        voiced_visual_alignment=alignment,
        blendshapes_mean=bs_mean,
        head_pose_mean=pose_mean,
        keyframes_count=keyframes_count,
    )


def summarize(
    attempt_id: UUID,
    target_id: str,
    frames: list[FeatureFrame],
    rate: int,
    end: int,
    source: str,
    assistance_level="guided",
    vision_frames: list[VisionMetrics] | None = None,
    keyframes_count: int = 0,
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

    collected_vision = list(vision_frames or [])
    if not collected_vision:
        collected_vision = [f.vision for f in frames if f.vision is not None]

    v_summary = summarize_vision(collected_vision, frames, keyframes_count=keyframes_count)
    lip_opening_mean = v_summary.lip_opening_mean if v_summary else _mean([f.lip_opening for f in frames])
    lip_width_mean = v_summary.lip_width_mean if v_summary else _mean([f.lip_width for f in frames])
    lip_rounding_mean = (
        v_summary.rounding_score_mean if v_summary else _mean([f.rounding_score for f in frames])
    )
    lip_spread_mean = v_summary.spread_score_mean if v_summary else _mean([f.spread_score for f in frames])
    jaw_drop_mean = v_summary.jaw_drop_mean if v_summary else _mean([f.jaw_drop for f in frames])

    if lip_opening_mean is not None:
        fields.append("lip_opening_mean")
    if lip_width_mean is not None:
        fields.append("lip_width_mean")
    if lip_rounding_mean is not None:
        fields.append("lip_rounding_mean")
    if lip_spread_mean is not None:
        fields.append("lip_spread_mean")
    if jaw_drop_mean is not None:
        fields.append("jaw_drop_mean")
    if v_summary is not None and v_summary.usable_frames > 0:
        fields.append("vision_summary")

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
        lip_opening_mean=lip_opening_mean,
        lip_width_mean=lip_width_mean,
        lip_rounding_mean=lip_rounding_mean,
        lip_spread_mean=lip_spread_mean,
        jaw_drop_mean=jaw_drop_mean,
        vision_summary=v_summary,
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


def synthetic_vision_frame(target_id: str, index: int) -> VisionMetrics:
    """Deterministic synthetic MediaPipe CV metrics for testing each vowel posture."""
    wobble = 0.02 * math.sin(index / 6)
    if target_id == "u":
        opening, width, protrude, jaw = 0.14 + wobble, 0.56 - wobble, 0.18, 0.92
        pucker, funnel, smile, stretch, jaw_open = 0.78, 0.52, 0.05, 0.04, 0.14
    elif target_id == "aa":
        opening, width, protrude, jaw = 0.48 + wobble, 0.74, 0.02, 1.32
        pucker, funnel, smile, stretch, jaw_open = 0.06, 0.08, 0.12, 0.10, 0.68
    else:  # "i"
        opening, width, protrude, jaw = 0.15 + wobble, 0.88 + wobble, -0.04, 0.94
        pucker, funnel, smile, stretch, jaw_open = 0.05, 0.04, 0.52, 0.44, 0.12
    outer = opening + 0.14
    rounding = max(pucker, 0.7 * pucker + 0.3 * funnel)
    spread = 0.5 * (smile + stretch)
    openness = min(1.0, max(0.0, 0.7 * jaw_open + 0.1))
    return VisionMetrics(
        timestamp_ms=index * 40,
        valid=True,
        lip_opening=round(opening, 4),
        outer_lip_height=round(outer, 4),
        vermilion_flare=round(outer - opening, 4),
        lip_width=round(width, 4),
        lip_aspect_ratio=round(opening / width, 4),
        lip_protrusion_z=round(protrude, 4),
        jaw_drop=round(jaw, 4),
        mouth_symmetry=0.02,
        inner_mouth_area=round(opening * width * 0.75, 4),
        rounding_score=round(rounding, 4),
        spread_score=round(spread, 4),
        openness_score=round(openness, 4),
        blendshapes={
            "jawOpen": jaw_open,
            "jawForward": 0.05,
            "jawLeft": 0.0,
            "jawRight": 0.0,
            "mouthPucker": pucker,
            "mouthFunnel": funnel,
            "mouthClose": 0.04,
            "mouthSmileLeft": smile,
            "mouthSmileRight": smile,
            "mouthStretchLeft": stretch,
            "mouthStretchRight": stretch,
            "mouthDimpleLeft": smile * 0.3,
            "mouthDimpleRight": smile * 0.3,
            "mouthUpperUpLeft": 0.08,
            "mouthUpperUpRight": 0.08,
            "mouthLowerDownLeft": jaw_open * 0.4,
            "mouthLowerDownRight": jaw_open * 0.4,
            "mouthPressLeft": 0.02,
            "mouthPressRight": 0.02,
            "mouthRollUpper": 0.02,
            "mouthRollLower": 0.02,
            "mouthShrugUpper": funnel * 0.3,
            "mouthShrugLower": funnel * 0.2,
            "cheekPuff": 0.01,
        },
        pitch_deg=1.5,
        yaw_deg=-1.0,
        roll_deg=0.5,
    )
