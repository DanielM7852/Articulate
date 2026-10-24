"""Shared constructors for synthetic contours and a fake orchestrator."""

import json

import numpy as np

from app.audio.decode import encode_wav
from app.audio.extract import capture_facts, frames_from_f0_track
from app.audio.gateway import LearnerAudio, LoadedReference
from app.config import Settings
from app.integrations.anthropic_client import ClaudeCoach
from app.integrations.cues import load_cue_library
from app.integrations.moss import CueRetriever
from app.paths import REFERENCE_DIR
from app.progress import ProgressBus
from app.reasoning.orchestrate import Orchestrator
from app.schemas import PitchContour, ReferenceMetadata
from app.storage.local import LocalSessionStore


def make_settings(tmp_path, **overrides) -> Settings:
    data = {
        "store_dir": str(tmp_path / "store"),
        "anthropic_api_key": None,
        "moss_project_id": None,
        "moss_project_key": None,
        "cartesia_api_key": None,
        "cartesia_voice_id": None,
    }
    data.update(overrides)
    return Settings(_env_file=None, **data)


def reference_metadata() -> ReferenceMetadata:
    payload = json.loads((REFERENCE_DIR / "intonation-rising-ready.json").read_text(encoding="utf-8"))
    return ReferenceMetadata.model_validate(payload)


def contour_from_hz(settings: Settings, f0_hz: np.ndarray, times_s: np.ndarray) -> PitchContour:
    voiced = np.isfinite(f0_hz) & (f0_hz > 0)
    probability = np.where(voiced, 0.95, 0.0)
    safe_f0 = np.where(voiced, f0_hz, 0.0)
    frames, median = frames_from_f0_track(times_s, safe_f0, voiced, probability, settings)
    return PitchContour(
        sample_rate_hz=16000,
        hop_length=256,
        frame_length=1024,
        analysis_version=settings.analysis_version,
        median_reliable_f0_hz=median,
        frames=frames,
    )


def pitch_track(kind: str, *, f0_scale: float = 1.0, time_scale: float = 1.0, glitch: str | None = None) -> tuple[np.ndarray, np.ndarray]:
    times = np.linspace(0.0, time_scale, 50, endpoint=False)
    f0 = np.full(50, 180.0)
    if kind == "rising":
        f0[32:] = np.linspace(180.0, 280.0, 18)
    elif kind == "falling":
        f0[32:] = np.linspace(180.0, 110.0, 18)
    elif kind == "steady":
        pass
    elif kind == "silence":
        f0[:] = np.nan
    else:
        raise ValueError(kind)
    f0 = f0 * f0_scale
    if glitch == "octave":
        f0[20:25] = f0[20:25] * 2.0
    elif glitch == "jump":
        f0[22] = f0[22] * 1.62
    return times, f0


def analyzed_pair(settings: Settings, learner_kind: str, *, reference_kind: str = "rising", **learner_kwargs):
    metadata = reference_metadata()
    reference_times, reference_f0 = pitch_track(reference_kind)
    learner_times, learner_f0 = pitch_track(learner_kind, **learner_kwargs)
    reference_contour = contour_from_hz(settings, reference_f0, reference_times)
    learner_contour = contour_from_hz(settings, learner_f0, learner_times)
    reference_samples = np.full(1600, 0.1)
    learner_samples = np.zeros(1600) if learner_kind == "silence" else np.full(1600, 0.1)
    reference_facts = capture_facts(reference_samples, reference_contour, settings, downmixed_to_mono=False)
    learner_facts = capture_facts(learner_samples, learner_contour, settings, downmixed_to_mono=False)
    loaded = LoadedReference(
        metadata=metadata,
        contour=reference_contour,
        facts=reference_facts,
        wav_bytes=encode_wav(reference_samples, 16000),
        samples=reference_samples,
        sample_rate=16000,
        version_mismatch=False,
    )
    learner = LearnerAudio(
        contour=learner_contour,
        facts=learner_facts,
        samples=learner_samples,
        sample_rate=16000,
    )
    return loaded, learner


class FakeReferences:
    def __init__(self, loaded: LoadedReference) -> None:
        self.loaded = loaded

    def ids(self) -> list[str]:
        return [self.loaded.metadata.reference_id]

    def metadata(self, reference_id: str) -> ReferenceMetadata:
        if reference_id != self.loaded.metadata.reference_id:
            from app.errors import UnknownReferenceError

            raise UnknownReferenceError(reference_id)
        return self.loaded.metadata

    def load(self, reference_id: str) -> LoadedReference:
        self.metadata(reference_id)
        return self.loaded


def build_orchestrator(settings: Settings, loaded: LoadedReference, learner: LearnerAudio, coach=None) -> Orchestrator:
    notice, cues = load_cue_library()
    orchestrator = Orchestrator(
        settings=settings,
        store=LocalSessionStore(settings.store_dir),
        retriever=CueRetriever(cues, notice, settings),
        coach=coach or ClaudeCoach(settings),
        progress=ProgressBus(),
        references=FakeReferences(loaded),  # type: ignore[arg-type]
    )

    def analyze(data: bytes, filename: str, active: Settings) -> LearnerAudio:
        del data, filename, active
        return learner

    orchestrator.analyze_audio = analyze
    return orchestrator
