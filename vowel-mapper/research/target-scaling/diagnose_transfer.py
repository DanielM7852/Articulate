"""Exploratory (post hoc) diagnostic for the Stage 2 transfer failure. Not used for any pass/fail."""
import sys
from statistics import mean
sys.argv = [sys.argv[0], *sys.argv[1:3], "/dev/null"]
exec(open("check_refinement.py").read().split("h95, pb = load_h95(), load_pb()")[0])
h95, pb = load_h95(), load_pb()
model = fit(h95, False)
print("Mean offset of P&B target tokens from their scaled H95 centre, in radii (k=2), F1 / F2:")
for v in TARGETS:
    for g in ("men", "women", "children"):
        rs = []
        for s in sorted({t["spk"] for t in pb if t["grp"] == g}):
            own = [t for t in pb if t["spk"] == s]
            S = factor(model, own, v, PB_NEIGHBOURS)
            rs += [tuple((t["f"][k] - S[k] - model["R"][v][k]) / (K * model["sd"][v][k]) for k in (0, 1)) for t in own if t["intended"] == v]
        print(f"  {v:3} {g:9} {mean(r[0] for r in rs):+.2f} / {mean(r[1] for r in rs):+.2f}   (n={len(rs)})")
print("Raw group means, Hz (F1/F2), H95 listener-confirmed vs P&B:")
for v in TARGETS:
    for g, hg in (("men", ["men"]), ("women", ["women"]), ("children", ["boys", "girls"])):
        a = [t for t in h95 if t["grp"] in hg and t["heard"] == v == t["intended"]]
        b = [t for t in pb if t["grp"] == g and t["intended"] == v]
        print(f"  {v:3} {g:9} H95 {mean(t['hz'][0] for t in a):4.0f}/{mean(t['hz'][1] for t in a):4.0f}   P&B {mean(t['hz'][0] for t in b):4.0f}/{mean(t['hz'][1] for t in b):4.0f}")
