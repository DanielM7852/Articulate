"""Offline coach quality checker: Claude grades stored coach captions against the scores they were written for.

Reads stored turns (local JSON store or SpacetimeDB), runs cheap deterministic checks in code, asks Claude to
grade each caption against a rubric in batches, and writes report.md and grades.json. It never replays attempts
through a coach and never outputs a raw profile id (learners are shown as 8 hex characters of a hash).
"""

import asyncio
import hashlib
import json
import logging
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from app.config import Settings
from app.integrations.spacetime import SpacetimeClient, timestamp_micros, unwrap
from app.live import llm
from app.live.history import _loads, compact_attempt
from app.live.notes import _SHAMING

_BACKEND_DIR = Path(__file__).resolve().parents[2]  # backend/, whatever the working directory

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "high"
DEFAULT_BATCH = 15
DEFAULT_LIMIT = 200
MAX_TOKENS = 16000
CALL_TIMEOUT_S = 120.0
CONCURRENCY = 3
CONTEXT_CAPTIONS = 3
RULES = ("matchesScore", "rightPart", "plainWords", "kind", "freshWording")
DETERMINISTIC = ("empty", "too_long", "too_many_sentences", "has_digits", "shaming")

_SENTENCE_END = re.compile(r"[.!?]+(?:\s+|$)")


# ----------------------------------------------------------------------------- turns


@dataclass
class Turn:
    attemptId: str
    learner: str  # first 8 hex of sha256(profile_id)
    order: float  # larger = newer (only comparable within one learner)
    kind: str  # word | vowel
    subject: str  # the word, or the vowel sound
    compact: dict[str, Any]
    caption: str
    source: str | None = None
    earlierCaptions: list[str] = field(default_factory=list)


def hash_learner(profile_id: str) -> str:
    return hashlib.sha256(profile_id.encode()).hexdigest()[:8]


def _make_turn(profile_id: str, order: float, summary: dict, decision: dict | None, fallback_id: str) -> Turn | None:
    compact = compact_attempt(summary, decision)
    caption = compact.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        return None
    kind = "word" if compact.get("kind") == "word" else "vowel"
    subject = compact.get("word") if kind == "word" else compact.get("sound")
    source = (decision or {}).get("source") or summary.get("source")
    return Turn(
        attemptId=str(compact.get("attemptId") or fallback_id),
        learner=hash_learner(profile_id),
        order=order,
        kind=kind,
        subject=str(subject or "").lower(),
        compact=compact,
        caption=caption.strip(),
        source=source if isinstance(source, str) else None,
    )


def attach_context(turns: list[Turn]) -> None:
    """Give each turn up to 3 earlier captions from the same learner for the same word / vowel, in order."""
    groups: dict[tuple[str, str, str], list[Turn]] = defaultdict(list)
    for turn in turns:
        groups[(turn.learner, turn.kind, turn.subject)].append(turn)
    for group in groups.values():
        group.sort(key=lambda t: t.order)
        for i, turn in enumerate(group):
            turn.earlierCaptions = [t.caption for t in group[max(0, i - CONTEXT_CAPTIONS):i]]


def _finish(turns: list[Turn], limit: int) -> list[Turn]:
    attach_context(turns)
    turns.sort(key=lambda t: (t.order, t.learner), reverse=True)
    return turns[:limit]


def load_turns_local(store_dir: str | Path, limit: int = DEFAULT_LIMIT) -> list[Turn]:
    turns: list[Turn] = []
    for path in sorted((Path(store_dir) / "learners").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        attempts = data.get("attempts") if isinstance(data, dict) else None
        for index, item in enumerate(attempts or []):
            if not isinstance(item, dict):
                continue
            summary = item.get("summary") if isinstance(item.get("summary"), dict) else {}
            decision = item.get("decision") if isinstance(item.get("decision"), dict) else {}
            profile_id = str(summary.get("profileId") or path.stem)
            turn = _make_turn(profile_id, float(index), summary, decision, f"{path.stem}-{index}")
            if turn:
                turns.append(turn)
    return _finish(turns, limit)


async def load_turns_spacetime(client: SpacetimeClient, limit: int = DEFAULT_LIMIT) -> list[Turn]:
    """Attempts come from learner_attempt (summary, started_at); captions and source from coach_turn.decision."""
    attempts = await client.sql("SELECT * FROM learner_attempt")
    try:
        decisions = {
            unwrap(r.get("attempt_id")): _loads(r.get("decision")) for r in await client.sql("SELECT * FROM coach_turn")
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("coach_turn read failed: %s", type(exc).__name__)
        decisions = {}
    turns: list[Turn] = []
    for row in attempts:
        summary = _loads(row.get("summary"))
        if not summary:
            continue
        attempt_id = unwrap(row.get("attempt_id"))
        summary.setdefault("attemptId", attempt_id)
        summary.setdefault("sound", unwrap(row.get("sound")))
        profile_id = str(unwrap(row.get("profile_id")) or summary.get("profileId") or "")
        turn = _make_turn(profile_id, float(timestamp_micros(row.get("started_at"))), summary,
                          decisions.get(attempt_id), str(attempt_id))
        if turn:
            turns.append(turn)
    return _finish(turns, limit)


# ----------------------------------------------------------------------------- deterministic checks


def deterministic_checks(caption: str) -> list[str]:
    text = (caption or "").strip()
    hits: list[str] = []
    if not text:
        return ["empty"]
    if len(text) > 160:
        hits.append("too_long")
    if len([s for s in _SENTENCE_END.split(text) if s.strip()]) > 3:
        hits.append("too_many_sentences")
    if re.search(r"\d", text):
        hits.append("has_digits")
    if _SHAMING.search(text):
        hits.append("shaming")
    return hits


# ----------------------------------------------------------------------------- Claude grading

Pass2 = Literal["pass", "fail"]
Pass3 = Literal["pass", "fail", "na"]


class Grade(BaseModel):
    turnId: str
    matchesScore: Pass2
    rightPart: Pass3
    plainWords: Pass2
    kind: Pass2
    freshWording: Pass3
    worstIssue: str = ""


class GradeBatch(BaseModel):
    grades: list[Grade]


GRADER_SYSTEM = """You grade the short captions a speech coach wrote for a deaf or hard-of-hearing learner after each practice attempt. Grade each caption against the score it was written for. You receive a JSON list of turns.

Each turn has: turnId, kind ("word" or "vowel"), the word or sound practised, the scores the coach had (verdict, quality, zones with their verdicts, focusZoneId, nextAction; vowel turns have audioVerdict, videoVerdict and offsets), the caption, and earlierCaptions (up to 3 captions the same learner got earlier for the same word or sound, oldest first).

Score semantics: a zone verdict is hit, partial, miss or skipped. quality says whether the attempt could be judged: "usable" can; anything unclear or insufficient cannot. Zones with advisory true are never judged and do not count toward the result. inScope false means the zone was outside the part being practised. focusZoneId is the part the coach chose to work on.

Rules, each judged independently:
- matchesScore: pass if the caption does not praise a miss or criticise a hit. When quality is unclear or insufficient (or the verdict is unclear), pass only if the caption asks for a clearer try rather than judging the attempt. Fail otherwise.
- rightPart: pass if the caption names or works on the focus part, or on a part that actually missed. Fail if it coaches a part that was hit, an advisory part as if scored, or nothing relevant. na if every scored part hit or the attempt was unclear.
- plainWords: pass if the caption uses short, everyday words. Fail on jargon such as phoneme symbols, formant, F1/F2, or technical terms.
- kind: pass if the caption is encouraging. Fail if it shames, scolds or sounds discouraging.
- freshWording: if earlierCaptions gave the same advice, pass only if this caption explains it another way (a new image or comparison, or a smaller step) rather than repeating it. Fail on repetition. na when earlierCaptions is empty, and always na when the try was unclear (quality is not usable, or verdict is insufficient): asking for another clear try may repeat.

Return one grade per turn with the same turnId. worstIssue is one short sentence naming the most serious problem, or an empty string when everything passes."""


def _batch_payload(batch: list[Turn]) -> str:
    items = []
    for t in batch:
        c = t.compact
        item: dict[str, Any] = {"turnId": t.attemptId, "kind": t.kind, "caption": t.caption,
                                "earlierCaptions": t.earlierCaptions}
        if t.kind == "word":
            for key in ("word", "verdict", "quality", "zones", "focusZoneId", "nextAction"):
                item[key] = c.get(key)
        else:
            for key in ("sound", "audioVerdict", "videoVerdict", "inTargetFraction", "f1Offset", "f2Offset", "nextAction"):
                item[key] = c.get(key)
        items.append(item)
    return json.dumps({"turns": items}, separators=(",", ":"))


def try_was_unclear(turn: Turn) -> bool:
    c = turn.compact
    return turn.kind == "word" and (c.get("quality") != "usable" or c.get("verdict") == "insufficient")


def enforce_grade(turn: Turn, grade: Grade | None) -> Grade | None:
    """freshWording does not apply when the try was unclear: a retry prompt may repeat."""
    if grade is not None and grade.freshWording != "na" and try_was_unclear(turn):
        return grade.model_copy(update={"freshWording": "na"})
    return grade


def make_batches(turns: list[Turn], size: int) -> list[list[Turn]]:
    size = max(1, size)
    return [turns[i:i + size] for i in range(0, len(turns), size)]


async def _grade_batch(
    client, settings: Settings, batch: list[Turn], model: str, effort: str, sem: asyncio.Semaphore, timeout_s: float,
) -> dict[str, Grade]:
    known = {t.attemptId for t in batch}
    async with sem:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    llm._parse, client, settings, GRADER_SYSTEM, _batch_payload(batch), GradeBatch, effort, MAX_TOKENS,
                    model, "on", "grade",  # telemetry.claude_call purpose
                ),
                timeout=timeout_s,
            )
        except Exception as exc:  # noqa: BLE001 - a failed batch leaves its turns ungraded
            logger.warning("grading batch failed: %s", type(exc).__name__)
            return {}
    return {g.turnId: g for g in result.grades if g.turnId in known}


async def grade_turns(
    turns: list[Turn], settings: Settings, client=None, model: str = DEFAULT_MODEL, effort: str = DEFAULT_EFFORT,
    batch_size: int = DEFAULT_BATCH, concurrency: int = CONCURRENCY, timeout_s: float = CALL_TIMEOUT_S,
) -> dict[str, Grade]:
    if not turns:
        return {}
    client = client or llm.build_client(settings, timeout_s)
    sem = asyncio.Semaphore(concurrency)
    parts = await asyncio.gather(
        *(_grade_batch(client, settings, b, model, effort, sem, timeout_s) for b in make_batches(turns, batch_size))
    )
    grades: dict[str, Grade] = {}
    for part in parts:
        grades.update(part)
    by_id = {t.attemptId: t for t in turns}
    return {k: enforce_grade(by_id[k], g) for k, g in grades.items() if k in by_id}


# ----------------------------------------------------------------------------- report


@dataclass
class Row:
    turn: Turn
    checks: list[str]
    grade: Grade | None

    @property
    def fails(self) -> list[str]:
        return [r for r in RULES if self.grade is not None and getattr(self.grade, r) == "fail"]


def build_rows(turns: list[Turn], grades: dict[str, Grade]) -> list[Row]:
    return [Row(t, deterministic_checks(t.caption), enforce_grade(t, grades.get(t.attemptId))) for t in turns]


def _rate(rows: list[Row], rule: str) -> str:
    graded = [getattr(r.grade, rule) for r in rows if r.grade is not None]
    passed, failed = graded.count("pass"), graded.count("fail")
    return f"{passed / (passed + failed):.0%} ({passed}/{passed + failed})" if passed + failed else "n/a"


def _rate_table(groups: list[tuple[str, list[Row]]]) -> list[str]:
    lines = ["| group | turns | " + " | ".join(RULES) + " |", "|---|---|" + "---|" * len(RULES)]
    for name, rows in groups:
        lines.append(f"| {name} | {len(rows)} | " + " | ".join(_rate(rows, r) for r in RULES) + " |")
    return lines


def _cell(text: Any) -> str:
    return str(text if text not in (None, "") else "-").replace("\n", " ")


def _missed_parts(compact: dict[str, Any]) -> str:
    zones = compact.get("zones") or []
    missed = [f"{z.get('phoneme') or z.get('id')}{'*' if z.get('advisory') else ''}"
              for z in zones if z.get("verdict") in ("miss", "partial")]
    return ", ".join(missed) or "none"


def _focus_label(compact: dict[str, Any]) -> str:
    focus = compact.get("focusZoneId")
    for z in compact.get("zones") or []:
        if z.get("id") == focus:
            return str(z.get("phoneme") or focus)
    return str(focus) if focus else "-"


def _verdict(turn: Turn) -> str:
    c = turn.compact
    return str(c.get("verdict") or c.get("audioVerdict") or "-")


def worst_rows(rows: list[Row], n: int = 10) -> list[Row]:
    scored = [r for r in rows if r.fails or r.checks]
    return sorted(scored, key=lambda r: (len(r.fails), len(r.checks)), reverse=True)[:n]


def render_report(rows: list[Row], info: dict[str, Any]) -> str:
    ungraded = sum(1 for r in rows if r.grade is None)
    out = ["# Coach quality report", "", "## Run", ""]
    out += [f"- source: {info.get('source')}", f"- turns: {len(rows)}", f"- model: {info.get('model')}",
            f"- effort: {info.get('effort')}", f"- ungraded: {ungraded}", f"- generated: {info.get('generated')}", ""]

    out += ["## Pass rates", "", "Pass rate excludes na and ungraded turns.", ""]
    out += _rate_table([("overall", rows)])
    out += ["", "### By kind", ""]
    out += _rate_table([(k, [r for r in rows if r.turn.kind == k]) for k in ("word", "vowel")])
    sources = sorted({r.turn.source for r in rows if r.turn.source})
    if sources:
        out += ["", "### By source", ""]
        out += _rate_table([(s, [r for r in rows if r.turn.source == s]) for s in sources])

    out += ["", "## Deterministic checks", "", "| check | captions |", "|---|---|"]
    for check in DETERMINISTIC:
        out.append(f"| {check} | {sum(1 for r in rows if check in r.checks)} |")

    out += ["", "## Worst 10", ""]
    worst = worst_rows(rows)
    if not worst:
        out.append("No failing captions.")
    for i, r in enumerate(worst, 1):
        t = r.turn
        out += [
            f"{i}. learner `{t.learner}` | {t.kind}: {_cell(t.subject)} | verdict: {_verdict(t)} | "
            f"focus part: {_focus_label(t.compact)} | missed parts: {_missed_parts(t.compact)}"
            + (f" | source: {t.source}" if t.source else ""),
            f"   - caption: {_cell(t.caption)}",
            f"   - failed rules: {', '.join(r.fails + r.checks) or 'none'}",
            f"   - worstIssue: {_cell(r.grade.worstIssue if r.grade else None)}",
        ]

    out += ["", "## Repeats", ""]
    repeats = [r for r in rows if r.grade is not None and r.grade.freshWording == "fail"]
    if not repeats:
        out.append("No repeated advice found.")
    else:
        counts: dict[str, int] = {}
        for r in repeats:
            counts[_cell(r.turn.source)] = counts.get(_cell(r.turn.source), 0) + 1
        out.append("Repeats by source: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
        out.append("")
    for r in repeats:
        t = r.turn
        out.append(f"- learner `{t.learner}` | {t.kind}: {_cell(t.subject)} | source: {_cell(t.source)}")
        out.append(f"  - caption: {_cell(t.caption)}")
        for earlier in t.earlierCaptions:
            out.append(f"  - earlier: {_cell(earlier)}")
    return "\n".join(out) + "\n"


def default_out_dir(now: datetime | None = None) -> Path:
    return _BACKEND_DIR / ".local_store" / "reports" / f"coach-quality-{(now or datetime.now()).strftime('%Y%m%d-%H%M')}"


def write_report(rows: list[Row], info: dict[str, Any], out_dir: str | Path) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "turnId": r.turn.attemptId, "learner": r.turn.learner, "kind": r.turn.kind, "subject": r.turn.subject,
            "source": r.turn.source, "caption": r.turn.caption, "earlierCaptions": r.turn.earlierCaptions,
            "checks": r.checks, "grade": r.grade.model_dump() if r.grade else None,
        }
        for r in rows
    ]
    (out / "grades.json").write_text(json.dumps({"info": info, "turns": records}, indent=2), encoding="utf-8")
    (out / "report.md").write_text(render_report(rows, info), encoding="utf-8")
    return out / "report.md"
