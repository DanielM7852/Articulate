"""Bounded session summaries. These omit contours, audio, and model prose."""

from app.schemas import AttemptSummary


def summarize_history(items: list[AttemptSummary]) -> str:
    parts = []
    for item in items[-3:]:
        parts.append(
            "|".join(
                [
                    item.attempt_id,
                    item.status,
                    item.finding or "",
                    item.cue_id or "",
                    item.next_action or "",
                ]
            )
        )
    return ";".join(parts)[:500]
