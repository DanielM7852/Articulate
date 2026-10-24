# Repository Agent Instructions

These instructions apply to all AI coding agents working in this repository,
including Codex, Claude Code, Gemini, and similar tools.

## Branches On `origin`

- `main` is the only long-lived branch. On 2026-10-24 every earlier workstream
  branch (`backbone`, `cv`, `voice-analysis`, `mouth-demo`, `Karsten-2d-f1-f2`,
  `feature/figma-ui`, `feature/integrate-branches`,
  `feature/onboarding-redesign`, `feature/live-coaching`) was merged into
  `main` and deleted from `origin`. Their code now lives in `main`; the
  directory table in `README.md` says where.
- Do not recreate, push to, or merge from those old branch names. In an older
  checkout, `git branch -vv` shows them as `[origin/<name>: gone]`. Move any
  unpushed commits from such a branch onto a new branch cut from `origin/main`
  (`git cherry-pick` or `git rebase --onto origin/main`) instead of pushing it.

## Where To Push

- Start every change from the latest `origin/main`:

  ```sh
  git fetch origin --prune
  git switch -c <prefix>/<short-topic> origin/main
  ```

  Use `feature/`, `fix/`, or `docs/` as the prefix, for example
  `feature/echo-tap`. Keep one feature or fix per branch.
- Push only your own branch, to `origin`: `git push -u origin <branch>`.
- Get the change into `main` by opening a pull request into `main` on GitHub.
  The user reviews and merges it.
- After the pull request merges, delete the branch on `origin`
  (`git push origin --delete <branch>`) and locally, then start the next
  change from `origin/main` again.

## Branch Safety Rules

- Always work on a feature branch. Do not make code changes directly on `main`.
- Before starting work, check the current branch with `git branch --show-current`.
- If currently on `main`, create and switch to a new branch from the latest
  `origin/main` before editing (see "Where To Push").
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

