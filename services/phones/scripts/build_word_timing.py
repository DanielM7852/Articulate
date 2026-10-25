"""Per-phone word timing from recorded clips (CTC forced alignment) + posterior calibration.

Usage (from services/phones):
  .venv/Scripts/python.exe scripts/build_word_timing.py [--voices DIR] [--report PATH] [--out PATH]
          [--near-miss WAV ...]
Writes a markdown report and the aggregate recorded-timing JSON (no speaker names in the JSON).
"""
from __future__ import annotations

import argparse
import itertools
import json
import statistics
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from phones.align import log_softmax, score_targets, spans_to_boundaries  # noqa: E402
from phones.app import _decode_wav  # noqa: E402
from phones.config import Settings  # noqa: E402
from phones.ctc import greedy_decode  # noqa: E402
from phones.engine import load_recognizer  # noqa: E402

WORDS = {"track": ["t", "ɹ", "æ", "k"], "brain": ["b", "ɹ", "eɪ", "n"], "sheep": ["ʃ", "i", "p"],
         "rent": ["ɹ", "ɛ", "n", "t"]}
STATED = ["track", "brain", "sheep", "rent"]
STATED_OVERRIDE = {"Natasha": ["track", "sheep", "brain", "rent"]}
SR = 16000
MIN_MARGIN = 3.0  # nats between stated order and best alternative
MIN_POST = 0.2
REPO = ROOT.parents[1]
NEAR = [REPO / "backend/.local_store/speech/47e360a84a8968cd.wav",
        REPO / "backend/.local_store/speech/074abbb87bc2fc33.wav"]


def energy_db(wave: np.ndarray, hop=160, win=320) -> np.ndarray:
    n = max(1, (len(wave) - win) // hop + 1)
    e = np.array([np.sqrt(np.mean(wave[i * hop:i * hop + win] ** 2) + 1e-12) for i in range(n)])
    return 20 * np.log10(e)


def word_window(db: np.ndarray, a_ms: float, b_ms: float, rel=-40.0):
    """Trim the candidate window [a,b] inward to the energy onset/offset: threshold =
    max(word peak - 40 dB, clip noise floor (10th pct) + 6 dB). The candidate window is already generous
    (halfway to the neighbouring words' phones; mirrored around the first/last spike at the clip edges)."""
    hop = 10.0
    i0, i1 = int(a_ms / hop), min(int(b_ms / hop), len(db) - 1)
    peak = db[i0:i1 + 1].max()
    thr = max(peak + rel, float(np.percentile(db, 10)) + 6.0)
    s, e = i0, i1
    while s < i1 and db[s] < thr:
        s += 1
    while e > s and db[e] < thr:
        e -= 1
    return s * hop, (e + 1) * hop


def align_order(lp, order, tok2id, id2tok, blank):
    seq = [p for w in order for p in WORDS[w]]
    scores, spans, total = score_targets(lp, seq, tok2id, id2tok, blank)
    return seq, scores, spans, total


def pct(xs, q):
    return float(np.percentile(xs, q))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", default=str(REPO.parent / "voices"))
    sp = "C:/Users/Omkar/AppData/Local/Temp/claude/c--Users-Omkar-calhacks/4bfa16ca-50e0-47f9-ab14-47534f420762/scratchpad"
    ap.add_argument("--report", default=f"{sp}/word_timing_report.md")
    ap.add_argument("--out", default=str(REPO / "web/src/game/ghost/models/recorded-timing.json"))
    ap.add_argument("--near-miss", nargs="*", default=[str(p) for p in NEAR])
    args = ap.parse_args()

    st = Settings()
    rec = load_recognizer(st)
    tok2id = {t: i for i, t in rec.id2tok.items()}
    blank = rec.blank_id
    for w, ps in WORDS.items():
        for p in ps:
            assert p in tok2id, f"{p} missing from vocab"
    fm = rec.frame_ms

    rep = ["# Word timing report", f"model {rec.model_id} on {rec.engine_name}", ""]
    per_word = {w: [] for w in WORDS}  # unflagged clips only
    calib = {}  # (word, idx, phone) -> list of (post, gop)
    clips = sorted(Path(args.voices).glob("*.wav"))
    used = 0
    for path in clips:
        name = path.stem
        wave = _decode_wav(path.read_bytes(), SR)
        logits = rec.logits(wave)
        lp = log_softmax(logits)
        stated = STATED_OVERRIDE.get(name, STATED)
        seq, scores, spans, total = align_order(lp, stated, tok2id, rec.id2tok, blank)
        alts = []
        for perm in itertools.permutations(STATED):
            alts.append((list(perm), align_order(lp, list(perm), tok2id, rec.id2tok, blank)[3]))
        alts.sort(key=lambda x: -x[1])
        best_order, best_total = alts[0]
        runner = next(t for o, t in alts if o != stated) if best_order == stated else best_total
        margin = total - runner if best_order == stated else total - best_total
        flags = []  # order problems exclude the clip from timing
        if best_order != stated:
            flags.append(f"best order is {','.join(best_order)} (stated is better by {margin:.1f})")
        elif margin < MIN_MARGIN:
            flags.append(f"tiny margin {margin:.1f}")
        order_ok = not flags
        low = [f"{s.p}@{i} post={s.post:.2f}" for i, s in enumerate(scores) if s.post < MIN_POST]
        if low:  # informational: the model often hears accented phones as something else
            flags.append("low post: " + ", ".join(low))
        greedy = " ".join(p.p for p in greedy_decode(logits, rec.id2tok, blank, fm))
        rep += [f"## {name} ({len(wave) / SR:.2f}s)", f"- stated: {', '.join(stated)}",
                f"- best order: {', '.join(best_order)}; margin of stated over best alternative: {margin:.1f} nats",
                f"- flags: {'; '.join(flags) or 'none'}", f"- greedy: {greedy}"]

        db = energy_db(wave)
        bounds = spans_to_boundaries(spans, fm, lp.shape[0], pad_ms=0)
        k = 0
        word_info = []
        for w in stated:
            n = len(WORDS[w])
            word_info.append((w, k, k + n))
            k += n
        for wi, (w, a, b) in enumerate(word_info):
            a_ms, b_ms = bounds[a]["startMs"], bounds[b - 1]["endMs"]
            if wi == 0:  # clip edge: mirror the first phone around its spike
                a_ms = max(0.0, 2 * bounds[a]["peakMs"] - bounds[a]["endMs"])
            if wi == len(word_info) - 1:
                b_ms = min(len(wave) / SR * 1000, 2 * bounds[b - 1]["peakMs"] - bounds[b - 1]["startMs"])
            ws, we = word_window(db, a_ms, b_ms)
            # voiceless stop bursts / final fricatives can sit below the threshold: never cut off a CTC spike
            ws = min(ws, spans[a][0] * fm)
            we = max(we, (spans[b - 1][1] + 1) * fm)
            dur = we - ws
            ph = []
            for j in range(a, b):
                t0 = bounds[j]["startMs"] if j > a else ws
                t1 = bounds[j]["endMs"] if j < b - 1 else we
                pk = bounds[j]["peakMs"]
                f = lambda x: float(np.clip((x - ws) / dur, 0, 1))
                ph.append({"p": seq[j], "t0": f(t0), "t1": f(t1), "peak": f(pk), "post": scores[j].post,
                           "gop": scores[j].gop})
                calib.setdefault((w, j - a, seq[j]), []).append((scores[j].post, scores[j].gop))
            rep.append(f"- {w}: {ws:.0f}-{we:.0f} ms, durationMs {dur:.0f}; " + ", ".join(
                f"{x['p']} post={x['post']:.2f} gop={x['gop']:.1f}" for x in ph))
            n_low = sum(x["post"] < MIN_POST for x in ph)
            if order_ok and n_low <= 1:  # a word with 2+ unrecognised phones has untrustworthy spans
                per_word[w].append({"dur": dur, "ph": ph})
        used += order_ok
        rep.append("")

    out = {"version": 1, "source": "recorded", "model": rec.model_id, "clips": len(clips), "used": used,
           "provenance": f"median of {used} speakers from voices/*.wav, CTC forced alignment", "words": {}}
    rep += ["## Aggregate (clips with order OK; words with at most 1 phone below post 0.2)", ""]
    for w, items in per_word.items():
        n = len(items)
        if not n:
            continue
        L = len(WORDS[w])
        dur = statistics.median(i["dur"] for i in items)
        edges = [0.0] + [statistics.median(i["ph"][j]["t1"] for i in items) for j in range(L - 1)] + [1.0]
        for j in range(1, L + 1):
            edges[j] = max(edges[j], edges[j - 1])
        phs = []
        for j in range(L):
            pk = statistics.median(i["ph"][j]["peak"] for i in items)
            pk = min(max(pk, edges[j]), edges[j + 1])
            phs.append({"p": WORDS[w][j], "t0": round(edges[j], 4), "t1": round(edges[j + 1], 4), "peak": round(pk, 4)})
        out["words"][w] = {"durationMs": round(dur), "n": n, "phones": phs}
        rep.append(f"- {w}: durationMs {dur:.0f} (n={n}, range {min(i['dur'] for i in items):.0f}-"
                   f"{max(i['dur'] for i in items):.0f}); " + " ".join(
                       f"{p['p']}[{p['t0']:.3f},{p['t1']:.3f} pk {p['peak']:.3f}]" for p in phs))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    rep += ["", "## Calibration (all clips, stated-order alignment)", "",
            "| phone | n | post min / p10 / med | gop min / p10 / med |", "|---|---|---|---|"]
    allp, allg = [], []
    for (w, j, p), v in sorted(calib.items(), key=lambda kv: (list(WORDS).index(kv[0][0]), kv[0][1])):
        po, go = [x[0] for x in v], [x[1] for x in v]
        allp += po
        allg += go
        rep.append(f"| {w}:{p} | {len(v)} | {min(po):.2f} / {pct(po, 10):.2f} / {np.median(po):.2f} | "
                   f"{min(go):.1f} / {pct(go, 10):.1f} / {np.median(go):.1f} |")
    rep.append(f"| ALL | {len(allp)} | {min(allp):.2f} / {pct(allp, 10):.2f} / {np.median(allp):.2f} | "
               f"{min(allg):.1f} / {pct(allg, 10):.1f} / {np.median(allg):.1f} |")

    rep += ["", "## Near-miss clips, targets t ɹ æ k", ""]
    for nm in args.near_miss:
        pth = Path(nm)
        if not pth.exists():
            rep.append(f"- {nm}: missing")
            continue
        wave = _decode_wav(pth.read_bytes(), SR)
        logits = rec.logits(wave)
        lp = log_softmax(logits)
        sc, spans, tot = score_targets(lp, WORDS["track"], tok2id, rec.id2tok, blank)
        greedy = " ".join(p.p for p in greedy_decode(logits, rec.id2tok, blank, fm))
        rep.append(f"- {pth.name} ({len(wave) / SR:.2f}s) greedy: {greedy}; alignLogProb {tot:.1f}")
        for s in sc:
            rep.append(f"  - {s.p}: post={s.post:.3f} gop={s.gop:.2f} best={s.best} ({s.bestPost:.3f}) "
                       f"frames {s.first}-{s.last}")
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text("\n".join(rep) + "\n", encoding="utf-8")
    print("\n".join(rep))


if __name__ == "__main__":
    main()
