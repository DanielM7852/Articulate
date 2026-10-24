"""Compare two tracker runs on Hillenbrand with cafeteria noise, token by token against hand steady-state values.

Usage: python3 -I compare_noise.py <h95-alldata.zip> <a.frames.json.gz> <b.frames.json.gz>
"""
import gzip, json, math, re, sys, zipfile
from statistics import median

ZIP, A, B = sys.argv[1:4]
hand = {}
for line in zipfile.ZipFile(ZIP).read("bigdata.dat").decode().splitlines():
    if re.match(r"^[bmwg]\d\d[a-z]{2}\s", line):
        c = line.split()
        if float(c[3]) > 0 and float(c[4]) > 0:
            hand[c[0][:3] + ("ei" if c[0][3:5] == "ey" else c[0][3:5])] = (float(c[3]), float(c[4]))


def load(path):
    tokens = {}
    for r in json.loads(gzip.decompress(open(path, "rb").read())):
        if r["accepted"]:
            tokens.setdefault((r["noise"], r["id"]), []).append((r["f1"], r["f2"]))
    return tokens


runs = {"old": load(A), "new": load(B)}
conditions = ["clean", "20", "15", "10", "5"]
print("| Noise dB | Method | Tokens measured | Median abs F1 / F2 error % | ee (iy) F1 bias % | ee F2 bias % | ah F1 bias % |")
print("|---|---|---|---|---|---|---|")
for cond in conditions:
    for name, tokens in runs.items():
        errs1, errs2, iy1, iy2, ah1 = [], [], [], [], []
        measured = 0
        for key, (h1, h2) in hand.items():
            pts = tokens.get((cond, key), [])
            if len(pts) < 3:
                continue
            measured += 1
            d1 = math.log(median(p[0] for p in pts) / h1)
            d2 = math.log(median(p[1] for p in pts) / h2)
            errs1.append(abs(d1)); errs2.append(abs(d2))
            if key.endswith("iy"): iy1.append(d1); iy2.append(d2)
            if key.endswith("ah"): ah1.append(d1)
        pct = lambda x: f"{100 * x:+.1f}"
        print(f"| {cond} | {name} | {measured} ({100 * measured / len(hand):.0f}%) | {100 * median(errs1):.1f} / {100 * median(errs2):.1f} | "
              f"{pct(median(iy1))} | {pct(median(iy2))} | {pct(median(ah1))} |")
