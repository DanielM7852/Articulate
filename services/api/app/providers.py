"""Direct provider adapters. Ordinary tests and MOCK_MODE never contact these services."""

import asyncio
import base64
import json
import math
import struct
from uuid import uuid4

from anthropic import AsyncAnthropic
from websockets.asyncio.client import connect

from .audio import RATE
from .config import ROOT, Settings
from .decisions import fallback, observation, visual_observation
from .schemas import AttemptSummary, CoachingDecision, Cue, VisionKeyframe


class CueRepository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.cues = [
            Cue.model_validate(c) for c in json.loads((ROOT / "content/cues/cues.json").read_text("utf-8"))
        ]
        self.client = None
        self.ready = settings.mock_mode
        self.cache = {}

    def eligible(self, target, language="en", difficulty="simple", excluded=(), revision=1):
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

    async def query(self, target, excluded=(), history_revision=0):
        eligible = self.eligible(target, excluded=excluded)
        key = (target, 1, "en", "simple", 1, history_revision, tuple(sorted(excluded)))
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
                f"English {target} vowel usable acoustic capture simple practice cue",
                QueryOptions(
                    top_k=max(3, len(self.cues)),
                    filter={
                        "$and": [
                            {"field": "target", "condition": {"$eq": target}},
                            {"field": "language", "condition": {"$eq": "en"}},
                            {"field": "review_status", "condition": {"$eq": "approved"}},
                            {"field": "difficulty", "condition": {"$eq": "simple"}},
                            {"field": "corpus_revision", "condition": {"$eq": "1"}},
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
        history: list,
        keyframes: list[VisionKeyframe] | None = None,
    ):
        if self.settings.mock_mode or not cues or "target_distance" not in summary.evidence_fields:
            return fallback(summary, generation, cues)
        if not self.client or not self.settings.claude_model:
            raise RuntimeError("Claude key/model missing")
        payload = {
            "summary": summary.model_dump(mode="json"),
            "generation_id": str(generation),
            "observation": observation(summary),
            "cues": [c.model_dump() for c in cues],
            "recent_outcomes": history[-4:],
        }
        vis_obs = visual_observation(summary)
        if vis_obs is not None:
            payload["visual_observation"] = vis_obs

        if keyframes:
            content: str | list[dict] = [{"type": "text", "text": json.dumps(payload)}]
            for kf in keyframes[:3]:
                content.append(
                    {
                        "type": "text",
                        "text": f"Mouth keyframe '{kf.label}' at {round(kf.timestamp_ms)} ms:",
                    }
                )
                content.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": kf.mime_type,
                            "data": kf.data_base64,
                        },
                    }
                )
        else:
            content = json.dumps(payload)

        response = await self.client.messages.parse(
            model=self.settings.claude_model,
            max_tokens=450,
            output_format=CoachingDecision,
            system="Select exactly one eligible cue using acoustic features, MediaPipe CV lip/jaw telemetry, "
            "and any supplied mouth keyframe images. Do not rewrite instructions. Copy the provided "
            "observation (and visual_observation when present) verbatim; narration must be null. Cite only "
            "supplied evidence fields. Allowed next action: repeat, change_cue, simplify, reduce_assistance, "
            "pause. Never infer hidden internal anatomy or diagnose.",
            messages=[
                {
                    "role": "user",
                    "content": content,
                }
            ],
        )
        if response.parsed_output is None:
            raise ValueError("Claude refusal or empty result")
        return response.parsed_output

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
