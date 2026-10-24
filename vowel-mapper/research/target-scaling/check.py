"""Offline check of speaker-scaled vowel targets on Hillenbrand et al. (1995).

Usage: python3 -I check.py <h95-alldata.zip> <out-dir>
Design and pass criteria: PREREGISTRATION.md (fixed before this ran).
"""

import json, math, pathlib, re, sys, zipfile
from statistics import mean, median, pstdev

ZIP, OUT = sys.argv[1], pathlib.Path(sys.argv[2])
VOWELS = ["iy", "ih", "ei", "eh", "ae", "ah", "aw", "oa", "oo", "uw", "uh", "er"]
TARGETS = ["iy", "ah", "uw"]
NEIGHBOURS = {"iy": {"ih", "ei"}, "ah": {"aw", "uh"}, "uw": {"oo", "oa"}}
GROUPS = {"m": "men", "w": "women", "b": "boys", "g": "girls"}
TEAM = {"iy": (300, 2300), "uw": (350, 900), "ah": (750, 1200)}  # services/api/app/schemas.py
TEAM_RADIUS = (160, 350)
K, SHRINK, FOLDS = 2.0, 0.3, 5

archive = zipfile.ZipFile(ZIP)
norm = lambda v: "ei" if v == "ey" else v
tokens = {}
for line in archive.read("bigdata.dat").decode().splitlines():
    if re.match(r"^[bmwg]\d\d[a-z]{2}\s", line):
        c = line.split()
        f1, f2 = float(c[3]), float(c[4])
        if f1 > 0 and f2 > 0:
            tokens[c[0]] = dict(spk=c[0][:3], grp=c[0][0], intended=norm(c[0][3:5]),
                                hz=(f1, f2), f=(math.log(f1), math.log(f2)))
for line in archive.read("iddata.dat").decode().splitlines():
    m = re.match(r"^([bmwg]\d\d[a-z]{2})\.w\s", line)
    if m and m.group(1) in tokens:
        tokens[m.group(1)]["heard"] = norm(line.split()[14])
missing = [k for k, t in tokens.items() if "heard" not in t]
tokens = [t for t in tokens.values() if "heard" in t]
assert {t["intended"] for t in tokens} == set(VOWELS), {t["intended"] for t in tokens}

fold = {}
for g in GROUPS:
    for i, s in enumerate(sorted({t["spk"] for t in tokens if t["grp"] == g})):
        fold[s] = i % FOLDS


def fit(train):
    clean = [t for t in train if t["heard"] == t["intended"]]
    spks = {t["spk"] for t in clean}
    S = dict.fromkeys(spks, 0.0)
    by_vowel = {v: [t for t in clean if t["intended"] == v] for v in VOWELS}
    by_spk = {s: [t for t in clean if t["spk"] == s] for s in spks}
    ref = lambda: {v: tuple(mean(t["f"][k] - S[t["spk"]] for t in ts) for k in (0, 1)) for v, ts in by_vowel.items()}
    for _ in range(10):
        R = ref()
        S = {s: mean(t["f"][k] - R[t["intended"]][k] for t in ts for k in (0, 1)) for s, ts in by_spk.items()}
        centre = mean(S.values())
        S = {s: x - centre for s, x in S.items()}
    R = ref()
    sd = lambda xs: (pstdev([x[0] for x in xs]), pstdev([x[1] for x in xs]))
    model = {"R": R, "scaled": {}, "pooled": {}, "group": {}}
    for v in TARGETS:
        ts = by_vowel[v]
        model["scaled"][v] = sd([(t["f"][0] - S[t["spk"]] - R[v][0], t["f"][1] - S[t["spk"]] - R[v][1]) for t in ts])
        model["pooled"][v] = (tuple(mean(t["f"][k] for t in ts) for k in (0, 1)), sd([t["f"] for t in ts]))
        for g in GROUPS:
            gs = [t for t in ts if t["grp"] == g]
            model["group"][(v, g)] = (tuple(mean(t["f"][k] for t in gs) for k in (0, 1)), sd([t["f"] for t in gs]))
    return model


def speaker_factor(model, own, target, circular=False):
    use = [t for t in own if circular or (t["intended"] not in NEIGHBOURS[target] | {target})]
    return mean(t["f"][k] - model["R"][t["intended"]][k] for t in use for k in (0, 1))


def inside(x, centre, radius):
    return ((x[0] - centre[0]) / radius[0]) ** 2 + ((x[1] - centre[1]) / radius[1]) ** 2 <= 1


def regions(model, own, target, k, circular=False):
    S = speaker_factor(model, own, target, circular)
    R, sd = model["R"][target], model["scaled"][target]
    g = own[0]["grp"]
    gc, gsd = model["group"][(target, g)]
    pc, psd = model["pooled"][target]
    return {
        "A": lambda t: inside(t["hz"], TEAM[target], TEAM_RADIUS),
        "C1": lambda t: inside(t["f"], (R[0] + S, R[1] + S), (k * sd[0], k * sd[1])),
        "C0": lambda t: inside(t["f"], pc, (k * psd[0], k * psd[1])),
        "C2": lambda t: inside(t["f"], gc, (k * gsd[0], k * gsd[1])),
    }


def blank():
    return {"hit": [0, 0], "nfa": [0, 0], "afa": [0, 0]}


def tally(cell, t, target, accepted):
    if t["heard"] == target:
        key = "hit"
    elif t["heard"] in NEIGHBOURS[target]:
        cell["nfa"][0] += accepted; cell["nfa"][1] += 1
        key = "afa"
    else:
        key = "afa"
    cell[key][0] += accepted; cell[key][1] += 1


runs = {(k, circ): {} for k in (1.5, 2.0, 2.5) for circ in (False, True)}
central = {v: {"dS": [], "radius": [], "hit": [0, 0]} for v in TARGETS}
for f in range(FOLDS):
    model = fit([t for t in tokens if fold[t["spk"]] != f])
    test_spks = sorted({t["spk"] for t in tokens if fold[t["spk"]] == f})
    for s in test_spks:
        own = [t for t in tokens if t["spk"] == s]
        g = GROUPS[s[0]]
        for (k, circ), res in runs.items():
            for v in TARGETS:
                for arm, test in regions(model, own, v, k, circ).items():
                    cell = res.setdefault((arm, g, v), blank())
                    for t in own:
                        tally(cell, t, v, test(t))
        c = tuple(mean(t["f"][k] for t in own) for k in (0, 1))
        shrunk = [dict(t, f=tuple(c[k] + (1 - SHRINK) * (t["f"][k] - c[k]) for k in (0, 1))) for t in own]
        for v in TARGETS:
            before, after = speaker_factor(model, own, v), speaker_factor(model, shrunk, v)
            sd = model["scaled"][v]
            central[v]["dS"].append(abs(after - before))
            central[v]["radius"].append(K * (sd[0] + sd[1]) / 2)
            test = regions(model, shrunk, v, K)["C1"]
            for t in shrunk:
                if t["heard"] == v:
                    central[v]["hit"][0] += test(t); central[v]["hit"][1] += 1

pct = lambda p: 100 * p[0] / p[1] if p[1] else float("nan")
primary = runs[(K, False)]


def summary(res, arm, g, metric):
    return mean(pct(res[(arm, g, v)][metric]) for v in TARGETS)


groups = list(GROUPS.values())
kids = lambda res, arm, metric: pct([sum(res[(arm, g, v)][metric][i] for g in ("boys", "girls") for v in TARGETS) for i in (0, 1)])
p1 = all(summary(primary, "C1", g, "hit") >= 80 for g in groups) and all(pct(primary[("C1", g, v)]["hit"]) >= 65 for g in groups for v in TARGETS)
p2 = all(summary(primary, "C1", g, "nfa") <= 15 for g in groups)
p3 = kids(primary, "C1", "hit") - kids(primary, "A", "hit") >= 15 and kids(primary, "C1", "nfa") <= kids(primary, "A", "nfa") + 5
ratio = median(d / r for v in TARGETS for d, r in zip(central[v]["dS"], central[v]["radius"]))
p4 = ratio <= 0.25

out = [f"# Speaker-scaled targets: results\n",
       f"Speakers {len(fold)} ({', '.join(f'{n} {sum(1 for s in fold if s[0] == g)}' for g, n in GROUPS.items())}); tokens {len(tokens)}; tokens lacking listener votes {len(missing)}. k = {K}.\n",
       "## Pass criteria\n",
       f"- P1 C1 hit >= 80% per group, no cell < 65%: **{'PASS' if p1 else 'FAIL'}**",
       f"- P2 C1 neighbour false accept <= 15% per group: **{'PASS' if p2 else 'FAIL'}**",
       f"- P3 children: C1 hit - A hit = {kids(primary, 'C1', 'hit') - kids(primary, 'A', 'hit'):.1f} pts (>= 15), C1 nFA {kids(primary, 'C1', 'nfa'):.1f}% vs A {kids(primary, 'A', 'nfa'):.1f}% (<= A + 5): **{'PASS' if p3 else 'FAIL'}**",
       f"- P4 median |dS| / mean C1 radius under 30% centralisation = {ratio:.3f} (<= 0.25): **{'PASS' if p4 else 'FAIL'}**\n"]


def table(res, title):
    rows = [f"### {title}\n", "| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |", "|---|---|---|---|---|"]
    for arm in ("A", "C0", "C2", "C1"):
        for g in groups:
            cells = [res[(arm, g, v)] for v in TARGETS]
            rows.append(f"| {arm} | {g} | " + " / ".join(f"{pct(c['hit']):.0f}" for c in cells)
                        + f" (mean {summary(res, arm, g, 'hit'):.0f}) | " + " / ".join(f"{pct(c['nfa']):.0f}" for c in cells)
                        + f" (mean {summary(res, arm, g, 'nfa'):.0f}) | {summary(res, arm, g, 'afa'):.1f} |")
    return rows + [""]


out += table(primary, "Primary: k = 2, factor from non-target vowels")
out += ["### Centralisation (30% toward own centroid), C1\n", "| Target | median abs dS (ln) | mean C1 radius (ln) | C1 hit on centralised target tokens |", "|---|---|---|---|"]
out += [f"| {v} | {median(central[v]['dS']):.4f} | {mean(central[v]['radius']):.3f} | {pct(central[v]['hit']):.0f}% |" for v in TARGETS] + [""]
out += ["## Secondary (not used for pass/fail)\n"]
for k in (1.5, 2.5):
    out += table(runs[(k, False)], f"k = {k}")
out += table(runs[(K, True)], "Circular variant: factor estimated from all 12 vowels, including the target")
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "results.md").write_text("\n".join(out))
(OUT / "results.json").write_text(json.dumps({"pass": {"P1": p1, "P2": p2, "P3": p3, "P4": p4}, "centralisation_ratio": ratio,
    "primary": {"|".join(k): v for k, v in primary.items()}}, indent=1))
print("\n".join(out))
