"""Direct provider adapters. Ordinary tests and MOCK_MODE never contact these services."""

import asyncio
import base64
import json
import math
import struct
from uuid import uuid4
from pathlib import Path

from anthropic import AsyncAnthropic
from websockets.asyncio.client import connect

from .audio import RATE
from .config import ROOT, Settings
from .decisions import fallback, resolve_proposal
from .coaching import plan
from .schemas import (
    CORPUS_REVISION,
    TARGETS,
    AttemptSummary,
    CoachingContext,
    CoachingProposal,
    Cue,
    VisionKeyframe,
)


class CueRepository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.cues = [
            Cue.model_validate(c) for c in json.loads((ROOT / "content/cues/cues.json").read_text("utf-8"))
        ]
        self.client = None
        self.ready = settings.mock_mode
        self.cache = {}

    def eligible(self, target, language="en", difficulty="simple", excluded=(), revision=CORPUS_REVISION):
        statuses = {"approved"}
        if self.settings.mock_mode and self.settings.allow_demo_cues:
            statuses.add("demo_unreviewed")
        return [
            c
            for c in self.cues
            if target in c.target_ids
            and c.language == language
            and c.difficulty == difficulty
            and c.review_status in statuses
            and c.corpus_revision == revision
            and c.id not in excluded
            and c.pose_id == TARGETS[target].pose_id
        ]

    async def startup(self):
        if self.settings.mock_mode:
            return
        if not self.settings.moss_project_id or not self.settings.moss_project_key:
            raise ValueError("Moss credentials missing")
        from moss import MossClient

        self.client = MossClient(self.settings.moss_project_id, self.settings.moss_project_key)
        await self.client.load_index(self.settings.moss_index)
        await self.query("i")
        self.ready = True

    async def query(
        self, target, excluded=(), history_revision=0, observation_text="usable acoustic capture"
    ):
        eligible = self.eligible(target, excluded=excluded)
        key = (
            target,
            1,
            "en",
            "simple",
            CORPUS_REVISION,
            history_revision,
            tuple(sorted(excluded)),
            observation_text,
        )
        if key in self.cache:
            return self.cache[key]
        if self.settings.mock_mode:
            found = eligible[:3]
        else:
            if self.client is None:
                raise RuntimeError("Moss unavailable")
            from moss import QueryOptions

            # Overfetch the entire small corpus; validate all metadata against the canonical registry.
            # This also rejects stale index text, rather than trusting similarity as appropriateness.
            result = await self.client.query(
                self.settings.moss_index,
                f"English {target} vowel. {observation_text} Simple practice cue.",
                QueryOptions(
                    top_k=max(3, len(self.cues)),
                    filter={
                        "$and": [
                            {"field": "target", "condition": {"$eq": target}},
                            {"field": "language", "condition": {"$eq": "en"}},
                            {"field": "review_status", "condition": {"$eq": "approved"}},
                            {"field": "difficulty", "condition": {"$eq": "simple"}},
                            {"field": "corpus_revision", "condition": {"$eq": str(CORPUS_REVISION)}},
                        ]
                    },
                ),
            )
            by_id = {c.id: c for c in eligible}
            found = []
            for doc in result.docs:
                # Index docs use target:id to allow cues applicable to multiple targets.
                cue = by_id.get(doc.id.removeprefix(f"{target}:"))
                metadata = doc.metadata or {}
                if (
                    cue
                    and cue.text == doc.text
                    and metadata.get("corpus_revision") == str(cue.corpus_revision)
                    and metadata.get("cue_version") == str(cue.version)
                    and metadata.get("target") == target
                    and metadata.get("language") == cue.language
                    and metadata.get("review_status") == "approved"
                    and metadata.get("difficulty") == cue.difficulty
                ):
                    found.append(cue)
            found = found[:3]
        if len(self.cache) > 128:
            self.cache.clear()
        self.cache[key] = found
        return found

    async def close(self):
        if self.client:
            await self.client.close()


class Reasoner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.system_prompt = (Path(__file__).parent / "prompts/coach_system.txt").read_text("utf-8")
        self.calls = 0
        self.client = None
        if not settings.mock_mode and settings.anthropic_api_key:
            self.client = AsyncAnthropic(
                api_key=settings.anthropic_api_key, max_retries=0, timeout=settings.provider_deadline_seconds
            )

    async def decide(
        self,
        summary: AttemptSummary,
        generation,
        cues: list[Cue],
        context: CoachingContext,
        keyframes: list[VisionKeyframe] | None = None,
    ):
        if not isinstance(context, CoachingContext):
            raise TypeError("CoachingContext is required; pass typed attempt and cue history")
        if len(cues) > 3:
            raise ValueError("At most three eligible cue candidates are allowed")
        statuses = (
            {"approved", "demo_unreviewed"}
            if self.settings.mock_mode and self.settings.allow_demo_cues
            else {"approved"}
        )
        if any(
            c.review_status not in statuses
            or c.corpus_revision != CORPUS_REVISION
            or summary.target_id not in c.target_ids
            or c.language != "en"
            or c.pose_id != TARGETS[summary.target_id].pose_id
            for c in cues
        ):
            raise ValueError("Ineligible cue candidates")
        options = plan(summary, context, cues)
        if self.settings.mock_mode or options.preferred_action in ("repair_capture", "pause"):
            return fallback(
                summary, generation, cues, context, source="mock" if self.settings.mock_mode else "fallback"
            )
        if not self.client or not self.settings.claude_model:
            raise RuntimeError("Claude key/model missing")
        self.calls += 1
        payload = json.dumps(
            {
                "summary": summary.model_dump(mode="json"),
                "generation_id": str(generation),
                "attempt_id": str(summary.attempt_id),
                "plan": options.model_dump(mode="json"),
                "cues": [c.model_dump() for c in cues],
                "recent_outcomes": [o.model_dump(mode="json") for o in context.cue_history[-4:]],
                "policy_version": context.policy.version,
            }
        )
        content: str | list[dict] = payload
        if keyframes:
            # Optional mouth keyframes are supplementary context; the controller still resolves all wording.
            content = [{"type": "text", "text": payload}]
            for kf in keyframes[:3]:
                content.append({"type": "text", "text": f"Mouth keyframe '{kf.label}' at {round(kf.timestamp_ms)} ms:"})
                content.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": kf.mime_type, "data": kf.data_base64},
                    }
                )
        response = await self.client.messages.parse(
            model=self.settings.claude_model,
            max_tokens=450,
            output_format=CoachingProposal,
            system=self.system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": content,
                }
            ],
        )
        if response.parsed_output is None:
            raise ValueError("Claude refusal or empty result")
        proposal = CoachingProposal.model_validate(response.parsed_output)
        return resolve_proposal(proposal, summary, generation, cues, context)

    async def close(self):
        if self.client:
            await self.client.close()


class Speech:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.ws = None
        self.connect_lock = asyncio.Lock()

    @property
    def model(self):
        return "mock-diagnostic-tone-v1" if self.settings.mock_mode else self.settings.cartesia_model

    @property
    def voice(self):
        return "no-speech" if self.settings.mock_mode else self.settings.cartesia_voice

    async def open(self):
        async with self.connect_lock:
            await self._open()

    async def _open(self):
        if self.settings.mock_mode or self.ws is not None:
            return
        if not all((self.settings.cartesia_api_key, self.model, self.voice)):
            raise RuntimeError("Cartesia key/model/voice missing")
        self.ws = await connect(
            "wss://api.cartesia.ai/tts/websocket",
            additional_headers={
                "X-API-Key": self.settings.cartesia_api_key,
                "Cartesia-Version": self.settings.cartesia_version,
            },
            max_size=2**20,
            max_queue=8,
            open_timeout=5,
        )

    async def stream(self, text: str, generation):
        if self.settings.mock_mode:
            # 720 ms quiet diagnostic tone; not synthetic speech or a pronunciation example.
            for chunk in range(18):
                await asyncio.sleep(0.025)
                pcm = b"".join(
                    struct.pack("<h", int(1200 * math.sin(2 * math.pi * 330 * n / RATE)))
                    for n in range(chunk * 960, (chunk + 1) * 960)
                )
                yield "audio", pcm
            return
        await self.open()
        context = str(uuid4())
        complete = False
        try:
            await self.ws.send(
                json.dumps(
                    {
                        "model_id": self.model,
                        "voice": {"mode": "id", "id": self.voice},
                        "transcript": text,
                        "language": "en",
                        "context_id": context,
                        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE},
                        "add_timestamps": True,
                        "max_buffer_delay_ms": 0,
                        "continue": False,
                    }
                )
            )
            while True:
                message = json.loads(await self.ws.recv())
                if message.get("context_id") != context:
                    continue
                if message.get("type") == "error":
                    raise RuntimeError("Cartesia returned an error")
                if message.get("type") == "chunk":
                    yield "audio", base64.b64decode(message["data"], validate=True)
                if message.get("type") in ("timestamps", "phoneme_timestamps"):
                    yield (
                        "timings",
                        {
                            "kind": message["type"],
                            "offset_unit": "seconds",
                            "values": message.get("word_timestamps", message.get("phoneme_timestamps")),
                        },
                    )
                if message.get("done"):
                    complete = True
                    break
        finally:
            if not complete:
                # Closing also prevents an interrupted recv from leaving stale chunks on the reusable socket.
                try:
                    await self.ws.send(json.dumps({"context_id": context, "cancel": True}))
                finally:
                    await self.close()

    async def close(self):
        if self.ws:
            await self.ws.close()
            self.ws = None
