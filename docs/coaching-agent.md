# Coaching agent

The backend now assesses a finalized attempt, retrieves eligible cues, and asks Claude to select one supported insight and admissible next action. The Python controller validates the selection, resolves canonical text/evidence/pose, displays its caption and passes exactly that caption to Cartesia. Continuous acoustic features and visualization remain independent of this call.

## Run without other teammates' components

```powershell
uv run --no-sync python scripts/evaluate_coach.py
```

The default replay uses deterministic providers and the checked-in `fixtures/coaching/scenarios.json`. It writes `.data/coaching-evaluation.json`. Inspect each decision's observation, evidence references, rationale, policy snapshot, action, exact caption and selection source. A mock replay verifies policy behavior; it does not evaluate Claude's actual responses.

`scripts/make_coaching_fixtures.py` regenerates the 15 deterministic cases. Change the generator and regenerate when adding cases. The suite tests capture repair, first attempts, improvement, stalled retries, reduced assistance, restoring the guide, incompatible sources/targets, capture gaps, missing evidence, exhausted cues and all three vowels. No recordings or real learner performance are included.

`python scripts/evaluate_coach.py --live` explicitly opts into Moss/Claude requests. It requires configured keys/model, an approved corpus and its loaded Moss index. It never invokes TTS or writes session history. Provider failures are recorded separately from policy expectation matches and cause a failing exit status. Approved corpus IDs/history must match the fixtures; revise the scenario references if using different cue IDs. No live evaluation was run during implementation.

## Teammate boundary

The audio component supplies an `AttemptSummary` from `services/api/app/schemas.py`: current UUID, target/version, actual sample rate and capture interval, usable duration/fraction, acoustic metrics or null, quality flags, evidence field IDs, source and assistance level. The existing measurement adapter remains in place; the coaching change does not implement a second audio analysis pipeline.

For the current target registry, distance is the Euclidean distance of the **mean** F1/F2 position after dividing each axis difference by its region radius. A distance at or below 1 places that mean inside the configured ellipse. This is not a frame occupancy measure, stability estimate, pronunciation score or anatomical coordinate.

The controller owns previous attempts and accepted cue outcomes. It constructs `CoachingContext` from that history; the audio model must not fabricate history, actions or accepted coaching results. `CoachingRequest` is the version 1 fixture/integration envelope containing a current summary, generation UUID and context. It is an internal server contract, not an unauthenticated browser ingestion endpoint.

Call `Reasoner.decide(summary, generation_id, eligible_cues, context)`. Its real path performs one Anthropic structured-output call. Claude returns a `CoachingProposal` containing current IDs, supported `observation_id`, cue ID/version and action. The controller's validator reconstructs the expected `CoachingDecision` and rejects stale IDs, unsupported observations/actions, wrong cues/poses, unapproved content, altered numeric evidence, free narration and altered rationale.

UI and visualization components continue consuming the existing `coach.decision` event. Additive fields now include `observation_id`, `evidence` (attempt ID, field, numeric value), `rationale`, `selection_source`, `policy_version` and a policy snapshot. `caption` remains the exact accepted text displayed and spoken. `reduce_assistance` hides the optional target guide; `simplify` restores it. Neither action removes captions or communication access. The controller still owns transitions, cancellation and generation validity.

## Current engineering policy

| Condition | Preferred action |
|---|---|
| Missing distance evidence, incomplete upload, fewer than 300 usable ms, or usable fraction below 0.3 | Repair capture; no Claude call |
| First usable attempt | Repeat with an eligible cue |
| Distance changes by more than 0.1 normalized units | Offer the corresponding closer/farther observation |
| Same cue fails to reduce distance across two comparable retries outside the region | Exclude it and select an alternative cue |
| Three consecutive guided attempts have mean positions inside the region | Offer reduced assistance |
| Reduced-assistance attempt is outside the region | Offer restoring the target guide |
| No eligible alternatives remain | Pause with an unavailable-content caption; no Claude call |

Comparisons require a contiguous suffix of distinct attempts with the same target/version, source and assistance level. Invalid captures and context changes break the block. An inside-region mean is recorded as `region_match`, so a small distance increase within the region does not wrongly condemn a useful cue. Capture repairs never count as pronunciation failures. Cue history and decisions are recovered from the durable journal when a snapshot lags a crash.

Capture duration/fraction, distance-change threshold and block lengths are configurable via server-side `COACHING_POLICY` JSON. The region boundary stays at normalized distance 1 so its wording matches the displayed ellipse; change approved target geometry/version to change the region. These are engineering heuristics, not clinically validated thresholds. The policy version and exact configuration travel with accepted decisions. Claude can choose among the offered options; it cannot reduce assistance early, invent a new target or bypass the controller.

## Iteration points

- `app/prompts/coach_system.txt`: selection instructions for Claude.
- `app/coaching.py`: supported observations, comparison boundaries, action eligibility and evidence.
- `app/decisions.py`: proposal resolution, validation and caption composition.
- `content/cues/cues.json`: cue drafts and provenance. All bundled cues remain `demo_unreviewed`; real mode rejects them.
- `fixtures/coaching/scenarios.json`: reproducible input sessions and expected behavior.

Observation wording and action messages are constrained engineering demonstration text. They make no tongue/throat, lip-motion, emotional, stability, clinical-progress or learning claims. Add new observation types only alongside typed evidence, applicability rules, content review and regression cases. Keep observed measurements separate from estimates produced by an upstream reasoning model.
