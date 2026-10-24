"""Scores the web app's fixed regions (web/src/vowel/targets.ts on origin/main) on the same tracker-measured Hillenbrand tokens. Usage: python3 -I web_targets.py"""
import gzip, json, math, pathlib, sys
from statistics import median
here = pathlib.Path("/Users/Git/Articulate-overnight/experiments/target-scaling")
D = pathlib.Path("/Users/Git/Articulate-overnight/data")
sys.argv = ["x", str(D / "vowels/h95-alldata.zip"), "/dev/null", "/dev/null"]
exec((here / "check_refinement.py").read_text().split("h95, pb = load_h95(), load_pb()")[0])
hand = {t["spk"] + t["intended"]: t for t in load_h95()}
frames = {}
for row in json.loads(gzip.decompress((D / "h95-all/tracker.frames.json.gz").read_bytes())):
    if row["noise"] == "clean" and row["accepted"]:
        frames.setdefault(row["id"], []).append((row["f1"], row["f2"]))
tracked = []
for key, h in hand.items():
    pts = frames.get(key, [])
    if len(pts) < 3: continue
    tracked.append(dict(h, hz=(median(p[0] for p in pts), median(p[1] for p in pts))))
# web/src/vowel/targets.ts on origin/main (centres Hz, half-widths natural log)
WEB = {"iy": (390, 2500, 0.3, 0.2), "uw": (420, 1050, 0.3, 0.25), "ah": (850, 1400, 0.25, 0.22)}
inside = lambda hz, t: (math.log(hz[0] / t[0]) / t[2]) ** 2 + (math.log(hz[1] / t[1]) / t[3]) ** 2 <= 1
print("group | hit iy/ah/uw | neighbour FA iy/ah/uw")
for g in ["men", "women", "boys", "girls"]:
    hits, fas = [], []
    for v in ["iy", "ah", "uw"]:
        own = [t for t in tracked if t["grp"] == g and t["heard"] == v]
        nb = [t for t in tracked if t["grp"] == g and t["heard"] in H95_NEIGHBOURS[v]]
        hits.append(100 * sum(inside(t["hz"], WEB[v]) for t in own) / len(own))
        fas.append(100 * sum(inside(t["hz"], WEB[v]) for t in nb) / len(nb))
    print(g, " / ".join(f"{x:.0f}" for x in hits), "|", " / ".join(f"{x:.0f}" for x in fas))
