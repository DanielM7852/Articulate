"""Grade stored coach captions with Claude and write a quality report (offline; never changes the live coach).

Example:
  cd backend && .venv/bin/python -m scripts.grade_coach --source local --dry-run
"""

import argparse
import asyncio
import sys
import time
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app import telemetry  # noqa: E402
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


async def _start_telemetry(settings: Settings) -> bool:
    """Configure telemetry on this loop (the script runs outside the app lifespan). Returns whether this run
    configured it, so it closes it afterwards. Already live (a host process or a test) or disabled: left alone."""
    if telemetry.enabled() or not settings.telemetry_enabled:
        return False
    try:
        telemetry.configure(settings)
        await telemetry.wait_live()  # an anonymous identity is minted in the background; wait so checker.run lands
    except Exception:  # noqa: BLE001 - telemetry never changes the run
        pass
    return True


async def _stop_telemetry(owned: bool) -> None:
    try:
        await telemetry.drain(1.5)
        if owned:
            await telemetry.aclose()
    except Exception:  # noqa: BLE001
        pass


def pass_rate(rows: list[cg.Row]) -> int | None:
    """Share (0..100) of graded captions with no failed Claude rule, or None when nothing was graded."""
    graded = [r for r in rows if r.grade is not None]
    return round(100 * sum(1 for r in graded if not r.fails) / len(graded)) if graded else None


async def run(args: argparse.Namespace, settings: Settings | None = None, client=None, spacetime=None) -> int:
    settings = settings or Settings()
    owned = await _start_telemetry(settings)
    try:
        return await _run(args, settings, client, spacetime)
    finally:
        await _stop_telemetry(owned)


async def _run(args: argparse.Namespace, settings: Settings, client, spacetime) -> int:
    source = args.source or ("spacetime" if settings.spacetime_configured else "local")
    if source == "spacetime":
        turns = await cg.load_turns_spacetime(spacetime or SpacetimeClient(settings), args.limit)
    else:
        turns = cg.load_turns_local(args.store_dir or settings.store_dir, args.limit)
    batches = len(cg.make_batches(turns, args.batch))
    print(f"source={source} turns={len(turns)} batches={batches} model={cg.DEFAULT_MODEL} effort={args.effort}")
    telemetry.emit("backend", "db", "checker.run", f"coach checker: {len(turns)} turns ({source})",
                   {"source": source, "turns": len(turns), "batches": batches, "dryRun": bool(args.dry_run),
                    "model": cg.DEFAULT_MODEL})
    if args.dry_run:
        print(f"dry run: {batches} model call(s) would be made (up to {cg.CONCURRENCY} at once); none made.")
        return 0
    if client is None and not settings.anthropic_configured:
        print("ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 1
    started = time.perf_counter()
    grades = await cg.grade_turns(turns, settings, client, effort=args.effort, batch_size=args.batch)
    telemetry.emit("backend", "db", "checker.graded", f"graded {len(grades)}/{len(turns)} captions",
                   {"graded": len(grades), "turns": len(turns), "ms": round((time.perf_counter() - started) * 1000)})
    rows = cg.build_rows(turns, grades)
    info = {"source": source, "model": cg.DEFAULT_MODEL, "effort": args.effort,
            "generated": datetime.now().isoformat(timespec="seconds")}
    path = cg.write_report(rows, info, args.out or cg.default_out_dir())
    report: dict = {"rows": len(rows)}
    rate = pass_rate(rows)
    if rate is not None:
        report["passRate"] = rate
    telemetry.emit("backend", "db", "checker.report", f"report written: {len(rows)} rows", report)
    print(f"graded {len(grades)}/{len(turns)} turns; report: {path}")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(run(parse_args())))


if __name__ == "__main__":
    main()
