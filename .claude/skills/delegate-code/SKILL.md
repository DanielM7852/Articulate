---
name: delegate-code
description: Break implementation work into small coding tasks for Sonnet medium workers while the main Opus agent owns the plan, interfaces, integration, and review.
---

First reason about the request in the main Opus conversation. Identify the minimum implementation and its dependencies, define interfaces, and split the work into small pieces with concrete acceptance criteria.

Invoke `sonnet-coder` through the Agent tool with `subagent_type: sonnet-coder` for each piece. Its definition selects Sonnet and medium effort. Include a task contract in each assignment using the compact template below. Fill it with concrete details; use "none" for inapplicable fields. Keep small tasks brief.

```text
Task: <unique task ID and revision>
Outcome: <observable behavior this piece must deliver>
Context: <relevant paths, conventions, and decisions; include working directory>
Owns: <exact files this worker may edit/create, including test files>
Read-only: <relevant shared files it may inspect but must not modify>
Out of scope: <nearby work explicitly excluded>
Interfaces: <exports/signatures, data shapes, error behavior, and consumers>
Dependencies: <required task IDs/artifacts and whether each is ready>
Acceptance: <observable pass/fail criteria, including relevant edge cases>
Checks: <commands and working directory, or an appropriate manual check>
Return: <status, changed paths, acceptance evidence, blockers, next action>
```

Define cross-worker interfaces before dispatching dependent work. Name exact symbols and required behavior where relevant; "add an API" is not a sufficient interface contract. Assign shared types, route registries, manifests, lockfiles, and shared test fixtures to a single owner whenever they need changes. Avoid broad directory ownership that overlaps another assignment.

Keep a compact coordinator task list with task IDs, current revisions, worker IDs, owned paths, dependencies, and status. Before dispatch, check for overlapping ownership and unresolved dependencies. A worker must receive the context it needs in its assignment; do not assume it sees the parent conversation.

Run independent pieces in parallel when their file ownership does not overlap and their prerequisites are ready. Sequence dependent pieces. Parallel work against an agreed interface is acceptable when it does not require an unfinished implementation, but mark integration as pending until the real dependency is available. Do not invent placeholder behavior to disguise a missing dependency.

Give each shared file to one worker at a time. If a task cannot sensibly be split, use one small worker assignment instead of manufacturing extra work. The coordinator should not edit files while a worker owns them. Before transferring ownership or replacing a worker, confirm the previous worker has stopped editing and inspect its partial changes.

If scope, ownership, dependencies, or an interface must change, the worker returns the affected contract item and proposed change. The coordinator decides, increments the contract revision, and informs affected workers before they proceed on the changed agreement. Routine implementation choices within the contract need no extra approval from the user.

Require a completion report that names the task ID/revision and states `complete`, `partial`, or `blocked`. It must list changed files, map acceptance criteria to evidence, and give commands actually run with their results. Unrun checks must be identified with the reason. A blocker report includes partial changes to preserve and the smallest decision or dependency needed to continue. Passing a local check alone does not establish that the combined feature works.

Review returned diffs against ownership and the agreed interfaces, reconcile integration, and delegate needed corrections. Verify the acceptance evidence before marking a task accepted. The main agent owns checks of the combined result, including relevant tests/builds. Report actual results and unresolved risks; do not mark the overall request complete while required integration or acceptance checks remain unresolved. If a worker finds an architectural issue, decide it in the main conversation and issue a revised bounded assignment.

If the agent tool or custom worker is unavailable, explain the limitation before choosing a fallback. Delegation does not grant permission to commit, publish, or perform external actions beyond the user's task.
