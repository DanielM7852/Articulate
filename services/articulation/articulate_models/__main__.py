import argparse
import json
from pathlib import Path

from .prepare import prepare
from .runner import Collector


def main():
    parser = argparse.ArgumentParser(
        description="Collect pretrained articulation data without a coaching agent"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("prepare", help="Explicitly download pinned model weights")
    download.add_argument("--models", nargs="+", default=["sparc", "arti6", "silero_vad"])
    download.add_argument("--directory", type=Path)
    analyze = commands.add_parser("analyze", help="Analyze a WAV and write model observations")
    analyze.add_argument("wav", type=Path)
    analyze.add_argument("--output", type=Path, required=True)
    analyze.add_argument("--models", nargs="+", default=["sparc", "arti6", "silero_vad"])
    analyze.add_argument("--directory", type=Path)
    analyze.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    analyze.add_argument(
        "--strict",
        action="store_true",
        help="Nonzero exit if any requested model does not return observations",
    )
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.models, args.directory)
        return
    bundle = Collector(args.directory, args.device).analyze(args.wav.read_bytes(), names=args.models)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(bundle, allow_nan=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "models": {key: result["status"] for key, result in bundle["models"].items()},
                "totalMs": bundle["totalMs"],
            }
        )
    )
    if args.strict and any(result["status"] != "ok" for result in bundle["models"].values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
