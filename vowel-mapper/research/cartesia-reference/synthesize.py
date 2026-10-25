"""Generate the Cartesia reference words for the voice-reference test.

Usage: python3 -I synthesize.py <out-dir> [stretched]
"stretched" asks for held vowels with drawn-out spellings instead of plain words.
Reads CARTESIA_API_KEY (and optional CARTESIA_VOICE_ID) from /Users/Git/Articulate-overnight/.env.
Never prints the key. Request format mirrors backend/app/integrations/cartesia.py on origin/main.
Writes <word>-<take>.wav as 48 kHz mono PCM16 (the tracker's offline input format).
"""

import json, pathlib, subprocess, sys, urllib.request

ENV = pathlib.Path("/Users/Git/Articulate-overnight/.env")
WORDS = {w: w for w in ["head", "had", "heard", "see", "spa"]}
SPEEDS = [0.7, 0.85, 1.0]
# File stem -> transcript. Stems keep the analysis script's word names; the take label marks the spelling.
STRETCHED = {"head-e1": "ehhhhhhh", "head-e2": "heeehhhhd", "had-a1": "aaaaaahd", "had-a2": "haaaaaad",
             "heard-r1": "errrrrrr", "heard-r2": "heeerrrrd", "see-i1": "eeeeeeee", "see-i2": "seeeeeeee",
             "spa-a1": "ahhhhhhh", "spa-a2": "spaaaaaaa"}
MODEL, VERSION = "sonic-3.6", "2026-08-14"
DEFAULT_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"

env = dict(line.split("=", 1) for line in ENV.read_text().splitlines() if "=" in line and not line.lstrip().startswith("#"))
key = env.get("CARTESIA_API_KEY", "").strip().strip('"')
voice = env.get("CARTESIA_VOICE_ID", "").strip().strip('"') or DEFAULT_VOICE
if not key:
    sys.exit("CARTESIA_API_KEY missing from .env")

out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
stretched = len(sys.argv) > 2 and sys.argv[2] == "stretched"
jobs = [(stem, text, 1.0) for stem, text in STRETCHED.items()] if stretched else [(f"{w}-{sp}", t, sp) for w, t in WORDS.items() for sp in SPEEDS]
for stem, word, speed in jobs:
    body = {
        "model_id": MODEL, "transcript": word, "voice": voice, "language": "en",
        "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 48000},
    }
    if abs(speed - 1.0) > 0.01:
        body["generation_config"] = {"speed": speed}
    request = urllib.request.Request(
        "https://api.cartesia.ai/tts/bytes", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Cartesia-Version": VERSION, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        sys.exit(f"{word} @ {speed}: HTTP {error.code} {error.read()[:300]!r}")
    source = out / f"{stem}.raw.wav"
    source.write_bytes(raw)
    # Normalise to 48 kHz mono PCM16 whatever the service returned.
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(source), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le",
                    str(out / f"{stem}.wav")], check=True)
    source.unlink()
    print(f"{stem} ({word}) @ {speed}: {len(raw)} bytes")
print(f"voice {voice}, model {MODEL}")
