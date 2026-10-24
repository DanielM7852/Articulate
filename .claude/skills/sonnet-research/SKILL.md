---
name: sonnet-research
description: Delegate web scraping, documentation lookup, technical investigation, and repository research to a Sonnet worker, then synthesize its sourced summary in the main conversation.
---

Keep planning, reasoning, and the final synthesis in the main Opus conversation. When research is needed, invoke the `sonnet-researcher` agent using the Agent tool with `subagent_type: sonnet-researcher`. Its definition selects Sonnet with medium effort; do not override it with Opus or a different effort.

Give the worker a precise question, relevant task context, desired sources, version constraints, and a stopping condition. Include information it needs explicitly; do not assume it sees the whole parent conversation. Ask it to fetch/read sources and return its concise report with source URLs and uncertainties.

Independent research questions may run concurrently. Wait for required findings before making decisions that depend on them. Evaluate the report, resolve consequential gaps with a targeted follow-up, and use the findings in your plan or answer. Do not paste raw scraped pages into the parent context.

If this custom agent or web access is unavailable, state the limitation. Do not silently claim that Sonnet performed research that the main agent did itself.
