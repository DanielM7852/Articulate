import asyncio
import hashlib
import logging
import secrets
import time
from collections import OrderedDict
from contextlib import suppress
from uuid import uuid4

from .audio import RATE, AudioCache, pack_frame, unpack_frame
from .config import Settings
from .decisions import caption_for, fallback, validate_decision
from .coaching import assess, context_from_records, excluded_cues, retry_outcome, usable
from .features import AcousticAdapter, summarize, synthetic_frame
from .persistence import Outbox
from .providers import CueRepository, Reasoner, Speech
from .schemas import Command, CueOutcome, Event, Session

logger = logging.getLogger("articulate.metrics")


class Conflict(ValueError):
    pass


class Runtime:
    def __init__(
        self,
        settings: Settings,
        repository: CueRepository,
        reasoner: Reasoner,
        outbox: Outbox,
        cache: AudioCache,
        session=None,
        token_hash=None,
        expires=None,
    ):
        self.settings, self.repository, self.reasoner = settings, repository, reasoner
        self.outbox, self.cache = outbox, cache
        self.session = session or Session()
        self.token = secrets.token_urlsafe(32)
        self.token_hash = token_hash or hashlib.sha256(self.token.encode()).hexdigest()
        self.expires = expires or time.time() + settings.session_ttl_seconds
        self.lock = asyncio.Lock()
        self.subscribers: set[asyncio.Queue] = set()
        self.audio_subscribers: set[asyncio.Queue] = set()
        self.audio_connected = False
        self.seq = 0
        self.sync_revision = 0
        self.commands = OrderedDict()
        self.attempt_id = None
        self.generation_id = None
        self.frames = []
        self.history = []
        self.outcomes = []
        self.latest_decision = None
        self.tasks: set[asyncio.Task] = set()
        self.feedback_task = None
        self.fixture_task = None
        self.audio_task = None
        self.speech = Speech(settings)
        self.sample_rate = RATE
        self.source = "synthetic"
        self.next_sample = self.next_seq = self.processed_sample = 0
        self.processed = asyncio.Event()
        self.uploads = asyncio.Queue(maxsize=8)
        self.capture_task = None
        self.cache_keys: set[str] = set()
        self.presentation_state = "ready"

    def authorized(self, token):
        return (
            time.time() < self.expires
            and isinstance(token, str)
            and secrets.compare_digest(hashlib.sha256(token.encode()).hexdigest(), self.token_hash)
        )

    def task(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def snapshot(self):
        return {
            "session": self.session.model_dump(mode="json"),
            "seq": self.seq,
            "attempt_id": str(self.attempt_id) if self.attempt_id else None,
            "generation_id": str(self.generation_id) if self.generation_id else None,
            "history": self.history[-50:],
            "outcomes": self.outcomes[-50:],
            "decision": self.latest_decision,
            "sync_revision": self.sync_revision,
            "pending_sync": self.outbox.pending(self.session.id),
            "persistence": "local outbox; SpacetimeDB disabled in mock mode"
            if self.settings.mock_mode
            else "SpacetimeDB outbox",
            "mock_mode": self.settings.mock_mode,
            "camera": "unavailable; no lip evidence",
            "cache_keys": sorted(self.cache_keys),
            "commands": list(self.commands.items())[-100:],
        }

    def save(self):
        self.outbox.save(self.session.id, self.token_hash, self.snapshot(), self.expires)

    @staticmethod
    def deliver(subscribers, item):
        for queue in list(subscribers):
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                subscribers.discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)  # disconnect slow consumer instead of replaying stale events

    def emit(self, kind, payload, durable=False):
        self.seq += 1
        event = Event(
            type=kind,
            session_id=self.session.id,
            attempt_id=self.attempt_id,
            generation_id=self.generation_id,
            seq=self.seq,
            payload=payload,
        ).model_dump(mode="json")
        if durable:
            event["payload"] = {
                **payload,
                "expected_sync_revision": self.sync_revision,
                "owner": str(self.session.owner),
            }
            self.outbox.append(event)
            self.sync_revision += 1
        self.deliver(self.subscribers, event)
        return event

    def state(self, state):
        self.session.state = state
        self.emit(
            "session.state",
            {
                "session": self.session.model_dump(mode="json"),
                "pending_sync": self.outbox.pending(self.session.id) + 1,
            },
            durable=True,
        )
        self.save()

    def metric(self, name, start, **extra):
        payload = {"stage": name, "duration_ms": round((time.perf_counter() - start) * 1000, 3), **extra}
        logger.info(
            "stage",
            extra={
                "metrics": {
                    "session_id": str(self.session.id),
                    "attempt_id": str(self.attempt_id),
                    "generation_id": str(self.generation_id),
                    **payload,
                }
            },
        )
        self.emit("metrics", payload)

    async def interrupt(self):
        generation = self.generation_id
        self.generation_id = None  # invalidate before awaiting provider cancellation
        for task in (self.feedback_task, self.fixture_task, self.capture_task):
            if task and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self.feedback_task = self.fixture_task = self.capture_task = None
        while not self.uploads.empty():
            self.uploads.get_nowait()
        if generation:
            # Clear server queues before cancellation, then signal the worklet to clear its queue.
            for queue in self.audio_subscribers:
                while not queue.empty():
                    queue.get_nowait()
            self.deliver(
                self.audio_subscribers, {"type": "audio.cancelled", "generation_id": str(generation)}
            )
            self.emit("audio.cancelled", {"cancelled_generation_id": str(generation)})

    async def command(self, cmd: Command):
        async with self.lock:
            identity = str(cmd.command_id)
            if identity in self.commands:
                self.emit("command.ack", self.commands[identity])
                return
            if cmd.expected_revision != self.session.revision:
                raise Conflict("revision conflict; recover snapshot and retry with a new command ID")
            body = cmd.payload
            kind = body.type
            if kind == "attempt.end":
                if self.session.state != "capturing":
                    raise Conflict("attempt.end requires capturing")
                if self.source == "microphone" and body.final_sample > self.next_sample + self.sample_rate:
                    raise ValueError("final sample too far ahead")
                if self.source == "microphone" and body.final_sample < self.next_sample:
                    raise ValueError("final sample precedes uploaded samples")
                if body.final_sample > self.sample_rate * 30:
                    raise ValueError("attempt exceeds 30 seconds")
                self.session.revision += 1
                self.state("analyzing")
                if self.fixture_task:
                    self.fixture_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await self.fixture_task
                self.feedback_task = self.task(self.feedback(body.final_sample))
            elif kind == "attempt.start":
                if self.session.state == "paused":
                    raise Conflict("resume before starting")
                if body.source == "microphone" and not self.audio_connected:
                    raise Conflict("negotiate the audio transport before microphone capture")
                if body.source == "synthetic" and body.sample_rate != RATE:
                    raise ValueError("synthetic fixture sample rate is 24000")
                await self.interrupt()
                self.attempt_id, self.generation_id = uuid4(), uuid4()
                self.frames = []
                self.latest_decision = None
                self.source, self.sample_rate = body.source, body.sample_rate
                self.next_sample = self.next_seq = self.processed_sample = 0
                self.processed.clear()
                self.session.revision += 1
                self.state("capturing")
                if self.source == "synthetic":
                    self.fixture_task = self.task(self.fixture())
                else:
                    self.capture_task = self.task(self.capture())
            elif kind == "session.configure":
                await self.interrupt()
                self.session.target_id = body.target_id
                self.session.audio_enabled = body.audio_enabled
                self.session.assistance_level = body.assistance_level
                self.session.revision += 1
                self.state("ready")
                self.task(self.prefetch())
            elif kind in ("feedback.cancel", "session.pause", "session.resume"):
                if kind == "session.resume" and self.session.state != "paused":
                    raise Conflict("session is not paused")
                await self.interrupt()
                self.session.revision += 1
                self.state("paused" if kind == "session.pause" else "ready")
            else:
                if body.generation_id != self.generation_id:
                    raise Conflict("obsolete playback")
                if kind == "audio.playback_ended" and self.session.state == "presenting":
                    self.session.revision += 1
                    self.state(self.presentation_state)
            ack = {"command_id": identity, "revision": self.session.revision}
            self.commands[identity] = ack
            while len(self.commands) > 100:
                self.commands.popitem(last=False)
            self.save()  # commit command identity before acknowledging it to any observer
            self.emit("command.ack", ack)
            self.save()

    async def prefetch(self):
        try:
            async with asyncio.timeout(self.settings.provider_deadline_seconds):
                await self.repository.query(self.session.target_id, history_revision=len(self.outcomes))
                if self.session.audio_enabled:
                    await self.speech.open()
        except Exception:
            self.emit("provider.status", {"provider": "prefetch", "status": "unavailable"})

    async def fixture(self):
        for index in range(125):
            if self.session.state != "capturing":
                return
            frame = synthetic_frame(self.session.target_id, index)
            self.frames.append(frame)
            self.processed_sample = self.next_sample = (index + 1) * 960
            self.emit("features.frame", frame.model_dump())
            await asyncio.sleep(0.04)
        self.emit("provider.status", {"status": "fixture complete; select Finish attempt"})

    def upload(self, data):
        ident, seq, offset, rate, pcm = unpack_frame(data, 1)
        if (
            self.source != "microphone"
            or self.session.state not in ("capturing", "analyzing")
            or ident != self.attempt_id
            or seq != self.next_seq
            or offset != self.next_sample
            or rate != self.sample_rate
            or len(pcm) // 2 > rate * 0.2
            or offset + len(pcm) // 2 > rate * 30
        ):
            raise ValueError("stale, out-of-order, oversized, or unnegotiated microphone frame")
        self.uploads.put_nowait((offset, pcm))
        self.next_seq += 1
        self.next_sample += len(pcm) // 2

    async def capture(self):
        adapter = AcousticAdapter(self.sample_rate, self.settings.formant_ceiling)
        while True:
            offset, pcm = await self.uploads.get()
            frame = await asyncio.to_thread(adapter.analyze, pcm, offset)
            self.frames.append(frame)
            self.processed_sample = offset + len(pcm) // 2
            self.processed.set()
            self.emit("features.frame", frame.model_dump())

    async def feedback(self, final_sample):
        attempt, generation = self.attempt_id, self.generation_id
        started = time.perf_counter()
        try:
            incomplete = False
            if self.source == "microphone":
                try:
                    async with asyncio.timeout(2):
                        while self.processed_sample < final_sample:
                            self.processed.clear()
                            await self.processed.wait()
                except TimeoutError:
                    incomplete = True
                    self.emit("provider.status", {"provider": "capture", "status": "incomplete upload"})
                if self.capture_task:
                    self.capture_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await self.capture_task
            end = self.processed_sample
            summary = summarize(
                attempt,
                self.session.target_id,
                self.frames,
                self.sample_rate,
                end,
                self.source,
                self.session.assistance_level,
            )
            if incomplete:
                summary.quality_flags.append("incomplete_upload")
                summary.evidence_fields = ["usable_duration_ms", "usable_fraction"]
            self.history.append(summary.model_dump(mode="json"))
            self.metric("capture_end_to_summary", started)
            self.emit("attempt.summary", summary.model_dump(mode="json"), durable=True)
            self.state("coaching")
            self.evaluate_previous_outcome(summary)
            context = context_from_records(self.history[:-1], self.outcomes, self.settings.coaching_policy)
            cues = []
            excluded = excluded_cues(summary, context)
            supported = assess(summary, context)
            t = time.perf_counter()
            try:
                async with asyncio.timeout(self.settings.provider_deadline_seconds):
                    if usable(summary, context.policy):
                        cues = await self.repository.query(
                            summary.target_id,
                            excluded=excluded,
                            history_revision=len(self.outcomes),
                            observation_text=supported[0].text,
                        )
            except Exception:
                self.emit("provider.status", {"provider": "Moss", "status": "unavailable"})
                cues = self.repository.eligible(summary.target_id, excluded=excluded)[:1]
            self.metric("retrieval", t, mode="mock" if self.settings.mock_mode else "Moss")
            t = time.perf_counter()
            try:
                async with asyncio.timeout(self.settings.provider_deadline_seconds):
                    proposed = await self.reasoner.decide(summary, generation, cues, context)
                    decision = validate_decision(
                        proposed,
                        summary,
                        generation,
                        cues,
                        context,
                        allow_demo=self.settings.mock_mode and self.settings.allow_demo_cues,
                    )
            except Exception:
                self.emit("provider.status", {"provider": "Claude", "status": "deterministic fallback"})
                decision = validate_decision(
                    fallback(summary, generation, cues, context),
                    summary,
                    generation,
                    cues,
                    context,
                    allow_demo=self.settings.mock_mode and self.settings.allow_demo_cues,
                )
            if (attempt, generation) != (self.attempt_id, self.generation_id):
                return
            self.metric("validated_decision", t, mode="mock" if self.settings.mock_mode else "Claude")
            cue = next((c for c in cues if c.id == decision.cue_id), None)
            caption = caption_for(decision, cue)
            self.latest_decision = {
                **decision.model_dump(mode="json"),
                "caption": caption,
                "cue": cue.model_dump() if cue else None,
            }
            self.emit("coach.decision", self.latest_decision, durable=True)
            self.record_outcome(summary, cue)
            if decision.next_action == "reduce_assistance":
                self.session.assistance_level = "reduced"
            elif decision.next_action == "simplify":
                self.session.assistance_level = "guided"
            self.presentation_state = "paused" if decision.next_action == "pause" else "ready"
            self.state("presenting")
            self.metric("attempt_end_to_visible_server", started)
            if cue and self.session.audio_enabled and self.audio_subscribers:
                self.audio_task = asyncio.current_task()
                await self.present_audio(caption, cue, generation)
            else:
                self.state(self.presentation_state)
            self.save()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.emit("error", {"code": "feedback_failed", "detail": type(exc).__name__})
            if generation == self.generation_id:
                self.state("ready")

    def evaluate_previous_outcome(self, summary):
        if not self.outcomes:
            return
        context = context_from_records(self.history[:-1], self.outcomes, self.settings.coaching_policy)
        updated = retry_outcome(summary, context.cue_history[-1], context)
        if updated:
            self.outcomes[-1] = updated.model_dump(mode="json")
            self.emit("provider.status", {"cue_outcome": self.outcomes[-1]}, durable=True)

    def record_outcome(self, summary, cue):
        if cue:
            self.outcomes.append(
                CueOutcome(
                    cue_id=cue.id,
                    attempt_id=summary.attempt_id,
                    target_id=summary.target_id,
                    target_version=summary.target_version,
                    source=summary.source,
                    distance=summary.target_distance,
                    result="awaiting_retry",
                    assistance_level=summary.assistance_level,
                ).model_dump(mode="json")
            )

    async def present_audio(self, text, cue, generation):
        key = self.cache.key(text, cue, self.speech.model, self.speech.voice)
        cached = self.cache.get(key)
        started = time.perf_counter()
        self.emit(
            "audio.start",
            {
                "sample_rate": RATE,
                "encoding": "pcm_s16le",
                "cache_hit": bool(cached),
                "model": self.speech.model,
                "voice": self.speech.voice,
            },
        )
        self.deliver(
            self.audio_subscribers,
            {
                "type": "audio.start",
                "generation_id": str(generation),
                "sample_rate": RATE,
                "buffer_ms": self.settings.playback_buffer_ms,
            },
        )
        seq = offset = 0
        chunks, timings = [], []
        transport_clock = time.perf_counter()

        async def send(pcm):
            nonlocal seq, offset
            for at in range(0, len(pcm), 1920):
                data = pcm[at : at + 1920]
                if not data:
                    continue
                # Keep at most 500 ms ahead of consumption. Fast TTS providers can
                # synthesize faster than real time; let WebSocket backpressure bound them.
                delay = transport_clock + offset / RATE - 0.5 - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
                self.deliver(self.audio_subscribers, pack_frame(2, generation, seq, offset, RATE, data))
                seq += 1
                offset += len(data) // 2
                await asyncio.sleep(0)

        try:
            async with asyncio.timeout(self.settings.provider_deadline_seconds):
                if cached:
                    manifest, pcm = cached
                    timings = manifest.timings
                    for timing in timings:
                        self.emit("audio.timings", timing)
                    await send(pcm)
                else:
                    async for kind, value in self.speech.stream(text, generation):
                        if generation != self.generation_id:
                            return
                        if kind == "audio":
                            if not chunks:
                                self.metric("tts_first_provider_audio", started, model=self.speech.model)
                            if sum(map(len, chunks)) + len(value) > RATE * 2 * 30:
                                raise ValueError("audio exceeds 30 second bound")
                            chunks.append(value)
                            await send(value)
                        else:
                            timings.append(value)
                            self.emit("audio.timings", value)
                    if not chunks:
                        raise ValueError("provider returned no audio")
                    self.cache.put(
                        key, text, cue, self.speech.model, self.speech.voice, b"".join(chunks), timings
                    )
                self.cache_keys.add(key)
                self.deliver(self.audio_subscribers, {"type": "audio.end", "generation_id": str(generation)})
                self.emit("audio.end", {"samples": offset, "cache_key": key})
        except asyncio.CancelledError:
            raise
        except Exception:
            self.deliver(
                self.audio_subscribers, {"type": "audio.cancelled", "generation_id": str(generation)}
            )
            self.emit(
                "provider.status", {"provider": "Cartesia", "status": "audio unavailable; captions ready"}
            )
            self.state(self.presentation_state)

    async def close(self):
        await self.interrupt()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.speech.close()


def restore(settings, repository, reasoner, outbox, cache, session_id):
    saved = outbox.recover(session_id)
    if not saved:
        return None
    token_hash, snap, expires = saved
    runtime = Runtime(
        settings,
        repository,
        reasoner,
        outbox,
        cache,
        Session.model_validate(snap["session"]),
        token_hash,
        expires,
    )
    state = "paused" if runtime.session.state == "paused" else "ready"
    runtime.session.state = state  # work and media are never replayed after a restart
    runtime.session.revision += 1
    runtime.seq, runtime.sync_revision = snap["seq"], snap["sync_revision"]
    runtime.history, runtime.outcomes = snap["history"], snap.get("outcomes", [])
    runtime.commands = OrderedDict(snap.get("commands", []))
    runtime.cache_keys = set(snap.get("cache_keys", []))
    runtime.state(state)
    return runtime
