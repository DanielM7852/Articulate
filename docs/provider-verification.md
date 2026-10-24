# Adapter verification

Versions are pinned in `uv.lock` and `package-lock.json`. Implemented signatures were checked against installed package source/types; this is not a live account verification.

| Adapter | Locked API surface used |
|---|---|
| Moss 1.21.0 / core 0.35.0 | `MossClient`, async `create_index`, `load_index`, `query`; `QueryOptions(top_k, filter)`; `DocumentInfo(id,text,metadata)`; async `close`. Metadata filter shape is documented in the installed query docstring. |
| Anthropic 0.125.0 | `AsyncAnthropic.messages.parse(model,max_tokens,messages,system,output_format=CoachingProposal)` and `parsed_output`. Proposals contain IDs/actions; canonical text/evidence are resolved and validated server-side. SDK automatic retries disabled; application deadline bounds the call. |
| Cartesia API | Direct WebSocket using `websockets` 15.0.1, configured API version header, PCM s16le output, unique contexts, timestamps, explicit zero buffering and final input. Model/voice availability and listening checks remain outstanding. |
| Parselmouth 0.4.7 | `Sound.to_formant_burg(time_step,max_number_of_formants,maximum_formant,window_length,pre_emphasis_from)` and `to_pitch_ac`; silence/clipping paths exercised. Physical speech evaluation remains outstanding. |
| SpacetimeDB 2.13.0 | TypeScript `schema/table/t`, private tables, init/reducer, typed primary-key access; reducers exercised with the official WASM datastore harness. Python uses documented confirmed HTTP reducer calls with a positional JSON argument array. Maincloud transport remains unverified. |

Primary references: [Moss SDK](https://github.com/usemoss/moss), [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Cartesia WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [Cartesia buffering](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering), [SpacetimeDB HTTP calls](https://spacetimedb.com/docs/http/database/), [Parselmouth API](https://parselmouth.readthedocs.io/en/stable/api_reference.html).

SpacetimeDB build/publish paths use `--module-path`, as specified in the [CLI reference](https://spacetimedb.com/docs/cli-reference/). The CLI build itself was not run locally; TypeScript and datastore-harness checks were run.
