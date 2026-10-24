import asyncio
import hashlib
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager, suppress
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import ValidationError

from .audio import AudioCache
from .config import Settings
from .controller import Conflict, Runtime, restore
from .persistence import Outbox
from .providers import CueRepository, Reasoner
from .decisions import prepared_captions
from .schemas import TARGETS, Command, VisionKeyframe, VisionMetrics


class JsonLog(logging.Formatter):
    def format(self, record):
        return json.dumps(
            {"level": record.levelname, "event": record.getMessage(), **getattr(record, "metrics", {})}
        )


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    sessions = {}
    repository = CueRepository(settings)
    reasoner = Reasoner(settings)
    readiness = {"retrieval": "starting"}

    @asynccontextmanager
    async def lifespan(app):
        handler = logging.StreamHandler()
        handler.setFormatter(JsonLog())
        log = logging.getLogger("articulate.metrics")
        log.addHandler(handler)
        log.setLevel(logging.INFO)
        outbox = Outbox(settings)
        cache = AudioCache(settings.data_dir / "audio")
        app.state.outbox, app.state.cache = outbox, cache
        try:
            async with asyncio.timeout(settings.provider_deadline_seconds):
                await repository.startup()
            readiness["retrieval"] = "mock" if settings.mock_mode else "ready"
        except Exception as exc:
            readiness["retrieval"] = f"unavailable: {type(exc).__name__}"
        pending_counts = {}

        def report_sync():
            for identity, runtime in sessions.items():
                count = outbox.pending(identity)
                if pending_counts.get(identity) != count:
                    runtime.emit(
                        "provider.status",
                        {
                            "provider": "persistence",
                            "pending_sync": count,
                            "mode": "local_outbox" if settings.mock_mode else "SpacetimeDB",
                        },
                    )
                    pending_counts[identity] = count

        worker = asyncio.create_task(outbox.run(report_sync))

        async def reap():
            while True:
                await asyncio.sleep(30)
                for identity, runtime in list(sessions.items()):
                    if runtime.expires <= time.time():
                        await runtime.close()
                        for subscribers in (runtime.subscribers, runtime.audio_subscribers):
                            runtime.deliver(subscribers, None)
                        sessions.pop(identity, None)

        reaper = asyncio.create_task(reap())
        yield
        reaper.cancel()
        worker.cancel()
        await asyncio.gather(reaper, worker, return_exceptions=True)
        for runtime in sessions.values():
            await runtime.close()
        await reasoner.close()
        await repository.close()
        outbox.close()
        log.removeHandler(handler)

    app = FastAPI(title="Articulate backbone", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def get_runtime(session_id, token):
        runtime = sessions.get(session_id)
        if not runtime:
            saved = app.state.outbox.recover(session_id)
            digest = hashlib.sha256((token or "").encode()).hexdigest()
            if not saved or not secrets.compare_digest(digest, saved[0]):
                raise HTTPException(404, "session not found")
            runtime = restore(settings, repository, reasoner, app.state.outbox, app.state.cache, session_id)
            sessions[session_id] = runtime
        if not runtime.authorized(token):
            raise HTTPException(404, "session not found")
        return runtime

    def bearer(request):
        auth = request.headers.get("authorization", "")
        return auth.removeprefix("Bearer ") if auth.startswith("Bearer ") else None

    def check_origin(headers):
        origin = headers.get("origin")
        if origin and origin not in settings.allowed_origins:
            raise HTTPException(403, "origin not allowed")

    @app.get("/health/live")
    async def live():
        return {"status": "alive"}

    @app.get("/health/ready")
    async def ready():
        providers = {
            **readiness,
            "claude": "mock"
            if settings.mock_mode
            else "configured"
            if settings.anthropic_api_key and settings.claude_model
            else "missing configuration",
            "cartesia": "mock diagnostic tone"
            if settings.mock_mode
            else "configured, unauditioned"
            if settings.cartesia_api_key and settings.cartesia_model and settings.cartesia_voice
            else "missing configuration",
            "spacetimedb": "disabled; local outbox only"
            if settings.mock_mode
            else "configured, unverified"
            if settings.spacetimedb_database and settings.spacetimedb_token
            else "missing configuration",
            "vision": "MediaPipe Face Landmarker (browser worker + keyframe multimodal)",
        }
        ok = settings.mock_mode or (
            repository.ready
            and all("missing" not in v for v in providers.values())
            and any(c.review_status == "approved" for c in repository.cues)
        )
        return Response(
            json.dumps({"ready": ok, "mock_mode": settings.mock_mode, "providers": providers}),
            status_code=200 if ok else 503,
            media_type="application/json",
        )

    @app.post("/api/sessions", status_code=201)
    async def create(request: Request):
        check_origin(request.headers)
        if len(sessions) >= 100:
            raise HTTPException(429, "local demo session limit reached")
        runtime = Runtime(settings, repository, reasoner, app.state.outbox, app.state.cache)
        sessions[runtime.session.id] = runtime
        runtime.state("ready")
        return {
            "session_id": str(runtime.session.id),
            "capability": runtime.token,
            "events_url": f"/api/sessions/{runtime.session.id}/events",
            "audio_url": f"/api/sessions/{runtime.session.id}/audio",
            "snapshot": runtime.snapshot(),
            "targets": [t.model_dump() for t in TARGETS.values()],
        }

    @app.get("/api/sessions/{session_id}/snapshot")
    async def snapshot(session_id: UUID, request: Request):
        return get_runtime(session_id, bearer(request)).snapshot()

    @app.post("/api/sessions/{session_id}/vision")
    async def upload_vision(session_id: UUID, request: Request):
        check_origin(request.headers)
        runtime = get_runtime(session_id, bearer(request))
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid vision payload")
        frame = VisionMetrics.model_validate(body["frame"]) if body.get("frame") else None
        keyframes = [VisionKeyframe.model_validate(k) for k in body.get("keyframes", [])[:4]]
        runtime.ingest_vision(frame=frame, keyframes=keyframes)
        return {
            "status": "ok",
            "vision_frames": len(runtime.vision_frames),
            "keyframes": len(runtime.keyframes),
        }

    @app.get("/api/audio/{cache_key}")
    async def cached_audio(cache_key: str, session_id: UUID, request: Request):
        runtime = get_runtime(session_id, bearer(request))
        if cache_key not in runtime.cache_keys:
            raise HTTPException(404, "audio not found")
        cached = app.state.cache.get(cache_key)
        if not cached:
            raise HTTPException(404, "audio not found")
        _, pcm = cached
        return Response(
            pcm, media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=3600"}
        )

    @app.get("/api/sessions/{session_id}/preload")
    async def preload(session_id: UUID, request: Request):
        runtime = get_runtime(session_id, bearer(request))
        manifests = []
        for cue, text in [
            (c, text) for c in repository.eligible(runtime.session.target_id) for text in prepared_captions(c)
        ]:
            key = app.state.cache.key(text, cue, runtime.speech.model, runtime.speech.voice)
            cached = app.state.cache.get(key)
            if cached:
                manifests.append(cached[0].model_dump())
                runtime.cache_keys.add(key)
        runtime.save()
        return {"manifests": manifests}

    async def authenticate(ws, session_id):
        check_origin(ws.headers)
        await ws.accept()
        async with asyncio.timeout(5):
            first = await ws.receive_text()
        if len(first) > 1024:
            raise ValueError("auth message too large")
        auth = json.loads(first)
        if not isinstance(auth, dict) or not isinstance(auth.get("capability"), str):
            raise ValueError("invalid capability message")
        return get_runtime(session_id, auth["capability"])

    async def pump(ws, queue):
        while True:
            item = await queue.get()
            if item is None:
                await ws.close(code=1013, reason="slow consumer or expired session")
                return
            if isinstance(item, bytes):
                await ws.send_bytes(item)
            else:
                await ws.send_json(item)

    @app.websocket("/api/sessions/{session_id}/events")
    async def events(ws: WebSocket, session_id: UUID):
        runtime = None
        queue = asyncio.Queue(maxsize=128)
        sender = None
        try:
            runtime = await authenticate(ws, session_id)
            runtime.subscribers.add(queue)
            await ws.send_json({"type": "snapshot", "payload": runtime.snapshot()})
            sender = asyncio.create_task(pump(ws, queue))
            while True:
                raw = await ws.receive_text()
                if len(raw) > 524288 or time.time() >= runtime.expires:
                    raise ValueError("expired session or oversized command")
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and parsed.get("type") == "vision.telemetry":
                        vf = VisionMetrics.model_validate(parsed["frame"]) if parsed.get("frame") else None
                        kfs = [VisionKeyframe.model_validate(k) for k in parsed.get("keyframes", [])[:4]]
                        runtime.ingest_vision(frame=vf, keyframes=kfs)
                        continue
                    command = Command.model_validate(parsed)
                    await runtime.command(command)
                except (ValueError, ValidationError, Conflict) as exc:
                    runtime.emit(
                        "error",
                        {
                            "code": "command_rejected",
                            "detail": str(exc)[:250],
                            "revision": runtime.session.revision,
                        },
                    )
        except (WebSocketDisconnect, HTTPException, TimeoutError, ValueError, KeyError):
            with suppress(Exception):
                await ws.close(code=1008)
        finally:
            if sender:
                sender.cancel()
                with suppress(asyncio.CancelledError):
                    await sender
            if runtime:
                runtime.subscribers.discard(queue)
                if not runtime.subscribers:
                    async with runtime.lock:
                        await runtime.interrupt()
                        runtime.state("paused" if runtime.session.state == "paused" else "ready")
                    await runtime.speech.close()

    @app.websocket("/api/sessions/{session_id}/audio")
    async def audio(ws: WebSocket, session_id: UUID):
        runtime = None
        sender = None
        queue = asyncio.Queue(maxsize=64)
        claimed = False
        try:
            runtime = await authenticate(ws, session_id)
            if runtime.audio_connected:
                raise ValueError("only one audio transport per session")
            negotiation = json.loads(await asyncio.wait_for(ws.receive_text(), 5))
            if not isinstance(negotiation, dict):
                raise ValueError("invalid negotiation")
            if (negotiation.get("encoding"), negotiation.get("channels")) != ("pcm_s16le", 1):
                raise ValueError("only mono pcm_s16le supported")
            runtime.audio_connected = True
            claimed = True
            runtime.audio_subscribers.add(queue)
            await ws.send_json(
                {
                    "type": "audio.ready",
                    "upload_rates": [8000, 96000],
                    "playback_rate": 24000,
                    "header_bytes": 44,
                    "encoding": "pcm_s16le",
                }
            )
            sender = asyncio.create_task(pump(ws, queue))
            while True:
                data = await ws.receive_bytes()
                if time.time() >= runtime.expires:
                    raise ValueError("session expired")
                runtime.upload(data)
        except (WebSocketDisconnect, HTTPException, TimeoutError, ValueError, KeyError, asyncio.QueueFull):
            with suppress(Exception):
                await ws.close(code=1008)
        finally:
            if sender:
                sender.cancel()
                with suppress(asyncio.CancelledError):
                    await sender
            if runtime and claimed:
                runtime.audio_subscribers.discard(queue)
                runtime.audio_connected = False

    return app


app = create_app()
