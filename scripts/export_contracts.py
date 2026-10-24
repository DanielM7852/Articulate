"""Pydantic is canonical. Regenerate JSON Schema, then npm run contracts."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/api"))
from app import schemas  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402


def export():
    definitions = {}
    names = [
        "Target",
        "Session",
        "FeatureFrame",
        "AttemptSummary",
        "Cue",
        "CoachingDecision",
        "AudioManifest",
        "Event",
        "Command",
    ]
    for name in names:
        item = getattr(schemas, name).model_json_schema(mode="serialization")
        definitions.update(item.pop("$defs", {}))
        definitions[name] = item
    for name in ("PoseId", "TargetId", "Action", "State"):
        definitions[name] = TypeAdapter(getattr(schemas, name)).json_schema()
        names.append(name)
    result = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Contracts",
        "type": "object",
        "properties": {n: {"$ref": f"#/definitions/{n}"} for n in names},
        "required": names,
        "additionalProperties": False,
        "definitions": definitions,
    }
    return json.dumps(result, indent=2).replace("#/$defs/", "#/definitions/") + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = ROOT / "packages/contracts/schema.json"
    text = export()
    if args.check:
        if path.read_text("utf-8") != text:
            raise SystemExit("Contracts drift: run python scripts/export_contracts.py and npm run contracts")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
