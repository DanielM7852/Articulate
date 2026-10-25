"""Stream a WAV to ws://127.0.0.1:8020/ws/phones in 160 ms chunks (real-time paced) and print results.

Usage: ws_smoke.py clip.wav [--url ws://127.0.0.1:8020/ws/phones] [--fast]"""
from __future__ import annotations

import argparse
import sys
import asyncio
import json
from math import gcd

import numpy as np
import soundfile as sf
import websockets
from scipy.signal import resample_poly

ap = argparse.ArgumentParser()
ap.add_argument("wav")
ap.add_argument("--url", default="ws://127.0.0.1:8020/ws/phones")
ap.add_argument("--fast", action="store_true", help="do not pace in real time")
a = ap.parse_args()
sys.stdout.reconfigure(encoding="utf-8")

x, sr = sf.read(a.wav, dtype="float32", always_2d=True)
x = x.mean(1)
if sr != 16000:
    g = gcd(sr, 16000)
    x = resample_poly(x, 16000 // g, sr // g)
pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
pcm = np.concatenate([pcm, np.zeros(16000 * 2, dtype="<i2")])  # trailing silence so the tail commits... via window slide
CH = 2560  # 160 ms


async def main():
    committed = []
    nframes = []
    async with websockets.connect(a.url, origin="http://127.0.0.1:5176") as ws:
        print("ready:", await ws.recv())

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] != "phones":
                    print(m)
                    continue
                committed.extend(m["committed"])
                fr = m.get("frames") or []
                top = max(fr, key=lambda f: f["mass"]) if fr else None
                fr_txt = (f" frames={len(fr)} maxmass={top['mass']:.2f}@{top['t']:.0f}ms {top['top'][0][0] if top['top'] else '-'}"
                          if top else f" frames={len(fr)}")
                nframes.append(len(fr))
                print(f"seq={m['seq']:3d} end={m['windowEndMs']:7.0f}ms inferMs={m['inferMs']:6.2f} "
                      f"+{' '.join(p['p'] for p in m['committed']) or '-':20s} | prov: {' '.join(p['p'] for p in m['provisional'])} |{fr_txt}")

        rt = asyncio.create_task(reader())
        for i in range(0, len(pcm), CH):
            await ws.send(pcm[i : i + CH].tobytes())
            if not a.fast:
                await asyncio.sleep(0.16)
        await asyncio.sleep(1.0)
        await ws.close()
        await rt
    if nframes:
        print(f"FRAMES: {len(nframes)} msgs, {sum(nframes)} frames total, per msg min/mean/max "
              f"{min(nframes)}/{sum(nframes) / len(nframes):.1f}/{max(nframes)}")
    print("COMMITTED:", " ".join(p["p"] for p in committed))


asyncio.run(main())
