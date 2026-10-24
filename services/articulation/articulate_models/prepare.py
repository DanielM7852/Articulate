"""Explicit, revision-pinned downloads. Importing/running inference never downloads weights."""

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import shutil
import urllib.request
from pathlib import Path

LOCK = json.loads(Path(__file__).with_name("models.lock.json").read_text(encoding="utf-8"))
DEFAULT_MODELS_DIR = Path(__file__).resolve().parent.parent / ".models"


def models_directory() -> Path:
    return Path(os.environ.get("ARTICULATION_MODELS_DIR", DEFAULT_MODELS_DIR)).resolve()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, path: Path, expected: str | None = None) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or (expected and sha256(path) != expected):
        temporary = path.with_suffix(path.suffix + ".part")
        print(f"Downloading {path.name}", flush=True)
        with urllib.request.urlopen(url, timeout=180) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if expected and sha256(temporary) != expected:
            temporary.unlink()
            raise ValueError(f"Checksum mismatch for {path.name}")
        temporary.replace(path)
    return {"sha256": sha256(path), "bytes": path.stat().st_size}


def prepare(names: list[str], directory: Path | None = None) -> dict:
    if not names or any(name not in ("sparc", "arti6", "silero_vad") for name in names):
        raise ValueError("Choose sparc, arti6 and/or silero_vad")
    directory = (directory or models_directory()).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / "manifest.json"
    manifest = (
        json.loads(manifest_path.read_text()) if manifest_path.exists() else {"models": {}, "artifacts": {}}
    )
    groups = ["wavlm"] if any(name in names for name in ("sparc", "arti6")) else []
    groups += [name for name in names if name != "silero_vad"]
    for group in groups:
        spec = LOCK[group]
        for filename in spec["files"]:
            key = f"{group}/{filename}"
            entry = download(
                f"https://huggingface.co/{spec['repository']}/resolve/{spec['revision']}/{filename}",
                directory / key,
                spec.get("sha256", {}).get(filename),
            )
            manifest["artifacts"][key] = {
                "path": key,
                **entry,
                "repository": spec["repository"],
                "revision": spec["revision"],
            }
    if "arti6" in names:
        spec = LOCK["arti6"]
        key = "arti6/wavlm_articulatory.py"
        entry = download(
            f"https://raw.githubusercontent.com/lee-jhwn/arti-6/{spec['codeRevision']}/{spec['architectureFile']}",
            directory / key,
            spec["architectureSha256"],
        )
        manifest["artifacts"][key] = {
            "path": key,
            **entry,
            "repository": spec["codeRepository"],
            "revision": spec["codeRevision"],
        }
    if "silero_vad" in names:
        version = importlib.metadata.version("silero-vad")
        if version != LOCK["silero_vad"]["version"]:
            raise ValueError(f"Expected silero-vad {LOCK['silero_vad']['version']}, found {version}")
        spec = importlib.util.find_spec("silero_vad")
        source = Path(spec.origin).parent / "data" / "silero_vad.onnx"
        key = "silero_vad/silero_vad.onnx"
        target = directory / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        manifest["artifacts"][key] = {
            "path": key,
            "sha256": sha256(target),
            "bytes": target.stat().st_size,
            "package": "silero-vad",
            "version": version,
        }
    for name in names:
        manifest["models"][name] = LOCK[name]
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    temporary.replace(manifest_path)
    print(f"Prepared {', '.join(names)} at {directory}", flush=True)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", default=["sparc", "arti6", "silero_vad"])
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    prepare(args.models, args.directory)
