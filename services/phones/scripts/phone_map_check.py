"""Calibrate the client's phone-map centroid against recorded clips.

Usage (from services/phones):
  .venv/Scripts/python.exe scripts/phone_map_check.py [--voices DIR] [--map PATH] [--report PATH]

For each clip: run the model on the whole clip, force-align the stated word order, and for every target phone take
its emitted frames (Viterbi path). Per frame with mass >= 0.5 the centroid is sum(p*pos)/sum(p) over the top-5
non-blank symbols that are in the map (client folding: X-aspirated -> X, r -> ɹ). Per target phone the mean centroid
over its emitted frames is compared with the phone's own map place (Euclidean, map units) and the nearest map phone.
The report (markdown) aggregates per phone across speakers; speaker names are never written.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from phones.align import folded_columns, log_softmax, spans_from_path, viterbi  # noqa: E402
from phones.app import _decode_wav  # noqa: E402
from phones.config import Settings  # noqa: E402
from phones.ctc import frame_posteriors  # noqa: E402
from phones.engine import load_recognizer  # noqa: E402

REPO = ROOT.parents[1]
SP = "C:/Users/Omkar/AppData/Local/Temp/claude/c--Users-Omkar-calhacks/4bfa16ca-50e0-47f9-ab14-47534f420762/scratchpad"
WORDS = {"track": ["t", "ɹ", "æ", "k"], "brain": ["b", "ɹ", "eɪ", "n"], "sheep": ["ʃ", "i", "p"],
         "rent": ["ɹ", "ɛ", "n", "t"]}
STATED = ["track", "brain", "sheep", "rent"]
STATED_OVERRIDE = {"Natasha": ["track", "sheep", "brain", "rent"]}
SR = 16000
MIN_MASS = 0.5


def fold(sym: str) -> str:
    if sym.endswith("ʰ"):
        sym = sym[:-1]
    return "ɹ" if sym == "r" else sym


def centroid(frame: dict, pmap: dict[str, tuple[float, float]]):
    num, den = np.zeros(2), 0.0
    for sym, p in frame["top"]:
        pos = pmap.get(fold(sym))
        if pos is not None:
            num += p * np.array(pos)
            den += p
    return num / den if den > 0 else None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", default=str(REPO.parent / "voices"))
    ap.add_argument("--map", default=str(REPO / "web/src/game/ghost/phone-map.json"))
    ap.add_argument("--report", default=f"{SP}/phone_map_report.md")
    args = ap.parse_args()

    pmap = {k: (v["x"], v["y"]) for k, v in json.loads(Path(args.map).read_text(encoding="utf-8"))["phones"].items()}
    names = list(pmap)
    coords = np.array([pmap[n] for n in names])
    rec = load_recognizer(Settings())
    tok2id = {t: i for i, t in rec.id2tok.items()}
    clips = sorted(Path(args.voices).glob("*.wav"))

    # (word, idx, target) -> list of (dist, hit, nearest) per clip; nodata count
    res: dict[tuple, list] = defaultdict(list)
    nodata: dict[tuple, int] = defaultdict(int)
    for path in clips:
        wave = _decode_wav(path.read_bytes(), SR)
        logits = rec.logits(wave)
        lp = log_softmax(logits)
        frames = frame_posteriors(logits, rec.id2tok, rec.blank_id, rec.frame_ms)
        order = STATED_OVERRIDE.get(path.stem, STATED)
        seq = [(w, i, p) for w in order for i, p in enumerate(WORDS[w])]
        targets = [p for _, _, p in seq]
        cols = folded_columns(lp, targets, tok2id)
        repeats = [i > 0 and targets[i] == targets[i - 1] for i in range(len(targets))]
        path_, _ = viterbi(lp[:, rec.blank_id], cols, repeats)
        for k, (w, i, p) in enumerate(seq):
            key = (w, i, p)
            tgt = fold(p)
            cs = []
            for f in np.nonzero(path_ == k)[0]:
                fr = frames[int(f)]
                if fr["mass"] >= MIN_MASS:
                    c = centroid(fr, pmap)
                    if c is not None:
                        cs.append(c)
            if tgt not in pmap or not cs:
                nodata[key] += 1
                continue
            c = np.mean(cs, axis=0)
            d = float(np.linalg.norm(c - np.array(pmap[tgt])))
            near = names[int(np.argmin(np.linalg.norm(coords - c, axis=1)))]
            res[key].append((d, near == tgt, near))

    def row(label, key_list):
        ds = [x[0] for k in key_list for x in res[k]]
        hs = [x[1] for k in key_list for x in res[k]]
        nd = sum(nodata[k] for k in key_list)
        if not ds:
            return f"| {label} | 0 | {nd} | - | - | - | - |"
        near = defaultdict(int)
        for k in key_list:
            for x in res[k]:
                near[x[2]] += 1
        top = ", ".join(f"{s}:{n}" for s, n in sorted(near.items(), key=lambda kv: -kv[1])[:3])
        return f"| {label} | {len(ds)} | {nd} | {np.median(ds):.3f} | {np.mean(ds):.3f} | {np.mean(hs):.0%} | {top} |"

    all_keys = list(dict.fromkeys(list(res) + list(nodata)))
    hdr = ["| phone | n | no-data | median dist | mean dist | hit rate | nearest (top3) |", "|---|---|---|---|---|---|---|"]
    rep = ["# Phone map calibration", f"{len(clips)} clips, model {rec.model_id}, mass >= {MIN_MASS}, top-5 centroid, "
           "map units (map spans 0..1 on both axes)", "",
           "Per word-position (aggregated across clips). Median dist = Euclidean between the mean centroid over the "
           "phone's emitted frames and the phone's map place; hit = nearest map phone is the target; no-data = no "
           "emitted frame with mass >= 0.5 and a mapped symbol.", ""]
    for w in STATED:
        rep += [f"## {w}", *hdr]
        for key in [k for k in all_keys if k[0] == w]:
            rep.append(row(f"{w}:{key[2]}", [key]))
        rep.append("")
    rep += ["## Per phone (all words)", *hdr]
    phones = list(dict.fromkeys(p for w in STATED for p in WORDS[w]))
    for p in ["t", "ɹ", "æ", "k"] + [q for q in phones if q not in "tɹæk"]:
        rep.append(row(p, [k for k in all_keys if k[2] == p]))
    ds = [x[0] for v in res.values() for x in v]
    rep += ["", f"Overall: median dist {np.median(ds):.3f}, hit rate {np.mean([x[1] for v in res.values() for x in v]):.0%} "
            f"over {len(ds)} phone instances.", ""]
    nn = []
    for p in phones:
        if fold(p) in pmap:
            d = np.linalg.norm(coords - np.array(pmap[fold(p)]), axis=1)
            d[names.index(fold(p))] = 9
            nn.append(f"{p}: {d.min():.3f} ({names[int(d.argmin())]})")
    rep += ["Context, distance from each target to its nearest other map phone: " + "; ".join(nn), ""]
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text("\n".join(rep), encoding="utf-8")
    print("\n".join(rep))


if __name__ == "__main__":
    main()
