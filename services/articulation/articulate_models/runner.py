"""Independent model collection with per-model failures, provenance and shared audio clocks."""

import importlib.util
import importlib.metadata
import math
import platform
import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

from .adapters import FACTORIES
from .assets import Assets, AssetsUnavailable
from .audio import decode_wav
from .contract import MODEL_NAMES, SCHEMA_VERSION, unavailable


class ModelBusy(RuntimeError):
    pass


def runtime_versions() -> dict:
    versions = {"python": platform.python_version()}
    for package in ("torch", "transformers", "numpy", "scipy", "speech-articulatory-coding", "silero-vad"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return versions


class Collector:
    def __init__(self, directory: Path | None = None, device="cpu", factories=None):
        if device not in ("cpu", "cuda"):
            raise ValueError("device must be cpu or cuda")
        self.assets = Assets(directory)
        self.device = device
        self.factories = FACTORIES if factories is None else factories
        self.loaded = {}
        self.lock = threading.Lock()

    @staticmethod
    def choose(names=None) -> list[str]:
        selected = list(dict.fromkeys(MODEL_NAMES if names is None else names))
        if not selected or any(name not in MODEL_NAMES for name in selected):
            raise ValueError("models must contain sparc, arti6 and/or silero_vad")
        return selected

    def status(self) -> dict:
        output = {}
        for name in MODEL_NAMES:
            if name in self.loaded:
                output[name] = {"status": "loaded", "provenance": self.loaded[name].provenance}
                continue
            try:
                self.assets.check_model(name)
                for key in self.assets.required_keys(name):
                    self.assets.artifact(key, verify=False)
                module = {"sparc": "sparc", "arti6": "loralib", "silero_vad": "silero_vad"}[name]
                if not importlib.util.find_spec(module):
                    raise AssetsUnavailable("Install the models extra")
                output[name] = {"status": "prepared", "provenance": self.assets.provenance(name)}
            except (AssetsUnavailable, ValueError, OSError) as exc:
                output[name] = {"status": "unavailable", "reason": str(exc)}
        return {"schemaVersion": SCHEMA_VERSION, "busy": self.lock.locked(), "models": output}

    def _get(self, name):
        if name not in self.loaded:
            self.loaded[name] = self.factories[name](self.assets, self.device)
        return self.loaded[name]

    def analyze(
        self,
        data: bytes,
        *,
        names=None,
        attempt_id=None,
        capture_start_monotonic_ms=None,
        time_origin_unix_ms=None,
    ) -> dict:
        selected = self.choose(names)
        identity = str(UUID(attempt_id)) if attempt_id else str(uuid4())
        if (capture_start_monotonic_ms is None) != (time_origin_unix_ms is None):
            raise ValueError("Provide both capture clock fields, or neither")
        for value in (capture_start_monotonic_ms, time_origin_unix_ms):
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError("Capture clocks must be finite and nonnegative")
        if not self.lock.acquire(blocking=False):
            raise ModelBusy("Another model collection is running; retry after it finishes")
        try:
            started = time.perf_counter()
            audio = decode_wav(data)
            output = {}
            for name in selected:
                if name != "silero_vad" and any(
                    flag in audio.quality_flags
                    for flag in ("insufficient_signal", "constant_signal", "short_audio")
                ):
                    output[name] = unavailable(
                        name,
                        "insufficient_audio",
                        "Need at least 0.5 seconds of nonconstant signal",
                        status="skipped",
                    )
                    continue
                t0 = time.perf_counter()
                adapter = None
                try:
                    adapter = self._get(name)
                    t1 = time.perf_counter()
                    sequences, segments = adapter.infer(audio.samples)
                    if capture_start_monotonic_ms is not None:
                        for sequence in sequences.values():
                            sequence["captureTimestampsMonotonicMs"] = [
                                capture_start_monotonic_ms + t for t in sequence["timestampsMs"]
                            ]
                    output[name] = {
                        "model": name,
                        "status": "ok",
                        "error": None,
                        "provenance": adapter.provenance,
                        "series": sequences,
                        "segments": segments,
                        "timingsMs": {
                            "load": round((t1 - t0) * 1000, 2),
                            "inference": round((time.perf_counter() - t1) * 1000, 2),
                        },
                    }
                except (ImportError, importlib.metadata.PackageNotFoundError) as exc:
                    output[name] = unavailable(
                        name, "dependency_missing", f"Install the models extra ({type(exc).__name__})"
                    )
                except AssetsUnavailable as exc:
                    output[name] = unavailable(name, "assets_unavailable", str(exc))
                except Exception as exc:
                    output[name] = unavailable(
                        name,
                        "model_failed",
                        f"{type(exc).__name__}: {exc}",
                        status="error",
                        provenance=adapter.provenance if adapter else None,
                    )
            successes = sum(result["status"] == "ok" for result in output.values())
            return {
                "schemaVersion": SCHEMA_VERSION,
                "attemptId": identity,
                "status": "ok"
                if successes == len(selected)
                else "partial"
                if successes
                else "no_model_outputs",
                "audio": audio.metadata,
                "qualityFlags": audio.quality_flags,
                "clock": {
                    "captureStartMonotonicMs": capture_start_monotonic_ms,
                    "timeOriginUnixMs": time_origin_unix_ms,
                    "alignment": "nominal_model_window_centers; not measured anatomical synchronization",
                },
                "models": output,
                "runtimeVersions": runtime_versions(),
                "totalMs": round((time.perf_counter() - started) * 1000, 2),
            }
        finally:
            self.lock.release()
