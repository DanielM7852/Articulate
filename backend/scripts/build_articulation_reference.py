"""Build the Cartesia reference set of correct vowel articulations for the SPARC tongue gate.

Each target vowel is spoken in several carrier words by several Cartesia voices, analysed by the
local articulation collector (SPARC + Silero VAD), trimmed to the vowel nucleus, and summarised in
backend/app/live/articulation_reference.json. Audio is cached only under the system temp dir.

Example:
  python scripts/build_articulation_reference.py --env-dir C:/path/to/Articulate-main/backend
"""

import argparse
import json
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import Settings  # noqa: E402
from app.integrations.cartesia import synthesize_wav  # noqa: E402
from app.live.articulation import extract_features  # noqa: E402

VOICES_URL = "https://api.cartesia.ai/voices"
DEFAULT_OUT = BACKEND_ROOT / "app" / "live" / "articulation_reference.json"
DEFAULT_COLLECTOR = "http://127.0.0.1:8010"
CACHE_DIR = Path(tempfile.gettempdir()) / "articulate_reference_cache"

WORDS = {
    "i": ["heed", "beat", "seed", "keep"],
    "u": ["who'd", "boot", "food", "hoop"],
    "a": ["hod", "father", "pot", "calm"],
}
SOUNDS = tuple(WORDS)
FEATURES = ("tongueHeight", "tongueFront", "jawOpen", "lipForward", "lipAperture")
CLIP_KEYS = FEATURES + ("frames", "quality")
REF_MIN_FRAMES = 8  # 160 ms of vowel nucleus
NUCLEUS_LABEL = "central 50% of longest VAD segment"
MIN_VOICES = 3
MIN_PER_SOUND = 3


# ---------------------------------------------------------------- pure helpers

def trim_to_nucleus(bundle: dict) -> dict | None:
    """Copy of the bundle whose VAD segments are only the central 50% of the longest one."""
    models = bundle.get("models") if isinstance(bundle, dict) else None
    vad = models.get("silero_vad") if isinstance(models, dict) else None
    if not isinstance(vad, dict) or vad.get("status") != "ok":
        return None
    best, best_len = None, 0.0
    for seg in vad.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        try:
            a, b = float(seg["startMs"]), float(seg["endMs"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            length = float(seg["endSample"]) - float(seg["startSample"])
        except (KeyError, TypeError, ValueError):
            length = b - a
        if b > a and length > best_len:
            best, best_len = seg, length
    if best is None:
        return None
    a, b = float(best["startMs"]), float(best["endMs"])
    span = b - a
    new = {"startMs": a + 0.25 * span, "endMs": a + 0.75 * span}
    try:
        s0, s1 = float(best["startSample"]), float(best["endSample"])
        new["startSample"] = int(s0 + 0.25 * (s1 - s0))
        new["endSample"] = int(s0 + 0.75 * (s1 - s0))
    except (KeyError, TypeError, ValueError):
        pass
    out = dict(bundle)
    out["models"] = {**models, "silero_vad": {**vad, "segments": [new]}}
    return out


def clip_record(voice_id: str, sound: str, word: str, bundle: dict) -> dict | None:
    """Nucleus features for one clip, or None when it is unusable."""
    trimmed = trim_to_nucleus(bundle)
    if trimmed is None:
        return None
    feats = extract_features(trimmed)
    # The length/speech-share checks are for learner attempts; a one-word nucleus is ~0.2-0.4 s by design.
    # Clipping and an unstable tongue still disqualify a reference clip.
    if not feats or (feats.get("frames") or 0) < REF_MIN_FRAMES:
        return None
    if feats.get("quality") != "ok" and feats.get("reason") not in ("too_short", "low_speech"):
        return None
    if any(not isinstance(feats.get(k), (int, float)) for k in FEATURES):
        return None
    return {"voice": voice_id, "sound": sound, "word": word, **{k: feats.get(k) for k in CLIP_KEYS}}


def voice_medians(clips: list[dict]) -> dict[str, dict[str, float]]:
    """{sound: {feature: median over this voice's clips}}."""
    out: dict[str, dict[str, float]] = {}
    for sound in SOUNDS:
        rows = [c for c in clips if c["sound"] == sound]
        if rows:
            out[sound] = {f: statistics.median(c[f] for c in rows) for f in FEATURES}
    return out


def voice_passes(medians: dict) -> tuple[bool, str | None]:
    for s in SOUNDS:
        m = medians.get(s)
        if not m or m.get("tongueHeight") is None or m.get("tongueFront") is None:
            return False, f"missing_{s}"
    h = {s: medians[s]["tongueHeight"] for s in SOUNDS}
    f = {s: medians[s]["tongueFront"] for s in SOUNDS}
    checks = [
        (h["i"] - h["a"] >= 0.8, "height_i_not_above_a"),
        (h["u"] - h["a"] >= 0.5, "height_u_not_above_a"),
        (f["i"] - f["a"] >= 0.4, "front_i_not_ahead_of_a"),
        (f["i"] - f["u"] >= 0.1, "front_i_not_ahead_of_u"),
    ]
    for ok, reason in checks:
        if not ok:
            return False, reason
    return True, None


def _stats(values: list[float]) -> dict:
    return {
        "median": round(statistics.median(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
        "std": round(statistics.pstdev(values), 3),
        "values": [round(v, 3) for v in values],
    }


def build_reference(voices: list[dict], clips: list[dict], *, model: str, version: str,
                    generated_at: str | None = None) -> tuple[dict, list[str]]:
    """Return (reference JSON dict, problems). Non-empty problems means it must not be written."""
    voice_rows, per_voice = [], []
    for v in voices:
        mine = [c for c in clips if c["voice"] == v["id"]]
        med = voice_medians(mine)
        ok, reason = voice_passes(med)
        if not mine:
            reason = "no_usable_clips"
        voice_rows.append({"id": v["id"], "name": v.get("name") or v["id"], "isAva": bool(v.get("isAva")),
                           "included": ok, "reason": reason, "clips": len(mine)})
        if ok:
            per_voice.append(med)
    sounds, problems = {}, []
    for s in SOUNDS:
        vals = {f: [m[s][f] for m in per_voice if s in m] for f in FEATURES}
        n = len(vals["tongueHeight"])
        if n < MIN_PER_SOUND:
            problems.append(f"sound {s} has only {n} included voices")
        sounds[s] = {"n": n, **{f: _stats(vals[f]) for f in FEATURES}} if n else {"n": 0}
    if len(per_voice) < MIN_VOICES:
        problems.append(f"only {len(per_voice)} voices passed the sanity check")
    ref = {
        "v": 1, "source": "cartesia", "model": model, "version": version,
        "generatedAt": generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "words": {s: list(w) for s, w in WORDS.items()},
        "nucleus": NUCLEUS_LABEL, "voices": voice_rows, "sounds": sounds,
    }
    return ref, problems


def parse_voices_response(payload) -> tuple[list[dict], str | None]:
    """(voices, next_page_token) from a list or {"data": [...]} response."""
    items, nxt = payload, None
    if isinstance(payload, dict):
        items = payload.get("data")
        if items is None:
            items = payload.get("voices")
        nxt = payload.get("next_page") or payload.get("next_page_token") or payload.get("next")
        if not isinstance(nxt, str) or not nxt:
            nxt = None
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            continue
        out.append({
            "id": it["id"], "name": str(it.get("name") or it["id"]),
            "language": str(it.get("language") or "").lower(),
            "gender": str(it.get("gender") or "").lower(),
            "description": str(it.get("description") or ""),
        })
    return out, nxt


def select_voices(candidates: list[dict], limit: int, exclude: set[str]) -> list[dict]:
    """English voices only, round-robin across gender for variety."""
    pool = [v for v in candidates if v["id"] not in exclude and (v["language"] == "" or v["language"].startswith("en"))]
    groups: dict[str, list[dict]] = {}
    for v in pool:
        groups.setdefault(v["gender"] or "unknown", []).append(v)
    picked: list[dict] = []
    while len(picked) < limit and any(groups.values()):
        for key in sorted(groups):
            if groups[key] and len(picked) < limit:
                picked.append(groups[key].pop(0))
    return picked


# ---------------------------------------------------------------- network

def headers_for(api_key: str, version: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Cartesia-Version": version}


def fetch_voices(api_key: str, version: str, client: httpx.Client, pages: int = 3) -> list[dict]:
    voices, token = [], None
    for _ in range(pages):
        params: dict = {"limit": 100}
        if token:
            params["starting_after"] = token
        r = client.get(VOICES_URL, headers=headers_for(api_key, version), params=params)
        r.raise_for_status()
        batch, token = parse_voices_response(r.json())
        voices.extend(batch)
        if not token:
            break
    return voices


def analyze_wav(wav: bytes, collector: str, client: httpx.Client, retries: int = 20) -> dict:
    url = f"{collector.rstrip('/')}/v1/articulation/analyze?models=sparc,silero_vad"
    for _ in range(retries):
        r = client.post(url, content=wav, headers={"Content-Type": "audio/wav"})
        if r.status_code == 503:
            time.sleep(3)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("collector stayed busy")


def cached_synth(word: str, voice_id: str, settings: Settings, client: httpx.Client) -> bytes:
    key = sha256(f"{voice_id}|{word}|{settings.cartesia_model_id}|{settings.cartesia_version}".encode()).hexdigest()[:20]
    path = CACHE_DIR / f"{key}.wav"
    if path.is_file():
        return path.read_bytes()
    wav = synthesize_wav(f"{word}.", api_key=settings.cartesia_api_key or "", voice_id=voice_id,
                         model_id=settings.cartesia_model_id, version=settings.cartesia_version,
                         timeout_s=60.0, client=client)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav)
    return wav


# ---------------------------------------------------------------- main

def load_settings(env_dir: str | None) -> Settings:
    if env_dir:
        d = Path(env_dir)
        return Settings(_env_file=(d / ".env", d / ".env.secrets"))
    return Settings(_env_file=None)


def plan_voices(args, settings: Settings, client: httpx.Client | None) -> tuple[list[dict], str | None]:
    """Ava first, then explicit --voices, else discovered voices (None client = dry run)."""
    ava_id = settings.resolved_cartesia_voice_id or settings.cartesia_default_voice_id
    ava = {"id": ava_id, "name": "Ava", "isAva": True}
    note = None
    if args.voices:
        extra = [{"id": v.strip(), "name": v.strip()} for v in args.voices.split(",") if v.strip() and v.strip() != ava_id]
    elif client is None:
        extra = []
        note = f"voice discovery skipped in dry run; a real run adds up to {max(args.max_voices - 1, 0)} discovered English voices"
    else:
        try:
            found = fetch_voices(settings.cartesia_api_key or "", settings.cartesia_version, client)
            for v in found:
                if v["id"] == ava_id:
                    ava["name"] = v["name"]
            extra = select_voices(found, max(args.max_voices - 1, 0), {ava_id})
        except Exception as exc:  # discovery is best effort
            extra = []
            note = f"voice discovery failed ({type(exc).__name__}); using Ava only"
    return [ava, *extra], note


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env-dir")
    p.add_argument("--collector", default=DEFAULT_COLLECTOR)
    p.add_argument("--voices")
    p.add_argument("--max-voices", type=int, default=6)
    p.add_argument("--list-voices", action="store_true")
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--words-per-sound", type=int, default=4)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    settings = load_settings(args.env_dir)
    words = {s: w[: max(args.words_per_sound, 1)] for s, w in WORDS.items()}

    if args.list_voices:
        with httpx.Client(timeout=30.0) as c:
            for v in fetch_voices(settings.cartesia_api_key or "", settings.cartesia_version, c):
                print(f"{v['id']}\t{v['name']}\t{v['language']}\t{v['gender']}\t{v['description'][:80]}")
        return 0

    if args.dry_run:
        voices, note = plan_voices(args, settings, None)
        print(f"Plan: model={settings.cartesia_model_id} version={settings.cartesia_version} collector={args.collector}")
        print(f"Voices: {[v['id'] for v in voices]}" + (f" ({note})" if note else ""))
        print(f"Words: {words}")
        print(f"Clips: {len(voices) * sum(len(w) for w in words.values())}; out: {args.out}")
        return 0

    if not settings.cartesia_api_key:
        print("No Cartesia API key found; pass --env-dir.", file=sys.stderr)
        return 2

    clips: list[dict] = []
    with httpx.Client(timeout=60.0) as http, httpx.Client(timeout=180.0) as collector:
        voices, note = plan_voices(args, settings, http)
        if note:
            print(note)
        for v in voices:
            print(f"Voice {v['name']} ({v['id']})")
            for sound, ws in words.items():
                for word in ws:
                    try:
                        bundle = analyze_wav(cached_synth(word, v["id"], settings, http), args.collector, collector)
                    except Exception as exc:
                        print(f"  {word}: skipped ({type(exc).__name__})")
                        continue
                    rec = clip_record(v["id"], sound, word, bundle)
                    print(f"  {word}: {'ok' if rec else 'unusable'}")
                    if rec:
                        clips.append(rec)

    ref, problems = build_reference(voices, clips, model=settings.cartesia_model_id, version=settings.cartesia_version)
    for v in ref["voices"]:
        print(f"{v['name']}: {'included' if v['included'] else 'excluded (' + str(v['reason']) + ')'} clips={v['clips']}")
    if problems:
        print("Not writing reference: " + "; ".join(problems), file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(ref, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
