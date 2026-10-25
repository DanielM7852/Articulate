"""Amendment 3: voice sizing without correct pronunciation.

Usage: python3 -I check_voice_size.py <h95-alldata.zip> <tracker.frames.json.gz> <out-dir>
Reuses fit/inside from check_refinement.py and the token/fold handling of check_tracker.py.
"""

import gzip, json, math, pathlib, re, sys, zipfile
from statistics import mean, median

ZIP_PATH, FRAMES, OUT_DIR = sys.argv[1:4]
sys.argv = [sys.argv[0], ZIP_PATH, "/dev/null", "/dev/null"]
here = pathlib.Path(__file__).parent
exec((here / "check_refinement.py").read_text().split("h95, pb = load_h95(), load_pb()")[0])
OUT = pathlib.Path(OUT_DIR)
CAL3 = {"eh", "ae", "er"}
MIN_FRAMES = 3
GROUPS4 = ["men", "women", "boys", "girls"]
METHODS = ["cal3", "cal3-uh", "none", "group", "uh", "f0", "f3", "f0f3"]
# Exploratory, added after seeing the pre-registered results: combinations of the pronunciation-free sources.
EXPLORATORY = ["uh+group", "group+f0f3", "uh+group+f0f3"]
METHODS += EXPLORATORY

# Hand-measured F0 (col 3) and F3 (col 6) per recording: stand-ins for an in-app measurement.
extra = {}
for line in zipfile.ZipFile(ZIP_PATH).read("bigdata.dat").decode().splitlines():
    if re.match(r"^[bmwg]\d\d[a-z]{2}\s", line):
        c = line.split()
        key = c[0][:3] + ("ei" if c[0][3:5] == "ey" else c[0][3:5])
        extra[key] = (float(c[2]), float(c[5]))

hand = {t["spk"] + t["intended"]: t for t in load_h95()}
frames = {}
for row in json.loads(gzip.decompress(pathlib.Path(FRAMES).read_bytes())):
    if row["noise"] == "clean" and row["accepted"]:
        frames.setdefault(row["id"], []).append((row["f1"], row["f2"]))
tracked = []
for key, h in hand.items():
    pts = frames.get(key, [])
    if len(pts) < MIN_FRAMES:
        continue
    f1, f2 = median(p[0] for p in pts), median(p[1] for p in pts)
    f0, f3 = extra.get(key, (0.0, 0.0))
    tracked.append(dict(h, hz=(f1, f2), f=(math.log(f1), math.log(f2)), f0=f0, f3=f3))

fold = {}
for g in GROUPS4:
    for i, s in enumerate(sorted({t["spk"] for t in tracked if t["grp"] == g})):
        fold[s] = i % FOLDS


def factor_of(model, tokens):
    use = [t for t in tokens if t["intended"] in model["R"]]
    return mean(t["f"][k] - model["R"][t["intended"]][k] for t in use for k in (0, 1)) if use else None


def ols(rows):
    """Least squares y ~ 1 + x... via normal equations (rows: (xs, y))."""
    n = len(rows[0][0]) + 1
    A = [[0.0] * n for _ in range(n)]
    b = [0.0] * n
    for xs, y in rows:
        v = [1.0, *xs]
        for i in range(n):
            b[i] += v[i] * y
            for j in range(n):
                A[i][j] += v[i] * v[j]
    for i in range(n):  # Gauss-Jordan
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p], b[i], b[p] = A[p], A[i], b[p], b[i]
        for r in range(n):
            if r != i:
                m = A[r][i] / A[i][i]
                A[r] = [a - m * c for a, c in zip(A[r], A[i])]
                b[r] -= m * b[i]
    return [b[i] / A[i][i] for i in range(n)]


def predict(coef, xs):
    return coef[0] + sum(c * x for c, x in zip(coef[1:], xs))


errors = {(m, g): [] for m in METHODS for g in GROUPS4}
hits = {}
for f in range(FOLDS):
    train = [t for t in tracked if fold[t["spk"]] != f]
    model = fit(train, False)
    radius = {v: (K * model["sd"][v][0], K * model["sd"][v][1]) for v in ("iy", "ah")}
    mean_radius = mean(r for v in radius for r in radius[v])
    by_spk = {}
    for t in train:
        by_spk.setdefault(t["spk"], []).append(t)
    oracle_train = {s: factor_of(model, ts) for s, ts in by_spk.items()}
    uh_train = {s: next((t for t in ts if t["intended"] == "uh" and t["f0"] > 0 and t["f3"] > 0), None) for s, ts in by_spk.items()}
    group_mean = {g: mean(oracle_train[s] for s in by_spk if by_spk[s][0]["grp"] == g) for g in GROUPS4}
    reg = {
        "f0": ols([([math.log(u["f0"])], oracle_train[s]) for s, u in uh_train.items() if u]),
        "f3": ols([([math.log(u["f3"])], oracle_train[s]) for s, u in uh_train.items() if u]),
        "f0f3": ols([([math.log(u["f0"]), math.log(u["f3"])], oracle_train[s]) for s, u in uh_train.items() if u]),
        "group+f0f3": ols([([math.log(u["f0"]), math.log(u["f3"]), *(float(by_spk[s][0]["grp"] == g) for g in GROUPS4[1:])], oracle_train[s])
                           for s, u in uh_train.items() if u]),
    }
    for s in sorted({t["spk"] for t in tracked if fold[t["spk"]] == f}):
        own = [t for t in tracked if t["spk"] == s]
        g = own[0]["grp"]
        oracle = factor_of(model, own)
        uh = next((t for t in own if t["intended"] == "uh"), None)
        cal = [t for t in own if t["intended"] in CAL3]
        est = {
            "cal3": factor_of(model, cal) if len(cal) == 3 else None,
            # Says head/had/heard all as their own "uh".
            "cal3-uh": mean(uh["f"][k] - model["R"][v][k] for v in CAL3 for k in (0, 1)) if uh else None,
            "none": 0.0,
            "group": group_mean[g],
            "uh": factor_of(model, [uh]) if uh else None,
        }
        ok = uh and uh["f0"] > 0 and uh["f3"] > 0
        est["f0"] = predict(reg["f0"], [math.log(uh["f0"])]) if ok else None
        est["f3"] = predict(reg["f3"], [math.log(uh["f3"])]) if ok else None
        est["f0f3"] = predict(reg["f0f3"], [math.log(uh["f0"]), math.log(uh["f3"])]) if ok else None
        est["group+f0f3"] = predict(reg["group+f0f3"], [math.log(uh["f0"]), math.log(uh["f3"]), *(float(g == x) for x in GROUPS4[1:])]) if ok else None
        est["uh+group+f0f3"] = mean([est["uh"], est["group+f0f3"]]) if ok else None
        est["uh+group"] = mean([est["uh"], est["group"]]) if uh else None
        for m, S in est.items():
            if S is None:
                continue
            errors[(m, g)].append(abs(S - oracle) / mean_radius)
            for v in ("iy", "ah"):
                R, r = model["R"][v], radius[v]
                cell = hits.setdefault((m, g, v), [0, 0, 0, 0])
                for t in own:
                    inside_ = inside(t["f"], (R[0] + S, R[1] + S), r)
                    if t["heard"] == v:
                        cell[0] += inside_; cell[1] += 1
                    elif t["heard"] in H95_NEIGHBOURS[v]:
                        cell[2] += inside_; cell[3] += 1


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(math.ceil(q * len(xs))) - 1)]


rows, summary = [], {}
for m in METHODS:
    p90 = {g: pct(errors[(m, g)], 0.9) for g in GROUPS4 if errors[(m, g)]}
    med = {g: median(errors[(m, g)]) for g in GROUPS4 if errors[(m, g)]}
    n = {g: len(errors[(m, g)]) for g in GROUPS4}
    qualifies = len(p90) == 4 and max(p90.values()) <= 0.5
    summary[m] = dict(median=med, p90=p90, n=n, worst_p90=max(p90.values()), qualifies=qualifies)
    hit = lambda v, g: hits[(m, g, v)][0] / max(1, hits[(m, g, v)][1]) * 100
    nfa = lambda v, g: hits[(m, g, v)][2] / max(1, hits[(m, g, v)][3]) * 100
    rows.append(f"| `{m}` | " + " · ".join(f"{med[g]:.2f} / {p90[g]:.2f}" for g in GROUPS4)
                + f" | {'yes' if qualifies else 'no'} | "
                + " · ".join(f"{hit('iy', g):.0f}/{hit('ah', g):.0f}" for g in GROUPS4) + " | "
                + " · ".join(f"{nfa('iy', g):.0f}/{nfa('ah', g):.0f}" for g in GROUPS4) + " |")

PRE = [m for m in METHODS if m not in EXPLORATORY]
pre = [m for m in PRE if m != "cal3" and summary[m]["qualifies"]]
best = min((m for m in PRE if m != "cal3"), key=lambda m: summary[m]["worst_p90"])
explore = [m for m in EXPLORATORY if summary[m]["qualifies"]]
md = ["# Amendment 3 results: voice sizing without correct pronunciation", "",
      f"Tokens retained: {len(tracked)}. Error = |factor − all-vowel factor| in mean reference radii (ee/ah). "
      "F0/F3 are Hillenbrand hand measurements of the speaker's \"uh\" token.", "",
      "| Method | Factor error median / 90th pct (men · women · boys · girls) | Qualifies (≤ 0.5 at 90th, all groups) | ee/ah hit % (m · w · b · g) | ee/ah neighbour FA % (m · w · b · g) |",
      "|---|---|---|---|---|", *rows, "",
      f"Qualifying pronunciation-free methods: {', '.join(pre) or 'none'}. "
      f"Lowest worst-group 90th percentile (excluding cal3): `{best}` ({summary[best]['worst_p90']:.2f}).", "",
      f"Exploratory rows ({', '.join(EXPLORATORY)}) were added after seeing the pre-registered rows. "
      f"Meeting the bar: {', '.join(explore) or 'none'}. They need a fresh check before they count."]
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "voice-size.md").write_text("\n".join(md) + "\n")
(OUT / "voice-size.json").write_text(json.dumps({m: summary[m] for m in METHODS}, indent=1))
print("\n".join(md))

# Deployable constants for the "uh + menu" path, fitted on all speakers like reference-h95-tracker-v1.json.
deploy = fit(tracked, False)
all_spk = {}
for t in tracked:
    all_spk.setdefault(t["spk"], []).append(t)
group_factor = {g: mean(factor_of(deploy, ts) for ts in all_spk.values() if ts[0]["grp"] == g) for g in GROUPS4}
constants = {"id": "h95-tracker-voice-size", "version": 1, "status": "exploratory (Amendment 3)",
             "uh": deploy["R"]["uh"], "groupFactor": group_factor,
             "method": "factor = mean(factor from one held 'uh', group mean factor)",
             "matchesReferenceV1": all(abs(a - b) < 1e-9 for v in ("iy", "ah", "uh") for a, b in
                                       zip(deploy["R"][v], json.loads((OUT / "reference-h95-tracker-v1.json").read_text())["vowelMeans"][v]))}
(OUT / "voice-size-v1.json").write_text(json.dumps(constants, indent=1))
print(json.dumps(constants))
