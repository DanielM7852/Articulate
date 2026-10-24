"""Generate deterministic engineering cases, not recordings or clinical assessments."""

import json
import sys
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/api"))
from app.evaluation import CoachingScenario, CoachingSuite, ExpectedCoaching
from app.schemas import TARGETS, AttemptSummary, CoachingContext, CoachingRequest, CueOutcome


def uid(name):
    return uuid5(NAMESPACE_URL, "articulate:synthetic-coaching:" + name)


def summary(name, distance, *, target="i", source="synthetic", assistance="guided", duration=800):
    t = TARGETS[target]
    return AttemptSummary(
        attempt_id=uid(name),
        target_id=target,
        capture_start_sample=0,
        capture_end_sample=19200,
        sample_rate=24000,
        usable_duration_ms=duration,
        usable_fraction=duration / 800,
        f1_mean=t.f1 + t.radius_f1 * distance if distance is not None else None,
        f2_mean=t.f2 if distance is not None else None,
        target_distance=distance,
        quality_flags=[] if distance is not None and duration >= 300 else ["insufficient_usable_speech"],
        evidence_fields=["usable_duration_ms", "usable_fraction"]
        + (["f1_mean", "f2_mean", "target_distance"] if distance is not None else []),
        source=source,
        assistance_level=assistance,
    )


def outcome(attempt, retry, cue="demo-i-1", result="no_improvement"):
    return CueOutcome(
        cue_id=cue,
        attempt_id=attempt.attempt_id,
        retry_attempt_id=retry.attempt_id,
        target_id=attempt.target_id,
        target_version=attempt.target_version,
        source=attempt.source,
        assistance_level=attempt.assistance_level,
        distance=attempt.target_distance,
        result=result,
    )


def build_suite():
    cases = []

    def add(name, current, action, observation, history=(), outcomes=(), forbidden=()):
        cases.append(
            CoachingScenario(
                id=name,
                request=CoachingRequest(
                    summary=current,
                    generation_id=uid(name + ":generation"),
                    context=CoachingContext(attempt_history=list(history), cue_history=list(outcomes)),
                ),
                expected=ExpectedCoaching(
                    action=action, observation_id=observation, forbidden_cue_ids=list(forbidden)
                ),
            )
        )

    add("capture_repair", summary("repair", None, duration=80), "repair_capture", "capture.insufficient")
    add("first_outside_region", summary("outside", 2.4), "repeat", "target.outside")
    a, b = summary("improve-a", 2.4), summary("improve-b", 1.7)
    add("moving_closer", b, "repeat", "trend.closer", [a])
    a, b, c = [summary(f"plateau-{i}", d) for i, d in enumerate([3, 3.02, 2.98])]
    add(
        "change_after_two_unsuccessful_retries",
        c,
        "change_cue",
        "trend.similar",
        [a, b],
        [outcome(a, b), outcome(b, c)],
        forbidden=["demo-i-1"],
    )
    a, b, c = [summary(f"region-{i}", d) for i, d in enumerate([0.7, 0.55, 0.4])]
    add(
        "reduce_after_three_guided_region_matches", c, "reduce_assistance", "progress.ready_to_reduce", [a, b]
    )
    a, b = summary("reduced-a", 0.3, assistance="reduced"), summary("reduced-b", 2, assistance="reduced")
    add("restore_guide", b, "simplify", "trend.farther", [a])
    add(
        "source_change_breaks_progress",
        summary("source-current", 0.3),
        "repeat",
        "target.inside",
        [
            summary("source-old-a", 0.3, source="microphone"),
            summary("source-old-b", 0.3, source="microphone"),
        ],
    )
    add(
        "target_change_breaks_progress",
        summary("target-current", 0.3),
        "repeat",
        "target.inside",
        [summary("target-old", 0.3, target="u")],
    )
    add(
        "capture_gap_breaks_progress",
        summary("gap-current", 0.3),
        "repeat",
        "target.inside",
        [summary("gap-old", 0.3), summary("gap-invalid", None, duration=0)],
    )
    missing = summary("missing", 0.3).model_copy(
        update={"evidence_fields": ["usable_duration_ms", "usable_fraction"]}
    )
    add("missing_distance_evidence", missing, "repair_capture", "capture.unavailable")
    attempts = [summary(f"exhausted-{i}", 3) for i in range(5)]
    outcomes = [
        outcome(attempts[i], attempts[i + 1], cue="demo-i-1" if i < 2 else "demo-i-2") for i in range(4)
    ]
    add(
        "pause_when_alternatives_exhausted",
        attempts[-1],
        "pause",
        "trend.similar",
        attempts[:-1],
        outcomes,
        forbidden=["demo-i-1", "demo-i-2"],
    )
    add(
        "short_capture_cannot_reduce_assistance",
        summary("short", 0.2, duration=299),
        "repair_capture",
        "capture.insufficient",
    )
    add("single_region_match_keeps_assistance", summary("single", 0.2), "repeat", "target.inside")
    add("aa_first_attempt", summary("aa", 2, target="aa"), "repeat", "target.outside")
    add("u_first_attempt", summary("u", 2, target="u"), "repeat", "target.outside")
    return CoachingSuite(scenarios=cases)


if __name__ == "__main__":
    path = ROOT / "fixtures/coaching/scenarios.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(build_suite().model_dump(mode="json"), indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Wrote {len(build_suite().scenarios)} synthetic coaching scenarios")
