"""Idempotent, explicit synthesis command. Real mode incurs provider usage."""

import argparse
import asyncio
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/api"))
from app.audio import AudioCache
from app.config import Settings
from app.decisions import prepared_captions
from app.providers import CueRepository, Speech


async def main(mock):
    settings = Settings(mock_mode=mock)
    repo, speech = CueRepository(settings), Speech(settings)
    cues = [c for c in repo.cues if c.review_status == "approved" or mock and settings.allow_demo_cues]
    if not cues:
        raise SystemExit("No approved cues. Audio generation refused.")
    cache = AudioCache(settings.data_dir / "audio")
    try:
        await speech.open()
        for cue, text in [(c, text) for c in cues for text in prepared_captions(c)]:
            key = cache.key(text, cue, speech.model, speech.voice)
            if cache.get(key):
                print(f"cached {cue.id}: {key}")
                continue
            pcm, timings = [], []
            async with asyncio.timeout(settings.provider_deadline_seconds):
                async for kind, data in speech.stream(text, uuid4()):
                    if kind == "audio":
                        pcm.append(data)
                    else:
                        timings.append(data)
            cache.put(key, text, cue, speech.model, speech.voice, b"".join(pcm), timings)
            print(
                f"prepared {cue.id}: {key} — {'diagnostic tone, not speech' if mock else 'AUDITION BEFORE USE'}"
            )
    finally:
        await speech.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mock", action="store_true", help="Generate diagnostic tones without paid API calls"
    )
    asyncio.run(main(parser.parse_args().mock))
