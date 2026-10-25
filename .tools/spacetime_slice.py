"""One labeled fixture through analysis and a learner-owned Spacetime commit.

The audio is the matched synthetic fixture. Progress must stay uncounted.
"""

import asyncio
import json
import urllib.request

from app.audio.gateway import fixture_wav
from app.config import Settings
from app.reasoning.orchestrate import ComparisonJob
from app.runtime import build_orchestrator


def identity() -> str:
    request = urllib.request.Request("http://127.0.0.1:3000/v1/identity", method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode())["token"]


def progress_rows(token: str) -> int:
    request = urllib.request.Request(
        "http://127.0.0.1:3000/v1/database/articulate-dev/sql",
        data=b"SELECT usable_attempts FROM my_progress",
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read().decode())
    return len(body[0]["rows"])


async def main() -> None:
    settings = Settings()
    orchestrator = build_orchestrator(settings)
    token = identity()
    metadata = orchestrator.references.metadata("intonation-rising-ready")
    job = ComparisonJob(
        session_id="slice-session",
        attempt_id="slice-attempt-1",
        reference_id="intonation-rising-ready",
        audio=fixture_wav("rising_vs_falling", metadata),
        filename="rising_vs_falling.wav",
        fixture_mode=True,
        fixture_scenario="rising_vs_falling",
        spacetime_token=token,
    )
    result = await orchestrator.compare(job)
    print("configured", orchestrator.spacetime.configured)
    print("status", result.status)
    print("finding", result.finding)
    print("fixture_mode", result.fixture_mode)
    print("delivery_id", result.feedback.delivery_id)
    print("commit_ms", result.timings_ms.spacetime_commit_ms)
    print("limitations", ",".join(result.limitations))
    print("progress_rows", progress_rows(token))


if __name__ == "__main__":
    asyncio.run(main())
