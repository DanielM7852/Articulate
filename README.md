# DO NOT TOUCH — shared context only

Shared Claude configuration, research, specifications, and planning notes for the team,
stored on the `do-not-touch` branch of `DanielM7852/Articulate`.

This is an orphan branch with no application code or shared commit history with
the application branches. Keep it separate; do not merge it into `main` or a
feature branch. The branch name is a convention, not an enforced permission rule.

Only root Markdown files and `.claude/` are tracked here. Application folders,
Claude session handoffs, and machine-specific settings are ignored.

## Browse or download

Open <https://github.com/DanielM7852/Articulate/tree/do-not-touch>.
Teammates use their existing access to the Articulate repository.

For a standalone local copy:

```powershell
git clone --single-branch --branch do-not-touch git@github.com:DanielM7852/Articulate.git Articulate-context
```

To keep an existing code checkout on its current branch, run these commands from
that checkout to open the shared files in a separate folder:

```powershell
git fetch origin do-not-touch
git worktree add --track -b do-not-touch ../Articulate-context origin/do-not-touch
```

If you already have a local `do-not-touch` branch, use
`git worktree add ../Articulate-context do-not-touch` instead.

The original shared workspace can retain this layout:

```text
calhacks/
  .claude/
  README.md
  ...research and planning Markdown files...
  Articulate-main/     # application checkout, ignored on this branch
```

## Share updates

Run these commands from the shared-context checkout on `do-not-touch`:

```powershell
git pull --rebase
git add -- .claude '*.md'
git diff --cached
git commit -m "Update shared context"
git push
```

Review staged changes before committing. Commit changes in application code
separately from inside the appropriate application repository.
