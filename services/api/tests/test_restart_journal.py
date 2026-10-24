import json
from uuid import uuid4

from app.controller import restore
from app.features import summarize, synthetic_frame


def test_crash_between_journal_append_and_snapshot_does_not_rewind(runtime):
    runtime.state("ready")
    summary = summarize(uuid4(), "i", [synthetic_frame("i", n) for n in range(20)], 24000, 19200, "synthetic")
    # Emulates a committed durable event followed immediately by process failure, before save().
    runtime.emit("attempt.summary", summary.model_dump(mode="json"), durable=True)
    saved = runtime.outbox.recover(runtime.session.id)
    assert saved[1]["sync_revision"] == runtime.sync_revision
    restored = restore(
        runtime.settings,
        runtime.repository,
        runtime.reasoner,
        runtime.outbox,
        runtime.cache,
        runtime.session.id,
    )
    assert restored.history[0]["attempt_id"] == str(summary.attempt_id)
    rows = runtime.outbox.db.execute("SELECT body FROM events ORDER BY rowid").fetchall()
    revisions = [json.loads(row[0])["payload"]["expected_sync_revision"] for row in rows]
    assert revisions == list(range(len(revisions)))
