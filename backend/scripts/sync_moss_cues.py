"""Plan or commit the seed cue library to a Moss index.

Dry-run is the default. It prints the documents that would be upserted and does
not call Moss. Pass --commit to upsert. This script does not delete an index.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import get_settings  # noqa: E402
from app.integrations.cues import load_cue_library  # noqa: E402
from app.integrations.moss import plan_moss_sync  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync draft practice cues to Moss.")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Upsert the planned documents. Without this flag the command only prints the plan.",
    )
    parser.add_argument("--limit", type=int, default=50, help="Maximum cues to include. Default 50.")
    args = parser.parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be at least 1.")
    notice, cues = load_cue_library()
    settings = get_settings()
    planned = plan_moss_sync(cues[: args.limit], settings.moss_index_name)
    print(f"review_notice: {notice}")
    print(f"planned_upserts: {len(planned)}")
    print(json.dumps(planned, indent=2))
    if not args.commit:
        print("dry_run: no Moss request was sent.")
        return
    if not settings.moss_configured:
        raise SystemExit("MOSS_PROJECT_ID and MOSS_PROJECT_KEY are required for --commit.")
    asyncio.run(_commit(settings.moss_project_id, settings.moss_project_key, settings.moss_index_name, planned))


async def _commit(project_id: str, project_key: str, index_name: str, planned: list[dict]) -> None:
    from moss import DocumentInfo, MossClient, MutationOptions

    client = MossClient(project_id, project_key)
    documents = [
        DocumentInfo(id=item["id"], text=item["text"], metadata=item["metadata"])
        for item in planned
    ]
    try:
        result = await client.add_docs(index_name, documents, MutationOptions(upsert=True))
        print(f"committed: upserted {len(documents)} documents; job_id={getattr(result, 'job_id', None)}")
    except Exception as exc:  # noqa: BLE001 - report the provider error and stop
        try:
            result = await client.create_index(index_name, documents)
            print(f"committed: created index with {len(documents)} documents; job_id={getattr(result, 'job_id', None)}")
        except Exception as create_exc:  # noqa: BLE001
            raise SystemExit(f"Moss upsert failed: {type(exc).__name__}; create_index failed: {type(create_exc).__name__}") from create_exc


if __name__ == "__main__":
    main()
