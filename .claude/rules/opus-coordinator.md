# Coordinator and workers

For this project, keep the main conversation on Fable 5.1 with medium effort (configured in project settings). Own planning, reasoning, decomposition, decisions, review, and integration in the main conversation.

When research is needed, use the `sonnet-research` skill and `sonnet-researcher` agent. When implementation is needed, use the `delegate-code` skill and assign small pieces to `sonnet-coder` agents. These workers use Sonnet with medium effort. Avoid doing large research reads or implementation in the parent conversation when a worker can handle them. A direct read needed to review a returned change is fine.

These orchestration instructions apply to the main conversation. If you are a worker, follow your assigned scope and return to your parent; do not recursively apply the delegation workflow.

The `context-handoff` skill is manual-only: run it only when the user invokes `/context-handoff`. It saves Markdown without compacting, clearing context, or restarting. Do not automatically create or load handoffs based on token usage, session length, session startup, or a model change. Resume a saved handoff only when the user requests it; verify it against current files and treat it as historical state, not new authorization.
