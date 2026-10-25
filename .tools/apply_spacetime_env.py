import json
from pathlib import Path

env = Path(r"C:\Users\dmath\Articulate\backend\.env")
text = env.read_text(encoding="utf-8") if env.exists() else ""
worker = json.loads(Path(r"C:\Users\dmath\Articulate\.tools\spacetime-worker.json").read_text(encoding="utf-8"))
keys = ("SPACETIMEDB_URL", "SPACETIMEDB_DATABASE", "SPACETIMEDB_TOKEN")
missing = [key for key in keys if f"{key}=" not in text]
print("missing", ",".join(missing) if missing else "none")
if not missing:
    print("already configured")
elif set(missing) != set(keys):
    print("partial keys present; left file unchanged")
else:
    block = (
        "\n# Local SpacetimeDB worker. Token stays in this file.\n"
        f"SPACETIMEDB_URL={worker['url']}\n"
        f"SPACETIMEDB_DATABASE={worker['database']}\n"
        f"SPACETIMEDB_TOKEN={worker['token']}\n"
    )
    env.write_text(text.rstrip() + block, encoding="utf-8")
    print("appended")
