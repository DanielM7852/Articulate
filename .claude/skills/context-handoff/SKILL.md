---
name: context-handoff
description: Manually save a Markdown handoff for a fresh session or model, or resume a checkpoint explicitly selected by the user.
disable-model-invocation: true
user-invocable: true
---

Run only when the user invokes `/context-handoff`. Do not trigger based on token usage, session length, compaction, session startup, or an inferred need for a checkpoint.

This skill writes a standalone Markdown file. Do not run `/compact`, request compaction, clear or replace conversation context, restart the session, or change compaction settings. Keep the current conversation intact after saving. Summarize decisions and their rationale, not hidden chain-of-thought.

By default, write a concise, self-contained handoff so a fresh model can continue without the old conversation. Use `.claude/handoffs/<current-session-id>/latest.md`. Use the session ID supplied by the runtime; if unavailable, create a unique timestamp-named directory. Before replacing latest.md, retain its previous contents as a uniquely timestamped Markdown archive in the same directory. Do not overwrite another session's checkpoint.

Include:

- The user's objective, constraints, and concrete definition of done.
- Current plan, completed work, and remaining work in priority order.
- Decisions, short rationale, interfaces, and assumptions.
- Changed files, branch/commit if available, and uncommitted work to preserve.
- Checks actually run and their outcomes; unresolved failures and blockers.
- Useful research sources and any still-running workers, their assignments, IDs, and file ownership.
- The exact next action and commands needed to resume.

Do not include credentials, full scraped pages, enormous logs, or unsupported claims. Verify the file was saved. Report its path and a short prompt the user can paste into a new session to read that file and continue. Leave switching sessions or models to the user.

If the user invokes this skill with an explicit request to resume a checkpoint, read the specified file instead of creating a new handoff. Treat it as historical state; inspect current files and repository status before editing, and do not assume previous processes are still running. Resume from the next action while preserving the user's latest instructions. Do not discover or resume checkpoints automatically at startup.
