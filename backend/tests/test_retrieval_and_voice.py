"""Cue retrieval disclosure and the Cartesia handoff example."""

import json

import httpx
import numpy as np

from app.audio.decode import decode_audio, encode_wav
from app.audio.gateway import ReferenceLibrary
from app.integrations.cartesia import build_tts_request, spoken_text
from app.integrations.cues import load_cue_library
from app.integrations.moss import CueRetriever, RetrievalQuery, plan_moss_sync
from app.schemas import CartesiaHandoff
from tests.support import make_settings


class _Doc:
    def __init__(self, doc_id: str) -> None:
        self.id = doc_id


class _Result:
    def __init__(self, ids: list[str]) -> None:
        self.docs = [_Doc(doc_id) for doc_id in ids]


class _Options:
    def __init__(self, top_k: int, filter: dict) -> None:
        self.top_k = top_k
        self.filter = filter


class _Client:
    def __init__(self, ids: list[str]) -> None:
        self.ids = ids
        self.loaded = None

    async def load_index(self, name: str) -> None:
        self.loaded = name

    async def query(self, name: str, text: str, options) -> _Result:
        assert name == "articulate-cues"
        assert "intonation_rising" in text
        assert options.top_k == 8
        return _Result(self.ids)


def test_local_fallback_is_disclosed(tmp_path):
    settings = make_settings(tmp_path)
    notice, cues = load_cue_library()
    retriever = CueRetriever(cues, notice, settings)

    import asyncio

    result = asyncio.run(
        retriever.retrieve(
            RetrievalQuery(
                exercise="intonation_rising",
                finding="ending_direction_mismatch",
                language="en",
            )
        )
    )
    assert result.info.backend == "local_fallback"
    assert result.info.disclosed_fallback is True
    assert result.info.fallback_reason == "moss_not_configured"
    assert result.cues[0].cue_id == "cue-rise-ending-draft"
    assert result.cues[0].review_status == "draft"
    assert result.info.review_notice


def test_moss_rank_is_filtered_to_the_library(tmp_path):
    settings = make_settings(tmp_path, moss_project_id="project", moss_project_key="key")
    notice, cues = load_cue_library()
    retriever = CueRetriever(
        cues,
        notice,
        settings,
        moss_client=_Client(["missing-cue", "cue-rise-ending-draft"]),
        query_options_type=_Options,
    )

    import asyncio

    result = asyncio.run(
        retriever.retrieve(
            RetrievalQuery(exercise="intonation_rising", finding="ending_direction_mismatch", language="en")
        )
    )
    assert result.info.backend == "moss"
    assert result.info.disclosed_fallback is False
    assert [cue.cue_id for cue in result.cues] == ["cue-rise-ending-draft"]


def test_moss_miss_falls_back_and_says_so(tmp_path):
    settings = make_settings(tmp_path, moss_project_id="project", moss_project_key="key")
    notice, cues = load_cue_library()

    class Broken:
        async def load_index(self, name: str) -> None:
            raise RuntimeError("network down")

    retriever = CueRetriever(cues, notice, settings, moss_client=Broken(), query_options_type=_Options)

    import asyncio

    result = asyncio.run(
        retriever.retrieve(
            RetrievalQuery(exercise="intonation_rising", finding="ending_direction_mismatch", language="en")
        )
    )
    assert result.info.backend == "local_fallback"
    assert result.info.disclosed_fallback is True
    assert result.info.fallback_reason == "moss_error:RuntimeError"
    assert result.cues[0].cue_id == "cue-rise-ending-draft"


def test_attempted_cues_are_skipped_until_the_list_is_exhausted(tmp_path):
    settings = make_settings(tmp_path)
    notice, cues = load_cue_library()
    retriever = CueRetriever(cues, notice, settings)

    import asyncio

    result = asyncio.run(
        retriever.retrieve(
            RetrievalQuery(
                exercise="intonation_rising",
                finding="ending_direction_mismatch",
                language="en",
                attempted_cue_ids=["cue-rise-ending-draft"],
            )
        )
    )
    assert result.cue_reused is True
    assert result.cues[0].cue_id == "cue-rise-ending-draft"


def test_sync_plan_does_not_call_moss():
    _notice, cues = load_cue_library()
    planned = plan_moss_sync(cues, "articulate-cues")
    assert len(planned) == len(cues)
    assert planned[0]["metadata"]["review_status"] == "draft"
    assert "instruction_text" in planned[0]["metadata"]


def test_cartesia_example_contains_only_the_short_transcript():
    handoff = CartesiaHandoff(
        session_id="session-1",
        attempt_id="attempt-1",
        status="partial",
        observation="The ending pitch movement does not match the reference example.",
        instruction="At the end of the phrase, let your pitch glide up, as in the reference example.",
        spoken_text=spoken_text(
            "The ending pitch movement does not match the reference example.",
            "At the end of the phrase, let your pitch glide up, as in the reference example.",
            "partial",
        ),
        cue_id="cue-rise-ending-draft",
        cue_review_status="draft",
        next_action="isolate_segment",
        capture_limitations=["This practice line is an unreviewed draft."],
    )
    request = build_tts_request(handoff, model_id="sonic-3.6", voice_id="voice", version="2026-08-14")
    assert request["endpoint"] == "https://api.cartesia.ai/tts/bytes"
    assert request["headers"]["Cartesia-Version"] == "2026-08-14"
    assert request["headers"]["Authorization"] == "Bearer $CARTESIA_API_KEY"
    assert request["body"]["transcript"] == handoff.spoken_text
    assert "frames" not in request["body"]
    assert "tongue" not in request["body"]["transcript"]
    assert len(request["body"]["transcript"]) < 600


def test_cartesia_reference_is_cached_and_replaces_the_harmonic(tmp_path):
    settings = make_settings(tmp_path, cartesia_api_key="sk_test", cartesia_voice_id="voice-1")
    tone = (0.2 * np.sin(2 * np.pi * 180 * np.arange(16000) / 16000)).astype(np.float64)
    wav = encode_wav(tone, 16000)
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        assert request.headers["Authorization"] == "Bearer sk_test"
        assert request.headers["Cartesia-Version"] == "2026-08-14"
        return httpx.Response(200, content=wav)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    library = ReferenceLibrary(settings, speech_client=client)
    first = library.load("intonation-rising-ready")
    second = library.load("intonation-rising-ready")
    assert first.wav_bytes == wav
    assert second is first
    assert len(seen) == 1
    assert seen[0]["transcript"] == "Are you ready?"
    assert seen[0]["voice"] == "voice-1"
    assert seen[0]["model_id"] == "sonic-3.6"
    assert "locale" not in seen[0]
    assert first.metadata.provenance.kind == "cartesia_tts"
    reloaded = ReferenceLibrary(settings, speech_client=client).load("intonation-rising-ready")
    assert reloaded.wav_bytes == wav
    assert len(seen) == 1


def test_wav_roundtrip_uses_the_file_sample_rate(tmp_path):
    settings = make_settings(tmp_path)
    tone = (0.2 * np.sin(2 * np.pi * 180 * np.arange(16000) / 16000)).astype(np.float64)
    encoded = encode_wav(tone, 16000)
    decoded, sample_rate, downmixed = decode_audio(encoded, "learner.wav", settings)
    assert sample_rate == 16000
    assert downmixed is False
    assert decoded.shape[0] == 16000
    assert float(np.max(np.abs(decoded))) < 0.5
