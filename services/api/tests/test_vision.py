from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.decisions import fallback, validate_decision, visual_observation
from app.features import (
    merge_vision,
    summarize,
    summarize_vision,
    synthetic_frame,
    synthetic_vision_frame,
)
from app.schemas import VisionKeyframe, VisionMetrics


def test_vision_metrics_validation_and_null_rules():
    invalid = VisionMetrics(timestamp_ms=0, valid=False, quality_flags=["missing_face"], lip_opening=None)
    assert not invalid.valid and invalid.lip_opening is None
    with pytest.raises(ValidationError):
        VisionMetrics(timestamp_ms=0, valid=False, lip_opening=0.2)
    with pytest.raises(ValidationError):
        VisionMetrics(timestamp_ms=0, valid=True, lip_opening=None)


def test_merge_vision_and_summarize_full_telemetry():
    acoustic = [synthetic_frame("u", i) for i in range(20)]
    vision = [synthetic_vision_frame("u", i) for i in range(20)]
    merged = merge_vision(acoustic[0], vision[0])
    assert merged.lip_opening == vision[0].lip_opening
    assert merged.rounding_score == vision[0].rounding_score

    v_sum = summarize_vision(vision, acoustic, keyframes_count=3)
    assert v_sum is not None
    assert v_sum.usable_frames == 20 and v_sum.usable_fraction == 1.0
    assert v_sum.keyframes_count == 3
    assert v_sum.rounding_score_mean and v_sum.rounding_score_mean > 0.6
    assert v_sum.voiced_visual_alignment == 1.0
    assert "mouthPucker" in v_sum.blendshapes_mean
    assert "yaw_deg" in v_sum.head_pose_mean

    summary = summarize(
        uuid4(),
        "u",
        acoustic,
        24000,
        19200,
        "synthetic",
        vision_frames=vision,
        keyframes_count=3,
    )
    assert "lip_opening_mean" in summary.evidence_fields
    assert "vision_summary" in summary.evidence_fields
    assert summary.vision_summary is not None
    assert summary.vision_summary.keyframes_count == 3


def test_visual_observations_and_validation_across_targets(runtime):
    for target_id, phrase in (
        ("u", "lip rounding"),
        ("i", "lip spreading"),
        ("aa", "jaw opening"),
    ):
        acoustic = [synthetic_frame(target_id, i) for i in range(20)]
        vision = [synthetic_vision_frame(target_id, i) for i in range(20)]
        summary = summarize(
            uuid4(),
            target_id,
            acoustic,
            24000,
            19200,
            "synthetic",
            vision_frames=vision,
            keyframes_count=3,
        )
        cues = [
            c.model_copy(update={"review_status": "approved"})
            for c in runtime.repository.eligible(target_id)
        ]
        gen = uuid4()
        obs = visual_observation(summary)
        assert obs is not None and phrase in obs
        dec = validate_decision(fallback(summary, gen, cues), summary, gen, cues)
        assert dec.visual_observation == obs
        assert "lip_opening_mean" in dec.evidence_fields


def test_reject_visual_observation_when_camera_absent(runtime):
    acoustic = [synthetic_frame("i", i) for i in range(20)]
    summary = summarize(uuid4(), "i", acoustic, 24000, 19200, "synthetic")
    cues = [
        c.model_copy(update={"review_status": "approved"})
        for c in runtime.repository.eligible("i")
    ]
    gen = uuid4()
    base = fallback(summary, gen, cues)
    assert base.visual_observation is None
    with pytest.raises(ValueError):
        validate_decision(
            base.model_copy(
                update={
                    "visual_observation": "Camera tracking shows clear horizontal lip spreading for /i/."
                }
            ),
            summary,
            gen,
            cues,
        )


def test_runtime_ingests_vision_and_deduplicates_keyframes(runtime):
    runtime.session.state = "capturing"
    vf = synthetic_vision_frame("i", 0)
    kfs = [
        VisionKeyframe(label="onset", timestamp_ms=0, data_base64="YWJj", metrics=vf),
        VisionKeyframe(label="peak_nucleus", timestamp_ms=200, data_base64="ZGVm", metrics=vf),
        VisionKeyframe(label="sustained_hold", timestamp_ms=400, data_base64="Z2hp", metrics=vf),
    ]
    runtime.ingest_vision(frame=vf, keyframes=kfs)
    assert len(runtime.vision_frames) == 1
    assert len(runtime.keyframes) == 3
    assert "MediaPipe" in runtime.camera_status
