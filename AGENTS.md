# Repository Agent Instructions

These instructions apply to all AI coding agents working in this repository,
including Codex, Claude Code, Gemini, and similar tools.

## Branch Safety Rules

- Always work on a feature branch. Do not make code changes directly on `main`.
- Before starting work, check the current branch with `git branch --show-current`.
- If currently on `main`, create and switch to a new branch before editing:
  `git switch -c <descriptive-branch-name>`.
- Never push directly to `main`.
- Never force-push `main`.
- Never merge into `main` locally unless the user explicitly asks for it.

## Before Committing

- Check the current branch again and confirm it is not `main`.
- Run `git status` and review the files that will be committed.
- Run the relevant tests, build, lints, or checks for the files changed.
- If checks cannot be run, state that clearly in the final response.

## Before Merging Or Opening A PR

- Fetch the latest remote state:
  `git fetch origin`.
- Check whether the branch is behind or conflicts with `main` before merging:
  `git merge-base --is-ancestor origin/main HEAD`
  and/or
  `git merge --no-commit --no-ff origin/main`.
- If the test merge reports conflicts, abort it with `git merge --abort`,
  report the conflicting files, and do not continue until conflicts are resolved.
- Do not merge into `main` or push to `main`; ask the user to review and merge
  through the approved workflow.

## If Git Refuses To Run

If Git reports that the repository has dubious ownership, do not bypass branch
safety rules. Ask the user before running a command like:

```powershell
git config --global --add safe.directory C:/Users/rubix/Articulate
```

