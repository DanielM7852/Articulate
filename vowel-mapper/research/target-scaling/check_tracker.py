"""Amendment 2: speaker-scaled reference measured by the production tracker.

Usage: python3 -I check_tracker.py <h95-alldata.zip> <tracker.frames.json.gz> <tracker.json> <out-dir>
Reuses fit/inside from check_refinement.py so the method is identical.
"""

import gzip, json, math, pathlib, sys
from statistics import mean, median

ZIP_PATH, FRAMES, RUN_META, OUT_DIR = sys.argv[1:5]
sys.argv = [sys.argv[0], ZIP_PATH, "/dev/null", "/dev/null"]
here = pathlib.Path(__file__).parent
exec((here / "check_refinement.py").read_text().split("h95, pb = load_h95(), load_pb()")[0])
OUT = pathlib.Path(OUT_DIR)
CAL3 = {"eh", "ae", "er"}
MIN_FRAMES = 3

hand = {t["spk"] + t["intended"]: t for t in load_h95()}
frames = {}
for row in json.loads(gzip.decompress(pathlib.Path(FRAMES).read_bytes())):
    if row["noise"] == "clean" and row["accepted"]:
        frames.setdefault(row["id"], []).append((row["f1"], row["f2"]))

tracked, coverage = [], {}
for key, h in hand.items():
    pts = frames.get(key, [])
    cell = coverage.setdefault((h["grp"], h["intended"]), [0, 0])
    cell[1] += 1
    if len(pts) < MIN_FRAMES:
        continue
    cell[0] += 1
    f1, f2 = median(p[0] for p in pts), median(p[1] for p in pts)
    tracked.append(dict(h, hz=(f1, f2), f=(math.log(f1), math.log(f2)), hand_f=h["f"], hand_hz=h["hz"]))
retained_hand = [dict(t, hz=t["hand_hz"], f=t["hand_f"]) for t in tracked]

GROUPS4 = ["men", "women", "boys", "girls"]
fold = {}
for g in GROUPS4:
    for i, s in enumerate(sorted({t["spk"] for t in tracked if t["grp"] == g})):
        fold[s] = i % FOLDS


def factor_from(model, own, vowels):
    use = [t for t in own if t["intended"] in vowels]
    if not use:
        return None
    return collapse(tuple(mean(t["f"][k] - model["R"][t["intended"]][k] for t in use) for k in (0, 1)), False)


def run(tokens, cal_mode):
    res, central = {}, {}
    for f in range(FOLDS):
        model = fit([t for t in tokens if fold[t["spk"]] != f], False)
        for s in sorted({t["spk"] for t in tokens if fold[t["spk"]] == f}):
            own = [t for t in tokens if t["spk"] == s]
            g = own[0]["grp"]
            c = tuple(mean(t["f"][k] for t in own) for k in (0, 1))
            shrunk = [dict(t, f=tuple(c[k] + (1 - SHRINK) * (t["f"][k] - c[k]) for k in (0, 1))) for t in own]
            for v in TARGETS:
                vowels = CAL3 if cal_mode else set(VOWELS) - H95_NEIGHBOURS[v] - {v}
                S = factor_from(model, own, vowels)
                R, sd = model["R"][v], model["sd"][v]
                radius = (K * sd[0], K * sd[1])
                tests = {"A": lambda t, v=v: inside(t["hz"], TEAM[v], TEAM_RADIUS)}
                if S is not None:
                    tests["T"] = lambda t, S=S, R=R: inside(t["f"], (R[0] + S[0], R[1] + S[1]), radius)
                    S2 = factor_from(model, shrunk, vowels)
                    cc = central.setdefault(v, {"ratio": [], "hit": [0, 0]})
                    cc["ratio"].append(abs(S2[0] - S[0]) / mean(radius))
                    for t in shrunk:
                        if t["heard"] == v:
                            cc["hit"][0] += inside(t["f"], (R[0] + S2[0], R[1] + S2[1]), radius); cc["hit"][1] += 1
                for arm, test in tests.items():
                    cell = res.setdefault((arm, g, v), {"hit": [0, 0], "nfa": [0, 0], "afa": [0, 0]})
                    for t in own:
                        ok = test(t)
                        if t["heard"] == v:
                            cell["hit"][0] += ok; cell["hit"][1] += 1
                            continue
                        if t["heard"] in H95_NEIGHBOURS[v]:
                            cell["nfa"][0] += ok; cell["nfa"][1] += 1
                        cell["afa"][0] += ok; cell["afa"][1] += 1
    return res, central


def verdict(res, central, arm="T"):
    ratio = median(r for v in TARGETS for r in central[v]["ratio"])
    return {"P1": all(avg(res, arm, g, "hit") >= 80 for g in GROUPS4) and all(pct(res[(arm, g, v)]["hit"]) >= 65 for g in GROUPS4 for v in TARGETS),
            "P2": all(avg(res, arm, g, "nfa") <= 15 for g in GROUPS4),
            "P3": pooled(res, arm, ["boys", "girls"], "hit") - pooled(res, "A", ["boys", "girls"], "hit") >= 15
                  and pooled(res, arm, ["boys", "girls"], "nfa") <= pooled(res, "A", ["boys", "girls"], "nfa") + 5,
            "P4": ratio <= 0.25, "centralisation_ratio": ratio}


def table(title, res, central, arms):
    rows = [f"### {title}\n", "| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |", "|---|---|---|---|---|"]
    for arm, label in arms:
        for g in GROUPS4:
            cells = [res[(arm, g, v)] for v in TARGETS]
            rows.append(f"| {label} | {g} | " + " / ".join(f"{pct(c['hit']):.0f}" for c in cells) + f" (mean {avg(res, arm, g, 'hit'):.0f}) | "
                        + " / ".join(f"{pct(c['nfa']):.0f}" for c in cells) + f" (mean {avg(res, arm, g, 'nfa'):.0f}) | {avg(res, arm, g, 'afa'):.1f} |")
    rows += ["", "Centralisation (30%): median |dS| / radius " + " / ".join(f"{median(central[v]['ratio']):.3f}" for v in TARGETS)
             + "; hit on centralised target " + " / ".join(f"{pct(central[v]['hit']):.0f}%" for v in TARGETS), ""]
    return rows


results = {"T1": run(tracked, False), "T1-cal3": run(tracked, True), "C1-hand-same-tokens": run(retained_hand, False)}
verdicts = {name: verdict(*r) for name, r in results.items()}

out = ["# Amendment 2 results: tracker-measured reference\n"]
meta = json.loads(pathlib.Path(RUN_META).read_text())
out.append(f"Instrument: production estimator SHA-256 `{meta['estimatorSha256'][:16]}…`, manifest `{meta['manifestSha256'][:16]}…`. "
           f"Tokens retained (≥{MIN_FRAMES} accepted frames): {len(tracked)} of {len(hand)}.\n")
out += ["## Pass criteria\n", "| Arm | P1 | P2 | P3 | P4 | Centralisation ratio |", "|---|---|---|---|---|---|"]
for name, v in verdicts.items():
    out.append(f"| {name} | " + " | ".join("PASS" if v[p] else "FAIL" for p in ("P1", "P2", "P3", "P4")) + f" | {v['centralisation_ratio']:.3f} |")
label = "may say **inside the reference region for your voice**" if verdicts["T1-cal3"]["P1"] and verdicts["T1-cal3"]["P4"] else "shows **graded distance/direction only**"
out += ["", f"**Live prototype wording (pre-registered rule on T1-cal3):** {label}.\n"]
out += table("T1-cal3: factor from head / had / heard only (deployable)", *results["T1-cal3"], [("A", "A (team)"), ("T", "T1-cal3")])
out += table("T1: factor from all non-target, non-neighbour vowels", *results["T1"], [("T", "T1")])
out += table("Hand-measured C1 on the same retained tokens (comparison)", *results["C1-hand-same-tokens"], [("T", "C1 hand")])
out += ["### Coverage: tokens with ≥3 accepted tracker frames\n", "| Group | " + " | ".join(VOWELS) + " |", "|---|" + "---|" * len(VOWELS)]
for g in GROUPS4:
    out.append(f"| {g} | " + " | ".join(f"{pct(coverage[(g, v)]):.0f}" for v in VOWELS) + " |")
out += ["", "### Instrument bias: median ln(tracker / hand), F1 / F2 (0.10 ≈ 10%)\n", "| Group | iy | ah | uw | eh | ae | er |", "|---|---|---|---|---|---|---|"]
for g in GROUPS4:
    cells = []
    for v in ["iy", "ah", "uw", "eh", "ae", "er"]:
        ts = [t for t in tracked if t["grp"] == g and t["intended"] == v]
        cells.append(" / ".join(f"{median(t['f'][k] - t['hand_f'][k] for t in ts):+.2f}" for k in (0, 1)) if ts else "—")
    out.append(f"| {g} | " + " | ".join(cells) + " |")

deploy = fit(tracked, False)
reference = {
    "id": "h95-tracker-scaled", "version": 1, "status": "experimental",
    "description": "American English vowel reference (Hillenbrand et al. 1995, Michigan talkers) re-measured by the app's tracker, shifted by one speaker factor.",
    "space": "natural log Hz", "k": K, "calibrationVowels": sorted(CAL3), "calibrationWords": {"eh": "head", "ae": "had", "er": "heard"},
    "targets": {v: {"centre": deploy["R"][v], "centreHz": [math.exp(x) for x in deploy["R"][v]], "radius": [K * s for s in deploy["sd"][v]]} for v in TARGETS},
    "vowelMeans": {v: deploy["R"][v] for v in VOWELS},
    "caveats": ["/u/ region overlaps /ʊ/ 'hood' and /o/ 'hoed'", "Not a correctness standard; one regional variety", "Validated offline on hand-labelled citation words only"],
    "provenance": {"archiveSha256": "2560548591e3a726c88549b6dc9d226995616c26874d601c69fee8b9eee9d730", "estimatorSha256": meta["estimatorSha256"],
                   "commit": "f7f3074", "tokens": len(tracked), "labels": "listener majority vote", "verdict": verdicts["T1-cal3"]},
}
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "tracker.md").write_text("\n".join(out))
(OUT / "reference-h95-tracker-v1.json").write_text(json.dumps(reference, indent=1))
print("\n".join(out))
