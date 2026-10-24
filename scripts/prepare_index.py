"""Explicit provisioning command; never runs inside the learner request path."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/api"))
from app.config import Settings
from app.providers import CueRepository


async def main():
    from moss import DocumentInfo, MossClient

    settings = Settings(mock_mode=False)
    if not settings.moss_project_id or not settings.moss_project_key:
        raise SystemExit("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY first")
    repo = CueRepository(settings)
    cues = [c for c in repo.cues if c.review_status == "approved"]
    if not cues:
        raise SystemExit(
            "No professionally reviewed/approved cues; refusing to index unreviewed demo content"
        )
    docs = [
        DocumentInfo(
            id=f"{target}:{c.id}",
            text=c.text,
            metadata={
                "target": target,
                "language": c.language,
                "review_status": c.review_status,
                "difficulty": c.difficulty,
                "corpus_revision": str(c.corpus_revision),
                "cue_version": str(c.version),
            },
        )
        for c in cues
        for target in c.target_ids
    ]
    client = MossClient(settings.moss_project_id, settings.moss_project_key)
    # Use a new MOSS_INDEX name for a corpus change; never mutate an active worker's loaded corpus.
    await client.create_index(settings.moss_index, docs)
    await client.load_index(settings.moss_index)
    print(f"Prepared {len(docs)} approved cue/target records in {settings.moss_index}")


if __name__ == "__main__":
    asyncio.run(main())
