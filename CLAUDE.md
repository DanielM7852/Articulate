# Claude Code Instructions

Follow the repository-wide agent instructions in `AGENTS.md`.

Most importantly:

- `main` is the only long-lived branch on `origin`; the old workstream
  branches were merged into it and deleted. Do not push to or revive them.
- Work on a feature branch cut from the latest `origin/main`
  (`git fetch origin --prune && git switch -c feature/<topic> origin/main`),
  never directly on `main`.
- Push only your own branch (`git push -u origin <branch>`) and open a pull
  request into `main`.
- Before committing or merging, check whether the branch would conflict with
  the latest `main`.
- Never push directly to `main`.
- Never merge into `main` unless the user explicitly asks for it.

