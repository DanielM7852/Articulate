"""/ɛ/ radius for the "head" demo: check_tracker.py's tokens and fit(), with "eh" added to TARGETS. Usage: python3 -I eh_radius.py"""
import gzip, json, math, pathlib, sys
from statistics import median
here = pathlib.Path("/Users/Git/Articulate-overnight/experiments/target-scaling")
D = pathlib.Path("/Users/Git/Articulate-overnight/data")
sys.argv = ["x", str(D / "vowels/h95-alldata.zip"), "/dev/null", "/dev/null"]
src = (here / "check_refinement.py").read_text().split("h95, pb = load_h95(), load_pb()")[0]
src = src.replace('TARGETS = ["iy", "ah", "uw"]', 'TARGETS = ["iy", "ah", "uw", "eh"]')
exec(src)
hand = {t["spk"] + t["intended"]: t for t in load_h95()}
frames = {}
for row in json.loads(gzip.decompress((D / "h95-all/tracker.frames.json.gz").read_bytes())):
    if row["noise"] == "clean" and row["accepted"]:
        frames.setdefault(row["id"], []).append((row["f1"], row["f2"]))
tracked = []
for key, h in hand.items():
    pts = frames.get(key, [])
    if len(pts) < 3: continue
    f1, f2 = median(p[0] for p in pts), median(p[1] for p in pts)
    tracked.append(dict(h, hz=(f1, f2), f=(math.log(f1), math.log(f2))))
m = fit(tracked, False)
for v in TARGETS:
    print(v, [round(x, 5) for x in m["R"][v]], "radius", [round(K * s, 5) for s in m["sd"][v]])
