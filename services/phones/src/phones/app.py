"""FastAPI service: GET /health, POST /v1/phones, WebSocket /ws/phones. Binds 127.0.0.1:8020 (see README)."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .align import resolve_symbol, score_targets, spans_to_boundaries, log_softmax
from .config import Settings
from .ctc import greedy_decode, rms
from .stream import StreamSession

log = logging.getLogger("phones.app")


def _decode_wav(data: bytes, target_sr: int) -> np.ndarray:
    import soundfile as sf

    x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != target_sr:
        from scipy.signal import resample_poly
        from math import gcd

        g = gcd(int(sr), target_sr)
        x = resample_poly(x, target_sr // g, int(sr) // g).astype(np.float32)
    return x


def create_app(recognizer=None, settings: Settings | None = None) -> FastAPI:
    """recognizer: preloaded object (tests pass a stub); otherwise loaded once at startup."""
    settings = settings or Settings()
    state: dict = {"rec": recognizer}
    lock = asyncio.Lock()  # one inference at a time

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if state["rec"] is None:
            from .engine import load_recognizer

            state["rec"] = await asyncio.to_thread(load_recognizer, settings)
            r = state["rec"]
            await asyncio.to_thread(lambda: r.logits(np.random.randn(32000).astype(np.float32) * 0.1))  # warmup
        yield

    app = FastAPI(title="articulate-phones", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_methods=["*"], allow_headers=["*"]
    )

    async def infer(wave: np.ndarray, offset_ms: float, with_frames: bool = False):
        rec = state["rec"]
        async with lock:
            t0 = time.perf_counter()
            if with_frames and hasattr(rec, "analyze"):
                phones, frames = await asyncio.to_thread(rec.analyze, wave, offset_ms)
            else:
                phones, frames = await asyncio.to_thread(rec.phones, wave, offset_ms), None
            return phones, (time.perf_counter() - t0) * 1000.0, frames

    @app.get("/health")
    async def health():
        rec = state["rec"]
        return {"ok": rec is not None, "model": rec.model_id if rec else settings.model_id,
                "engine": rec.engine_name if rec else None, "device": rec.device if rec else None}

    @app.post("/v1/phones")
    async def phones_clip(request: Request):
        rec = state["rec"]
        if rec is None:
            raise HTTPException(503, "model not loaded")
        body = await request.body()
        try:
            if "json" in request.headers.get("content-type", ""):
                payload = json.loads(body)
                body = base64.b64decode(payload.get("audio") or payload.get("wav") or payload["audioBase64"])
            wave = _decode_wav(body, settings.sample_rate)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"could not decode audio: {e}") from e
        if wave.size < settings.sample_rate * 0.1:
            raise HTTPException(400, "clip too short")
        wave = wave[: int(settings.sample_rate * settings.max_clip_s)]
        phones, ms, _ = await infer(wave, 0.0)
        return {"phones": [p.as_dict() for p in phones], "inferMs": round(ms, 2),
                "model": rec.model_id, "engine": rec.engine_name}

    @app.post("/v1/phones/score")
    async def phones_score(request: Request):
        rec = state["rec"]
        if rec is None:
            raise HTTPException(503, "model not loaded")
        try:
            payload = json.loads(await request.body())
            raw = payload.get("audioBase64") or payload.get("audio") or payload.get("wav")
            targets_in = payload.get("targets")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"invalid JSON body: {e}") from e
        if not isinstance(targets_in, list) or not targets_in or len(targets_in) > 12 \
                or not all(isinstance(t, str) for t in targets_in):
            raise HTTPException(400, "targets must be a list of 1 to 12 phone symbols")
        tok2id = {t: i for i, t in rec.id2tok.items()}
        targets = []
        for t in targets_in:
            r = resolve_symbol(t, tok2id)
            if r is None:
                raise HTTPException(400, f"unknown target phone {t!r} (not in the model vocab)")
            targets.append(r)
        try:
            wave = _decode_wav(base64.b64decode(raw), settings.sample_rate)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"could not decode audio: {e}") from e
        if wave.size < settings.sample_rate * 0.1:
            raise HTTPException(400, "clip too short")
        wave = wave[: int(settings.sample_rate * settings.max_clip_s)]
        async with lock:
            t0 = time.perf_counter()
            logits = await asyncio.to_thread(rec.logits, wave)
            ms = (time.perf_counter() - t0) * 1000.0
        lp = log_softmax(logits)
        try:
            scores, spans, total = score_targets(lp, targets, tok2id, rec.id2tok, rec.blank_id)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        bounds = spans_to_boundaries(spans, rec.frame_ms, lp.shape[0])
        out = [{"p": s.p, "startMs": round(b["startMs"], 1), "endMs": round(b["endMs"], 1),
                "peakMs": round(b["peakMs"], 1), "post": round(s.post, 4), "gop": round(s.gop, 3),
                "best": s.best, "bestPost": round(s.bestPost, 4)} for s, b in zip(scores, bounds)]
        phones = greedy_decode(logits, rec.id2tok, rec.blank_id, rec.frame_ms, 0.0)
        return {"targets": out, "phones": [p.as_dict() for p in phones], "alignLogProb": round(total, 3),
                "inferMs": round(ms, 2), "model": rec.model_id, "engine": rec.engine_name}

    @app.websocket("/ws/phones")
    async def ws_phones(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin is not None and origin not in settings.allowed_origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        rec = state["rec"]
        if rec is None:
            await ws.send_json({"type": "error", "message": "model not loaded"})
            await ws.close()
            return
        await ws.send_json({"type": "ready", "model": rec.model_id, "engine": rec.engine_name,
                            "frameMs": rec.frame_ms, "sampleRate": settings.sample_rate})
        sess = StreamSession(settings)
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    sess.push_pcm16(msg["bytes"])
                elif msg.get("text") is not None:
                    try:
                        if json.loads(msg["text"]).get("type") == "reset":
                            sess.reset()
                    except (ValueError, AttributeError):
                        await ws.send_json({"type": "error", "message": "bad text message"})
                    continue
                if sess.due():
                    sess.next_infer_at = sess.total + int(sess.sr * settings.hop_ms / 1000)
                    wave, start_ms, end_ms = sess.window()
                    if rms(wave) < settings.silence_rms:
                        out = sess.finish([], end_ms, 0.0)
                    else:
                        try:
                            phones, ms, frames = await infer(wave, start_ms, True)
                        except Exception as e:  # noqa: BLE001
                            log.exception("inference failed")
                            await ws.send_json({"type": "error", "message": f"inference failed: {e}"})
                            continue
                        out = sess.finish(phones, end_ms, ms, frames)
                    await ws.send_json(out)
        except WebSocketDisconnect:
            pass

    return app


app = create_app()
