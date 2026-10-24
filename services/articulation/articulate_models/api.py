"""Optional localhost HTTP boundary. The collector can also be called directly from Python."""

import os

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .audio import MAX_BYTES, AudioError
from .runner import Collector, ModelBusy


def create_app(collector: Collector | None = None) -> FastAPI:
    collector = collector or Collector(device=os.environ.get("ARTICULATION_DEVICE", "cpu"))
    app = FastAPI(title="Articulate model collector", version="1")
    app.state.collector = collector

    @app.get("/v1/articulation/models")
    async def models():
        return collector.status()

    @app.post("/v1/articulation/analyze")
    async def analyze(
        request: Request,
        models: str = "sparc,arti6,silero_vad",
        attempt_id: str | None = None,
        capture_start_monotonic_ms: float | None = None,
        time_origin_unix_ms: float | None = None,
    ):
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(413, "WAV exceeds 8 MiB")
            chunks.append(chunk)
        try:
            return await run_in_threadpool(
                collector.analyze,
                b"".join(chunks),
                names=models.split(","),
                attempt_id=attempt_id,
                capture_start_monotonic_ms=capture_start_monotonic_ms,
                time_origin_unix_ms=time_origin_unix_ms,
            )
        except ModelBusy as exc:
            raise HTTPException(503, str(exc), headers={"Retry-After": "2"}) from exc
        except AudioError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    return app


app = create_app()
