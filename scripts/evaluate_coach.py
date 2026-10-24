"""Replay fixtures through the coaching agent. Default mode never calls paid providers."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/api"))
from app.config import Settings
from app.evaluation import CoachingSuite, evaluate


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=ROOT / "fixtures/coaching/scenarios.json")
    parser.add_argument("--output", type=Path, default=ROOT / ".data/coaching-evaluation.json")
    parser.add_argument(
        "--live", action="store_true", help="Explicitly opt into paid Moss/Claude calls with approved cues"
    )
    args = parser.parse_args()
    suite = CoachingSuite.model_validate_json(args.input.read_text("utf-8"))
    try:
        report = asyncio.run(evaluate(suite, Settings(mock_mode=not args.live)))
    except ValueError as exc:
        raise SystemExit(str(exc))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for result in report["scenarios"]:
        print(
            f"{'PASS' if result['matches_expectation'] and not result['provider_error'] else 'FAIL'} "
            f"{result['scenario']}: {result['decision']['next_action']} / {result['decision']['observation_id']}"
        )
    print(
        f"{report['passed']}/{report['total']} expectations matched ({report['mode']}); report: {args.output}"
    )
    raise SystemExit(0 if report["passed"] == report["total"] else 1)
