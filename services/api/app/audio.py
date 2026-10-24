"""Versioned binary PCM protocol and atomic content-addressed cache."""

import hashlib
import json
import os
import struct
from pathlib import Path
from uuid import UUID

from .schemas import AudioManifest, Cue

# magic, direction, channels, encoding, reserved, UUID, sequence, sample offset, rate, count
HEADER = struct.Struct("<4sBBBB16sIQII")
RATE = 24000
MAX_SAMPLES = 9600


def pack_frame(kind: int, identity: UUID, seq: int, offset: int, rate: int, pcm: bytes) -> bytes:
    if kind not in (1, 2) or len(pcm) % 2 or not 0 < len(pcm) // 2 <= MAX_SAMPLES:
        raise ValueError("invalid PCM frame")
    return HEADER.pack(b"VSC1", kind, 1, 1, 0, identity.bytes, seq, offset, rate, len(pcm) // 2) + pcm


def unpack_frame(data: bytes, kind: int):
    if len(data) < HEADER.size:
        raise ValueError("truncated header")
    magic, direction, channels, encoding, reserved, ident, seq, offset, rate, count = HEADER.unpack_from(data)
    if (magic, direction, channels, encoding, reserved) != (b"VSC1", kind, 1, 1, 0):
        raise ValueError("unsupported audio format or direction")
    if not 8000 <= rate <= 96000 or not 0 < count <= MAX_SAMPLES or len(data) != HEADER.size + count * 2:
        raise ValueError("invalid frame size or rate")
    return UUID(bytes=ident), seq, offset, rate, data[HEADER.size :]


class AudioCache:
    def __init__(self, path: Path):
        self.path = path
        path.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(text: str, cue: Cue, model: str, voice: str):
        properties = dict(
            text=text,
            cue_id=cue.id,
            cue_version=cue.version,
            model=model,
            voice=voice,
            language=cue.language,
            settings={"max_buffer_delay_ms": 0},
            encoding="pcm_s16le",
            sample_rate=RATE,
        )
        return hashlib.sha256(json.dumps(properties, sort_keys=True).encode()).hexdigest()

    def get(self, key: str):
        if len(key) != 64 or any(x not in "0123456789abcdef" for x in key):
            return None
        try:
            # One JSON bundle makes metadata and audio an atomic matched pair.
            import base64

            bundle = json.loads((self.path / f"{key}.json").read_text())
            manifest = AudioManifest.model_validate(bundle["manifest"])
            pcm = base64.b64decode(bundle["pcm"], validate=True)
            if not pcm or len(pcm) % 2:
                return None
            if hashlib.sha256(pcm).hexdigest() != manifest.audio_hash or manifest.cache_key != key:
                return None
            return manifest, pcm
        except (OSError, ValueError, KeyError):
            return None

    def put(self, key: str, text: str, cue: Cue, model: str, voice: str, pcm: bytes, timings: list):
        import base64
        from uuid import uuid4

        manifest = AudioManifest(
            cache_key=key,
            text_hash=hashlib.sha256(text.encode()).hexdigest(),
            cue_id=cue.id,
            cue_version=cue.version,
            model_id=model,
            voice_id=voice,
            language=cue.language,
            settings={"max_buffer_delay_ms": 0},
            audio_hash=hashlib.sha256(pcm).hexdigest(),
            audio_location=f"/api/audio/{key}",
            timings=timings,
        )
        tmp = self.path / f"{key}.{uuid4()}.tmp"
        tmp.write_text(json.dumps({"manifest": manifest.model_dump(), "pcm": base64.b64encode(pcm).decode()}))
        os.replace(tmp, self.path / f"{key}.json")
        return manifest
