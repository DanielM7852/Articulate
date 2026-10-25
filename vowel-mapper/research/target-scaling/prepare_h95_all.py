"""Prepare every Hillenbrand recording for scripts/eval/run.ts (Amendment 2).

Usage: python3 -I prepare_h95_all.py <h95-alldata.zip> <out-data-dir> <existing-noise-wav>
Mirrors prepare.py's conversion; writes WAVs and manifest.json outside Git.
"""

import hashlib, io, json, os, pathlib, re, subprocess, sys, zipfile

archive_path, root, noise = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
archive = zipfile.ZipFile(archive_path)
assert hashlib.sha256(pathlib.Path(archive_path).read_bytes()).hexdigest() == "2560548591e3a726c88549b6dc9d226995616c26874d601c69fee8b9eee9d730"
rows = lambda name: {c[0]: list(map(float, c[1:])) for line in archive.read(name).decode().splitlines()
                     if re.match(r"^[bmwg]\d\d[a-z]{2}\s", line) for c in [line.split()]}
times, acoustic = rows("timedata.dat"), rows("bigdata.dat")
groups = {"b": "boys", "m": "men", "w": "women", "g": "girls"}
clips = []
for nested in ["men.zip", "women.zip", "kids.zip"]:
    sounds = zipfile.ZipFile(io.BytesIO(archive.read(nested)))
    for name in sorted(sounds.namelist()):
        key = pathlib.Path(name).stem.lower()
        if not re.match(r"^[bmwg]\d\d[a-z]{2}$", key) or key not in times or key not in acoustic:
            continue
        target = root / (key + ".wav")
        if not target.exists():
            original = root / (key + "-16k.wav")
            original.write_bytes(sounds.read(name))
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(original), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(target)], check=True)
            original.unlink()
        start, end = times[key][0], times[key][1]
        data = acoustic[key]
        refs = [{"timeMs": start + (end - start) * p / 10, "f1": data[5 + (p - 1) * 3], "f2": data[6 + (p - 1) * 3], "f3": data[7 + (p - 1) * 3]} for p in range(1, 9)]
        clips.append({"id": key, "corpus": "hillenbrand", "speaker": key[:3], "group": groups[key[0]], "split": "all", "path": target.name,
                      "phones": [{"start": start / 1000, "end": end / 1000, "phoneme": key[3:], "group": "vowel"}], "references": refs,
                      "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
noise_rel = os.path.relpath(noise, root)
manifest = {"version": 1, "sampleRate": 48000, "noise": noise_rel, "noiseSha256": hashlib.sha256(noise.read_bytes()).hexdigest(), "clips": clips}
(root / "manifest.json").write_text(json.dumps(manifest))
print(f"{len(clips)} clips, {len({c['speaker'] for c in clips})} speakers -> {root}")
