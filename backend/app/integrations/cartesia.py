"""Cartesia speech for the prepared reference, plus the coaching handoff example.

The comparison path speaks the reference transcript through the bytes endpoint
when a key is configured. It still does not open a voice agent. The coaching
handoff remains a request example: this module does not send that transcript.
"""

import hashlib
import json
from pathlib import Path

import httpx

from app.config import Settings
from app.errors import ArticulateError
from app.schemas import CartesiaHandoff

TTS_BYTES_URL = "https://api.cartesia.ai/tts/bytes"
REFERENCE_SAMPLE_RATE_HZ = 44100

_LIMITATION_TEXT = {
    "content_verifier_not_configured": "The words in this recording were not checked.",
    "content_mismatch": "The recording did not pass a content check.",
    "selected_cue_is_unreviewed_draft": "This practice line is an unreviewed draft.",
    "reasoning_timeout": "Coaching timed out, so a prepared cue was used.",
    "anthropic_not_configured": "Automatic coaching was unavailable, so a prepared cue was used.",
    "invalid_model_output": "The coaching response was rejected, so a prepared cue was used.",
    "local_retrieval_fallback": "Cue search used the local draft library.",
    "suspected_octave_error": "Part of the pitch track looked like an octave error and was left out.",
    "clipping": "The recording may be clipped.",
    "implausible_pitch_jump": "The pitch track had an implausible jump.",
    "alignment_failed": "The recordings could not be lined up reliably.",
    "fixture_mode_synthetic_audio": "This result used synthetic fixture audio.",
    "cue_reused_after_history_exhausted": "This cue was used again because the other matches were already tried.",
    "reference_metadata_version_mismatch": "The stored reference metadata used a different analysis version.",
}


def spoken_text(observation: str, instruction: str, status: str) -> str:
    if status in {"insufficient_audio", "failed"}:
        return instruction.strip()[:600]
    return f"{observation.strip()} {instruction.strip()}".strip()[:600]


def capture_limitation_notes(codes: list[str]) -> list[str]:
    notes = []
    for code in codes:
        text = _LIMITATION_TEXT.get(code)
        if text and text not in notes:
            notes.append(text)
        if len(notes) == 6:
            break
    return notes


def tts_request_body(
    transcript: str,
    *,
    model_id: str,
    voice_id: str,
    sample_rate: int = REFERENCE_SAMPLE_RATE_HZ,
    speed: float | None = None,
) -> dict:
    """Bytes-endpoint body. Send language or locale, never both."""

    body = {
        "model_id": model_id,
        "transcript": transcript,
        "voice": voice_id or "VOICE_ID",
        "output_format": {
            "container": "wav",
            "encoding": "pcm_s16le",
            "sample_rate": sample_rate,
        },
        "language": "en",
    }
    if speed is not None and abs(speed - 1.0) > 0.01:
        body["generation_config"] = {"speed": speed}
    return body


def build_tts_request(handoff: CartesiaHandoff, *, model_id: str, voice_id: str, version: str) -> dict:
    """Return the coaching bytes-endpoint example. The key is not inserted and this is not sent."""

    return {
        "endpoint": TTS_BYTES_URL,
        "headers": {
            "Authorization": "Bearer $CARTESIA_API_KEY",
            "Cartesia-Version": version,
            "Content-Type": "application/json",
        },
        "body": tts_request_body(handoff.spoken_text, model_id=model_id, voice_id=voice_id),
        "handoff": handoff.model_dump(),
    }


def synthesize_wav(
    transcript: str,
    *,
    api_key: str,
    voice_id: str,
    model_id: str,
    version: str,
    timeout_s: float,
    client: httpx.Client | None = None,
    speed: float | None = None,
) -> bytes:
    """Speak one transcript and return WAV bytes. The caller caches the reference clip."""

    body = tts_request_body(transcript, model_id=model_id, voice_id=voice_id, speed=speed)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cartesia-Version": version,
        "Content-Type": "application/json",
    }
    owns_client = client is None
    active = client or httpx.Client(timeout=timeout_s)
    try:
        try:
            response = active.post(TTS_BYTES_URL, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise ArticulateError(
                "cartesia_tts_failed",
                "Cartesia did not return reference audio.",
                status_code=502,
            ) from exc
    finally:
        if owns_client:
            active.close()
    if response.status_code != 200 or not response.content.startswith(b"RIFF"):
        raise ArticulateError(
            "cartesia_tts_failed",
            "Cartesia did not return reference audio.",
            status_code=502,
        )
    return response.content


def cached_speech_wav(settings: Settings, text: str, *, speed: float | None = None, client: httpx.Client | None = None) -> bytes:
    """Speak a practice-screen line and reuse the WAV for the same text and voice."""

    voice_id = settings.resolved_cartesia_voice_id or ""
    cache_key = {
        "text": text,
        "voice_id": voice_id,
        "model_id": settings.cartesia_model_id,
        "version": settings.cartesia_version,
        "speed": None if speed is None else round(speed, 2),
    }
    digest = hashlib.sha256(json.dumps(cache_key, sort_keys=True).encode()).hexdigest()[:16]
    cache_path = Path(settings.store_dir) / "speech" / f"{digest}.wav"
    if cache_path.is_file():
        return cache_path.read_bytes()
    wav = synthesize_wav(
        text,
        api_key=settings.cartesia_api_key or "",
        voice_id=voice_id,
        model_id=settings.cartesia_model_id,
        version=settings.cartesia_version,
        timeout_s=settings.audio_timeout_s,
        client=client,
        speed=speed,
    )
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(wav)
    return wav
