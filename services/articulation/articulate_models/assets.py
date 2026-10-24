"""Local prepared assets, checked against the pinned manifest before model loading."""

import json
from pathlib import Path

from .prepare import LOCK, models_directory, sha256


class AssetsUnavailable(RuntimeError):
    pass


class Assets:
    def __init__(self, directory: Path | None = None):
        self.directory = (directory or models_directory()).resolve()
        self.verified: set[str] = set()

    def manifest(self) -> dict:
        path = self.directory / "manifest.json"
        if not path.is_file():
            raise AssetsUnavailable("Run articulate-models prepare before inference")
        return json.loads(path.read_text(encoding="utf-8"))

    def check_model(self, name: str) -> dict:
        manifest = self.manifest()
        if manifest.get("models", {}).get(name) != LOCK[name]:
            raise AssetsUnavailable(f"Prepared {name} does not match models.lock.json; prepare again")
        return manifest

    def artifact(self, key: str, *, verify=True) -> Path:
        entry = self.manifest().get("artifacts", {}).get(key)
        if not entry:
            raise AssetsUnavailable(f"Missing prepared artifact {key}")
        path = (self.directory / entry["path"]).resolve()
        if not path.is_relative_to(self.directory) or not path.is_file():
            raise AssetsUnavailable(f"Missing local artifact {key}")
        if path.stat().st_size != entry["bytes"]:
            raise AssetsUnavailable(f"Incorrect artifact size: {key}")
        if verify and key not in self.verified:
            if sha256(path) != entry["sha256"]:
                raise AssetsUnavailable(f"Artifact checksum mismatch: {key}")
            group, filename = key.split("/", 1)
            expected = LOCK.get(group, {}).get("sha256", {}).get(filename)
            if key == "arti6/wavlm_articulatory.py":
                expected = LOCK["arti6"]["architectureSha256"]
            if expected and entry["sha256"] != expected:
                raise AssetsUnavailable(f"Artifact is not the pinned official checkpoint: {key}")
            self.verified.add(key)
        return path

    def required_keys(self, name: str) -> list[str]:
        if name == "silero_vad":
            return ["silero_vad/silero_vad.onnx"]
        keys = [f"wavlm/{file}" for file in LOCK["wavlm"]["files"]]
        keys += [f"{name}/{file}" for file in LOCK[name]["files"]]
        if name == "arti6":
            keys.append("arti6/wavlm_articulatory.py")
        return keys

    def provenance(self, name: str) -> dict:
        manifest = self.check_model(name)
        groups = {name, "wavlm"} if name in {"sparc", "arti6"} else {name}
        return {
            "specification": LOCK[name],
            "artifacts": {
                key: {k: v for k, v in entry.items() if k != "path"}
                for key, entry in manifest["artifacts"].items()
                if key.split("/", 1)[0] in groups
            },
        }

    def wavlm_directory(self) -> Path:
        for filename in LOCK["wavlm"]["files"]:
            self.artifact(f"wavlm/{filename}")
        return self.directory / "wavlm"
