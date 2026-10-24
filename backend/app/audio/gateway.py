"""Reference cache and learner-audio analysis."""

import hashlib
import json
import threading
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np

from app.audio.compare import compare_contours
from app.audio.decode import decode_audio, encode_wav
from app.audio.extract import CaptureFacts, capture_facts, extract_pitch
from app.audio.synthetic import render_recipe, scaled_recipe
from app.config import Settings
from app.errors import ArticulateError, UnknownReferenceError
from app.integrations.cartesia import REFERENCE_SAMPLE_RATE_HZ, synthesize_wav
from app.paths import REFERENCE_DIR
from app.schemas import AlignmentInfo, ComparisonMetrics, PitchContour, ReferenceMetadata

FIXTURE_SCENARIOS = (
    "identical",
    "baseline_shift",
    "faster_speech",
    "rising_vs_falling",
    "silence",
    "content_mismatch",
)


@dataclass
class LoadedReference:
    metadata: ReferenceMetadata
    contour: PitchContour
    facts: CaptureFacts
    wav_bytes: bytes
    samples: np.ndarray
    sample_rate: int
    version_mismatch: bool


@dataclass
class LearnerAudio:
    contour: PitchContour
    facts: CaptureFacts
    samples: np.ndarray
    sample_rate: int


class ReferenceLibrary:
    """Load reference metadata and cache pYIN features in memory.

    Learner uploads are not written here. With a Cartesia key, the reference
    waveform is spoken from the transcript and cached as generated audio.
    Without a key, the harmonic recipe is still rendered in memory.
    """

    def __init__(self, settings: Settings, directory=REFERENCE_DIR, speech_client: httpx.Client | None = None) -> None:
        self._settings = settings
        self._speech_client = speech_client
        self._metadata: dict[str, ReferenceMetadata] = {}
        self._cache: dict[str, LoadedReference] = {}
        self._lock = threading.Lock()
        for path in sorted(directory.glob("*.json")):
            metadata = ReferenceMetadata.model_validate(json.loads(path.read_text(encoding="utf-8")))
            self._metadata[metadata.reference_id] = metadata

    def ids(self) -> list[str]:
        return sorted(self._metadata)

    def metadata(self, reference_id: str) -> ReferenceMetadata:
        try:
            return self._metadata[reference_id]
        except KeyError as exc:
            raise UnknownReferenceError(reference_id) from exc

    def load(self, reference_id: str) -> LoadedReference:
        with self._lock:
            cached = self._cache.get(reference_id)
            if cached is not None:
                return cached
            metadata = self.metadata(reference_id)
            samples, sample_rate, wav_bytes, metadata = self._reference_waveform(metadata)
            contour = extract_pitch(samples, sample_rate, self._settings)
            loaded = LoadedReference(
                metadata=metadata,
                contour=contour,
                facts=capture_facts(samples, contour, self._settings, downmixed_to_mono=False),
                wav_bytes=wav_bytes,
                samples=samples,
                sample_rate=sample_rate,
                version_mismatch=metadata.analysis_version != self._settings.analysis_version,
            )
            self._cache[reference_id] = loaded
            return loaded

    def _reference_waveform(self, metadata: ReferenceMetadata):
        # 2026-10-23: harmonic render_recipe remains the offline reference when Cartesia is not configured.
        if self._settings.cartesia_configured:
            return self._cartesia_waveform(metadata)
        samples, sample_rate = render_recipe(metadata.audio_recipe)
        return samples, sample_rate, encode_wav(samples, sample_rate), metadata

    def _cartesia_waveform(self, metadata: ReferenceMetadata):
        voice_id = self._settings.resolved_cartesia_voice_id or ""
        cache_key = {
            "transcript": metadata.transcript,
            "voice_id": voice_id,
            "model_id": self._settings.cartesia_model_id,
            "version": self._settings.cartesia_version,
            "sample_rate_hz": REFERENCE_SAMPLE_RATE_HZ,
        }
        digest = hashlib.sha256(json.dumps(cache_key, sort_keys=True).encode()).hexdigest()[:16]
        cache_path = Path(self._settings.store_dir) / "reference_audio" / f"{metadata.reference_id}-{digest}.wav"
        if cache_path.is_file():
            wav_bytes = cache_path.read_bytes()
        else:
            wav_bytes = synthesize_wav(
                metadata.transcript,
                api_key=self._settings.cartesia_api_key or "",
                voice_id=voice_id,
                model_id=self._settings.cartesia_model_id,
                version=self._settings.cartesia_version,
                timeout_s=self._settings.audio_timeout_s,
                client=self._speech_client,
            )
            samples, sample_rate, _downmixed = decode_audio(
                wav_bytes,
                f"{metadata.reference_id}.wav",
                self._settings,
            )
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(wav_bytes)
            return samples, sample_rate, wav_bytes, _spoken_metadata(metadata)
        samples, sample_rate, _downmixed = decode_audio(
            wav_bytes,
            f"{metadata.reference_id}.wav",
            self._settings,
        )
        return samples, sample_rate, wav_bytes, _spoken_metadata(metadata)


def _spoken_metadata(metadata: ReferenceMetadata) -> ReferenceMetadata:
    provenance = metadata.provenance.model_copy(
        update={
            "kind": "cartesia_tts",
            "reviewed": False,
            "description": (
                "Spoken by Cartesia from the reference transcript. "
                "It is one example of the phrase, not a recording of the learner and not a norm for every voice."
            ),
        }
    )
    return metadata.model_copy(update={"provenance": provenance})


def analyze_learner_bytes(data: bytes, filename: str, settings: Settings) -> LearnerAudio:
    samples, sample_rate, downmixed = decode_audio(data, filename, settings)
    contour = extract_pitch(samples, sample_rate, settings)
    return LearnerAudio(
        contour=contour,
        facts=capture_facts(samples, contour, settings, downmixed_to_mono=downmixed),
        samples=samples,
        sample_rate=sample_rate,
    )


def measure(
    reference: PitchContour,
    learner: PitchContour,
    settings: Settings,
) -> tuple[ComparisonMetrics, AlignmentInfo]:
    return compare_contours(reference, learner, settings)


def fixture_wav(scenario: str, metadata: ReferenceMetadata) -> bytes:
    """Build labeled synthetic learner audio for a fixture scenario."""

    recipe = metadata.audio_recipe
    if scenario in {"identical", "content_mismatch"}:
        samples, sample_rate = render_recipe(recipe)
    elif scenario == "baseline_shift":
        samples, sample_rate = render_recipe(recipe, f0_scale=1.35)
    elif scenario == "faster_speech":
        samples, sample_rate = render_recipe(scaled_recipe(recipe, duration_s=0.72))
    elif scenario == "rising_vs_falling":
        falling = recipe.model_copy(
            update={"pattern": "falling", "start_f0_hz": 180.0, "end_f0_hz": 120.0}
        )
        samples, sample_rate = render_recipe(falling)
    elif scenario == "silence":
        sample_rate = recipe.sample_rate_hz
        samples = np.zeros(int(sample_rate * 0.5), dtype=np.float64)
    else:
        raise ArticulateError("unknown_fixture", f"Unknown fixture scenario '{scenario}'.", status_code=404)
    return encode_wav(samples, sample_rate)
