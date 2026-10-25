"""Amendment 1: one- vs two-factor speaker scaling.

Usage: python3 -I check_refinement.py <h95-alldata.zip> <pb52.csv> <out-dir>
Stage 1 (exploratory): Hillenbrand 5-fold, as in check.py.
Stage 2 (confirmatory): fit on all Hillenbrand, apply unchanged to Peterson & Barney.
"""

import csv, json, math, pathlib, re, sys, zipfile
from statistics import mean, median, pstdev

ZIP, PB, OUT = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
VOWELS = ["iy", "ih", "ei", "eh", "ae", "ah", "aw", "oa", "oo", "uw", "uh", "er"]
TARGETS = ["iy", "ah", "uw"]
H95_NEIGHBOURS = {"iy": {"ih", "ei"}, "ah": {"aw", "uh"}, "uw": {"oo", "oa"}}
PB_NEIGHBOURS = {"iy": {"ih"}, "ah": {"aw", "uh"}, "uw": {"oo"}}
XSAMPA = {"i": "iy", "I": "ih", "E": "eh", "{": "ae", "A": "ah", "O": "aw", "U": "oo", "u": "uw", "V": "uh", "3'": "er"}
TEAM = {"iy": (300, 2300), "uw": (350, 900), "ah": (750, 1200)}
TEAM_RADIUS = (160, 350)
K, SHRINK, FOLDS = 2.0, 0.3, 5


def token(spk, grp, intended, heard, f1, f2):
    return dict(spk=spk, grp=grp, intended=intended, heard=heard, hz=(f1, f2), f=(math.log(f1), math.log(f2)))


def load_h95():
    archive = zipfile.ZipFile(ZIP)
    norm = lambda v: "ei" if v == "ey" else v
    raw, heard = {}, {}
    for line in archive.read("bigdata.dat").decode().splitlines():
        if re.match(r"^[bmwg]\d\d[a-z]{2}\s", line):
            c = line.split()
            if float(c[3]) > 0 and float(c[4]) > 0:
                raw[c[0]] = c
    for line in archive.read("iddata.dat").decode().splitlines():
        m = re.match(r"^([bmwg]\d\d[a-z]{2})\.w\s", line)
        if m:
            heard[m.group(1)] = norm(line.split()[14])
    groups = {"m": "men", "w": "women", "b": "boys", "g": "girls"}
    return [token(k[:3], groups[k[0]], norm(k[3:5]), heard[k], float(c[3]), float(c[4])) for k, c in raw.items() if k in heard]


def load_pb():
    groups = {"m": "men", "w": "women", "c": "children"}
    with open(PB) as f:
        return [token("pb" + r["speaker"], groups[r["type"]], XSAMPA[r["vowel"]], XSAMPA[r["vowel"]], float(r["f1"]), float(r["f2"]))
                for r in csv.DictReader(f) if float(r["f1"]) > 0 and float(r["f2"]) > 0]


def collapse(pair, two):
    return pair if two else (mean(pair),) * 2


def fit(train, two):
    clean = [t for t in train if t["heard"] == t["intended"]]
    by_vowel = {v: [t for t in clean if t["intended"] == v] for v in VOWELS}
    by_spk = {}
    for t in clean:
        by_spk.setdefault(t["spk"], []).append(t)
    S = dict.fromkeys(by_spk, (0.0, 0.0))
    ref = lambda: {v: tuple(mean(t["f"][k] - S[t["spk"]][k] for t in ts) for k in (0, 1)) for v, ts in by_vowel.items() if ts}
    for _ in range(10):
        R = ref()
        S = {s: collapse(tuple(mean(t["f"][k] - R[t["intended"]][k] for t in ts) for k in (0, 1)), two) for s, ts in by_spk.items()}
        centre = tuple(mean(x[k] for x in S.values()) for k in (0, 1))
        S = {s: (x[0] - centre[0], x[1] - centre[1]) for s, x in S.items()}
    R = ref()
    sd = {v: tuple(pstdev([t["f"][k] - S[t["spk"]][k] - R[v][k] for t in by_vowel[v]]) for k in (0, 1)) for v in TARGETS}
    return dict(R=R, sd=sd, two=two)


def factor(model, own, target, neighbours):
    use = [t for t in own if t["intended"] not in neighbours[target] | {target} and t["intended"] in model["R"]]
    return collapse(tuple(mean(t["f"][k] - model["R"][t["intended"]][k] for t in use) for k in (0, 1)), model["two"])


def inside(x, centre, radius):
    return ((x[0] - centre[0]) / radius[0]) ** 2 + ((x[1] - centre[1]) / radius[1]) ** 2 <= 1


def scaled_test(model, own, target, neighbours):
    S, R, sd = factor(model, own, target, neighbours), model["R"][target], model["sd"][target]
    return lambda t: inside(t["f"], (R[0] + S[0], R[1] + S[1]), (K * sd[0], K * sd[1]))


def evaluate(models, test_tokens, neighbours, res, central):
    for s in sorted({t["spk"] for t in test_tokens}):
        own = [t for t in test_tokens if t["spk"] == s]
        g = own[0]["grp"]
        c = tuple(mean(t["f"][k] for t in own) for k in (0, 1))
        shrunk = [dict(t, f=tuple(c[k] + (1 - SHRINK) * (t["f"][k] - c[k]) for k in (0, 1))) for t in own]
        for v in TARGETS:
            tests = {"A": lambda t, v=v: inside(t["hz"], TEAM[v], TEAM_RADIUS)}
            for name, model in models.items():
                tests[name] = scaled_test(model, own, v, neighbours)
                before, after = factor(model, own, v, neighbours), factor(model, shrunk, v, neighbours)
                cell = central.setdefault((name, v), {"ratio": [], "hit": [0, 0]})
                radius = K * mean(model["sd"][v])
                cell["ratio"].append(mean(abs(after[k] - before[k]) for k in (0, 1)) / radius)
                shrunk_test = scaled_test(model, shrunk, v, neighbours)
                for t in shrunk:
                    if t["heard"] == v:
                        cell["hit"][0] += shrunk_test(t); cell["hit"][1] += 1
            for arm, test in tests.items():
                cell = res.setdefault((arm, g, v), {"hit": [0, 0], "nfa": [0, 0], "afa": [0, 0]})
                for t in own:
                    ok = test(t)
                    if t["heard"] == v:
                        cell["hit"][0] += ok; cell["hit"][1] += 1
                        continue
                    if t["heard"] in neighbours[v]:
                        cell["nfa"][0] += ok; cell["nfa"][1] += 1
                    cell["afa"][0] += ok; cell["afa"][1] += 1


pct = lambda p: 100 * p[0] / p[1] if p[1] else float("nan")
pooled = lambda res, arm, groups, metric: pct([sum(res[(arm, g, v)][metric][i] for g in groups for v in TARGETS) for i in (0, 1)])
avg = lambda res, arm, g, metric: mean(pct(res[(arm, g, v)][metric]) for v in TARGETS)


def report(title, res, central, groups, kids):
    rows = [f"## {title}\n", "| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |", "|---|---|---|---|---|"]
    for arm in ("A", "C1", "C1b"):
        for g in groups:
            cells = [res[(arm, g, v)] for v in TARGETS]
            rows.append(f"| {arm} | {g} | " + " / ".join(f"{pct(c['hit']):.0f}" for c in cells) + f" (mean {avg(res, arm, g, 'hit'):.0f}) | "
                        + " / ".join(f"{pct(c['nfa']):.0f}" for c in cells) + f" (mean {avg(res, arm, g, 'nfa'):.0f}) | {avg(res, arm, g, 'afa'):.1f} |")
    rows += ["", "| Arm | Centralisation: median |dS| / radius (iy / ah / uw) | Hit on centralised target |", "|---|---|---|"]
    for arm in ("C1", "C1b"):
        rows.append(f"| {arm} | " + " / ".join(f"{median(central[(arm, v)]['ratio']):.3f}" for v in TARGETS) + " | "
                    + " / ".join(f"{pct(central[(arm, v)]['hit']):.0f}%" for v in TARGETS) + " |")
    verdict = {}
    for arm in ("C1", "C1b"):
        ratio = median(r for v in TARGETS for r in central[(arm, v)]["ratio"])
        verdict[arm] = {
            "P1": all(avg(res, arm, g, "hit") >= 80 for g in groups) and all(pct(res[(arm, g, v)]["hit"]) >= 65 for g in groups for v in TARGETS),
            "P2": all(avg(res, arm, g, "nfa") <= 15 for g in groups),
            "P3": pooled(res, arm, kids, "hit") - pooled(res, "A", kids, "hit") >= 15 and pooled(res, arm, kids, "nfa") <= pooled(res, "A", kids, "nfa") + 5,
            "P4": ratio <= 0.25,
            "children_hit": pooled(res, arm, kids, "hit"), "children_nfa": pooled(res, arm, kids, "nfa"), "centralisation_ratio": ratio,
        }
    rows += ["", "| Arm | P1 | P2 | P3 | P4 | Children hit % | Children neighbour FA % |", "|---|---|---|---|---|---|---|"]
    for arm, v in verdict.items():
        rows.append(f"| {arm} | " + " | ".join("PASS" if v[p] else "FAIL" for p in ("P1", "P2", "P3", "P4"))
                    + f" | {v['children_hit']:.1f} | {v['children_nfa']:.1f} |")
    return rows + [""], verdict


h95, pb = load_h95(), load_pb()
fold = {}
for g in ("men", "women", "boys", "girls"):
    for i, s in enumerate(sorted({t["spk"] for t in h95 if t["grp"] == g})):
        fold[s] = i % FOLDS

stage1, central1 = {}, {}
for f in range(FOLDS):
    train = [t for t in h95 if fold[t["spk"]] != f]
    models = {"C1": fit(train, False), "C1b": fit(train, True)}
    evaluate(models, [t for t in h95 if fold[t["spk"]] == f], H95_NEIGHBOURS, stage1, central1)
rows1, verdict1 = report("Stage 1 (exploratory): Hillenbrand, 5-fold, listener labels", stage1, central1, ["men", "women", "boys", "girls"], ["boys", "girls"])

stage2, central2 = {}, {}
evaluate({"C1": fit(h95, False), "C1b": fit(h95, True)}, pb, PB_NEIGHBOURS, stage2, central2)
rows2, verdict2 = report("Stage 2 (confirmatory): fit on all Hillenbrand, applied to Peterson & Barney", stage2, central2, ["men", "women", "children"], ["children"])

c1, c1b = verdict2["C1"], verdict2["C1b"]
adopt = c1b["children_hit"] - c1["children_hit"] >= 5 and c1b["children_nfa"] - c1["children_nfa"] <= 3 and c1b["P4"]
counts = {g: len({t["spk"] for t in pb if t["grp"] == g}) for g in ("men", "women", "children")}
out = ["# Amendment 1 results: one- vs two-factor scaling\n",
       f"Peterson & Barney: {len(pb)} tokens, speakers {counts}. Hillenbrand: {len(h95)} tokens.\n",
       f"**Refinement rule (P&B children: C1b hit ≥ C1 + 5, neighbour FA ≤ C1 + 3, C1b passes P4): {'ADOPT C1b' if adopt else 'KEEP C1'}** "
       f"(hit {c1b['children_hit']:.1f} vs {c1['children_hit']:.1f}; neighbour FA {c1b['children_nfa']:.1f} vs {c1['children_nfa']:.1f}).\n"]
out += rows2 + rows1
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "refinement.md").write_text("\n".join(out))
(OUT / "refinement.json").write_text(json.dumps({"adopt_two_factor": adopt, "stage1": verdict1, "stage2": verdict2}, indent=1))
print("\n".join(out))
