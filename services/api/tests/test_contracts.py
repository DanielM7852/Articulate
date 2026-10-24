import json
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.features import summarize, synthetic_frame
from app.schemas import CoachingDecision, FeatureFrame
from scripts.export_contracts import ROOT, export


def test_schema_does_not_drift():
    assert json.loads((ROOT / "packages/contracts/schema.json").read_text()) == json.loads(export())


def test_missing_metrics_are_null_and_invalid_cannot_contain_formants():
    frame = FeatureFrame(sample_offset=0, timestamp_ms=0, duration_ms=40, valid=False, source="microphone")
    assert frame.f1 is None and frame.lip_opening is None
    with pytest.raises(ValidationError):
        FeatureFrame(**{**frame.model_dump(), "f1": 0})
    with pytest.raises(ValidationError):
        FeatureFrame(**{**frame.model_dump(), "valid": True})
    with pytest.raises(ValidationError):
        FeatureFrame(**{**frame.model_dump(), "f1": float("nan")})


def test_invalid_action():
    with pytest.raises(ValidationError):
        CoachingDecision(
            attempt_id=uuid4(),
            generation_id=uuid4(),
            observation="x",
            evidence_fields=[],
            cue_id=None,
            cue_version=None,
            pose_id="neutral",
            next_action="diagnose",
        )


def test_invalid_frames_excluded_from_acoustic_mean_and_duration():
    good = synthetic_frame("i", 0)
    bad = FeatureFrame(
        sample_offset=960,
        timestamp_ms=40,
        duration_ms=40,
        valid=False,
        quality_flags=["silence"],
        source="synthetic",
    )
    s = summarize(uuid4(), "i", [good, bad], 24000, 1920, "synthetic")
    assert s.usable_duration_ms == 40 and s.usable_fraction == 0.5
    assert s.f1_mean == good.f1 and "target_distance" not in s.evidence_fields
