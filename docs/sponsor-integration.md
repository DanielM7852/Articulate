# Sponsor integration notes

Checked against public docs on 2026-10-23. This file records what the backend actually does. It does not claim prize eligibility.

Cal Hacks 13.0 Devpost, fetched the same day, lists a submission deadline of October 25, 2026 at 9:00am PDT, a public GitHub repository, an image, work done during the event, and a live or recorded demo. The Hive prizes page did not return sponsor-track rules in that fetch. Track eligibility still needs to be confirmed from the current prize brief before anyone claims it.

## Implemented

### Anthropic

`ClaudeCoach` calls `client.messages.parse` with `output_format` set to the `CoachOutput` Pydantic model. Anthropic SDK 2.3.0 turns that into `output_config.format` JSON schema. The server then checks that the finding, evidence ids, cue id, instruction text, and next action belong to the measurement and the filtered cue list. Observations that contain digits or articulator language are rejected.

If the key is missing, the call times out, or validation fails, the service returns the measurements and one deterministic cue from the filtered library. The result says `reasoning.source = deterministic_fallback` and gives the reason. Unit tests cover that path with a fake client. They do not call the live API, so this environment has not demonstrated a live Claude response.

Default model string: `claude-sonnet-4-6`, from the structured-output model list in the current docs. Override `ANTHROPIC_MODEL` if needed.

### Moss

`CueRetriever` calls `MossClient.load_index` and `MossClient.query` with a metadata filter on language and exercise, then keeps only curated cues that match the finding and have not already been used. Seed rows are drafts. The sync script `backend/scripts/sync_moss_cues.py` prints the upsert plan and does not call Moss unless `--commit` is passed. It does not delete an index.

Tests use a fake client for the success path and the disclosed failure path. The `moss` package is an optional install (`pip install -e ".[moss]"`) and was not imported in the unit tests. A run without credentials sets `retrieval.backend = local_fallback` and `disclosed_fallback = true`. That local filter is not a Moss integration.

### Cartesia

The voice teammate owns the agent. This backend returns `feedback`, and `app.integrations.cartesia.build_tts_request` shows the bytes-endpoint body for the coaching line. That coaching request is not sent.

When `CARTESIA_API_KEY` is set, loading a reference calls `POST https://api.cartesia.ai/tts/bytes` once for that transcript, voice, and model, then caches the WAV under the local store. The practice screen uses the same call through `POST /v1/speech`. The default voice, if `CARTESIA_VOICE_ID` is blank, is the documented Skylar id. A blank key keeps the harmonic reference and the browser speech voice. Learner fixture audio stays synthetic. The call uses Cartesia version `2026-08-14` and model `sonic-3.6`, with `language` set and `locale` omitted.

The practice screen posts its attempt summary to `POST /v1/coach`. With `ANTHROPIC_API_KEY` set, Claude may rephrase the observation from those measured fields. The action, cue, and evidence are chosen on the server. A rejected or missing model response keeps the screen's own wording.

## Not implemented

- Convex: the storage interface can be replaced later. The current implementation is local JSON. SpacetimeDB is an additional subscription store, documented in `docs/live-metrics.md`. It does not replace the local session file.
- Runpod, Azure Speech, Annapurna/Graviton, Elastic, and Bitdeer/Vultr: deferred. Elastic was not added beside Moss.

## Cue library

`backend/data/cues/seed_cues.json` is the curated library. Every row has `cue_id`, exercise, finding, language, difficulty, instruction text, source, and `review_status: draft`. The file's review notice states that retrieval does not establish clinical correctness. Draft status is copied onto the handoff as `cue_review_status` and as the limitation `selected_cue_is_unreviewed_draft`.
