"""Grade stored coach captions with Claude and write a quality report (offline; never changes the live coach).

Example:
  cd backend && .venv/bin/python -m scripts.grade_coach --source local --dry-run
"""

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import Settings  # noqa: E402
from app.integrations.spacetime import SpacetimeClient  # noqa: E402
from app.live import coach_grader as cg  # noqa: E402


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", choices=("local", "spacetime"), default=None)
    p.add_argument("--store-dir", default=None)
    p.add_argument("--limit", type=int, default=cg.DEFAULT_LIMIT)
    p.add_argument("--batch", type=int, default=cg.DEFAULT_BATCH)
    p.add_argument("--effort", default=cg.DEFAULT_EFFORT, choices=("low", "medium", "high", "xhigh", "max"))
    p.add_argument("--out", default=None)
    p.add_argument("--dry-run", action="store_true", help="load and count turns and batches; no model calls")
    return p.parse_args(argv)


async def run(args: argparse.Namespace, settings: Settings | None = None, client=None, spacetime=None) -> int:
    settings = settings or Settings()
    source = args.source or ("spacetime" if settings.spacetime_configured else "local")
    if source == "spacetime":
        turns = await cg.load_turns_spacetime(spacetime or SpacetimeClient(settings), args.limit)
    else:
        turns = cg.load_turns_local(args.store_dir or settings.store_dir, args.limit)
    batches = len(cg.make_batches(turns, args.batch))
    print(f"source={source} turns={len(turns)} batches={batches} model={cg.DEFAULT_MODEL} effort={args.effort}")
    if args.dry_run:
        print(f"dry run: {batches} model call(s) would be made (up to {cg.CONCURRENCY} at once); none made.")
        return 0
    if client is None and not settings.anthropic_configured:
        print("ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 1
    grades = await cg.grade_turns(turns, settings, client, effort=args.effort, batch_size=args.batch)
    rows = cg.build_rows(turns, grades)
    info = {"source": source, "model": cg.DEFAULT_MODEL, "effort": args.effort,
            "generated": datetime.now().isoformat(timespec="seconds")}
    path = cg.write_report(rows, info, args.out or cg.default_out_dir())
    print(f"graded {len(grades)}/{len(turns)} turns; report: {path}")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(run(parse_args())))


if __name__ == "__main__":
    main()
